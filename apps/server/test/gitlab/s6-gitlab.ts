/**
 * S6 on a real GitLab CE + Runner (manual; NOT part of CI). Runs main scenario steps 4–8 against a
 * dedicated test project: task → dev agent → MR → GitLab CI → review → test → merge via the queue.
 *
 *   TEST_DATABASE_URL=… GITLAB_URL=https://gitlab.example.com/group/payments-e2e GITLAB_TOKEN=glpat-… \
 *     bun test/gitlab/s6-gitlab.ts            # run the scenario
 *   bun test/gitlab/s6-gitlab.ts --print-seed DIR   # write the demo repo (+ .gitlab-ci.yml) to DIR to push once
 *
 * Prerequisites: the project's default branch holds the demo payments code (use --print-seed), a
 * Runner is attached, the default branch is protected, and the token is a Developer project token
 * (scope api). Webhooks are not needed: the platform falls back to polling (no public URL in CI).
 * Results go to docs/results/s6-gitlab.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { PAYMENTS_REPO } from "../../src/cli/demo-repos";
import { job, mergeQueueItem, task } from "../../src/db/schema";

const GITLAB_CI = `image: oven/bun:1.4.4-alpine\ntest:\n  script:\n    - bun test\n`;

if (process.argv[2] === "--print-seed") {
  const dir = resolve(process.argv[3] ?? "payments-seed");
  for (const [p, body] of Object.entries({ ...PAYMENTS_REPO, ".gitlab-ci.yml": GITLAB_CI })) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  console.log(`demo repo written to ${dir}; commit and push it to the test project's default branch once.`);
  process.exit(0);
}

const url = process.env.GITLAB_URL;
const token = process.env.GITLAB_TOKEN;
if (!url || !token) throw new Error("GITLAB_URL and GITLAB_TOKEN are required");
const t0 = Date.now();
const steps: Array<{ step: string; ok: boolean; ms: number; note?: string }> = [];
const mark = (step: string, ok: boolean, note?: string) => {
  steps.push({ step, ok, ms: Date.now() - t0, ...(note ? { note } : {}) });
  console.log(`${ok ? "✓" : "✗"} ${step}${note ? ` — ${note}` : ""}`);
};

const { createTestApp } = await import("../helpers");
const t = await createTestApp("gitlab", { SANDBOX: process.env.SANDBOX ?? "process" });
try {
  const setup = await t.req("POST", "/api/v1/setup", { body: { tenantName: "GL", email: "o@gl.test", name: "王负责人", password: "Correct-Horse-42" } });
  const owner = setup.body.token as string;
  const p = await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "GLE", name: "GitLab 实测" } });
  const projectId = p.body.id as string;
  await t.s.db.root.execute(sql`update project set settings = settings || ${JSON.stringify({ mergePolicy: "auto" })}::jsonb where id = ${projectId}`);
  const dev = (await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name: "开发 A", role: "dev" } })).body;
  await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name: "评审 R", role: "reviewer" } });
  await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name: "测试 T", role: "tester" } });
  const bound = await t.req("POST", `/api/v1/projects/${projectId}/repos`, { token: owner, body: { provider: "gitlab", name: "payments", url, token, caCert: process.env.GITLAB_CA || undefined } });
  mark("bind + access check", bound.status === 200 && bound.body.check.ok, JSON.stringify(bound.body.check?.warnings ?? bound.body));
  const tk = await t.req("POST", "/api/v1/tasks", {
    token: owner,
    body: {
      projectId,
      title: "修复下单超时（GitLab 实测）",
      description: "网关调用超时大于上游网关超时",
      acceptanceCriteria: ["调用网关的超时小于上游网关超时", "仓库测试全部通过"],
      assigneeAgentId: dev.id,
    },
  });
  await t.req("POST", `/api/v1/tasks/${tk.body.id}/transition`, { token: owner, body: { to: "ready" } });
  const { registerHandlers } = await import("../../src/modules/registry");
  await registerHandlers(t.s);
  await t.s.consumers.init();
  // Drive consumers and jobs (incl. ci.poll retries) until done or 30 minutes.
  const deadline = Date.now() + 30 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    await t.s.consumers.drain();
    await t.s.db.root.execute(sql`update job set run_at = now() where status = 'queued' and type in ('ci.poll','merge.process') and run_at > now() + interval '5 seconds'`);
    await t.s.jobs.drain();
    const [row] = await t.s.db.root.select().from(task).where(eq(task.id, tk.body.id));
    if (row!.status !== last) {
      last = row!.status;
      mark(`task → ${last}`, !["blocked", "cancelled"].includes(last));
    }
    if (["done", "blocked", "cancelled"].includes(last)) break;
    await Bun.sleep(5_000);
  }
  const [mq] = await t.s.db.root.select().from(mergeQueueItem).where(eq(mergeQueueItem.taskId, tk.body.id));
  mark("merged by the queue", mq?.status === "merged", mq ? `${mq.status} ${mq.lastError ?? ""}` : "no queue item");
  const dead = await t.s.db.root.select().from(job).where(eq(job.status, "dead"));
  mark("no dead jobs", dead.length === 0, dead.map((j) => `${j.type}: ${String(j.lastError).slice(0, 120)}`).join(" | "));
} finally {
  const out = resolve(import.meta.dir, "../../../../docs/results/s6-gitlab.json");
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), gitlab: new URL(url).host, steps }, null, 2));
  await t.close();
}
