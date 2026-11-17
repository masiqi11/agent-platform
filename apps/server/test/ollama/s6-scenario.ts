/**
 * Main scenario steps 4–8 (§22.2) driven by a REAL model on the local demo repo (manual; NOT CI):
 * task → dev agent reproduces + fixes the timeout bug → push → MR → CI → reviewer → (rework) →
 * tester → merge queue → done. Every agent uses the tenant's default model (the bootstrap one).
 *
 *   TEST_DATABASE_URL=… LLM_BASE_URL=https://…/v1 LLM_MODEL=… LLM_API_KEY=… RESULT=s6-<name> \
 *     bun test/ollama/s6-scenario.ts
 *
 * Writes docs/results/$RESULT.json: task transitions, per-purpose model calls, failures, and
 * whether each agent's work came from the model or a deterministic fallback.
 */
import { writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { PAYMENTS_REPO } from "../../src/cli/demo-repos";
import { job, llmCall, mergeQueueItem, review, task, testRun } from "../../src/db/schema";
import { git } from "../../src/modules/scm/service";

const BASE = process.env.LLM_BASE_URL;
const MODEL = process.env.LLM_MODEL;
if (!BASE || !MODEL) throw new Error("LLM_BASE_URL and LLM_MODEL are required");
const RESULT = process.env.RESULT ?? "s6-real-model";
const t0 = Date.now();
const steps: Array<{ step: string; ok: boolean; ms: number; note?: string }> = [];
const mark = (step: string, ok: boolean, note?: string) => {
  steps.push({ step, ok, ms: Date.now() - t0, ...(note ? { note } : {}) });
  console.log(`${ok ? "✓" : "✗"} ${(((Date.now() - t0) / 1000) | 0).toString().padStart(4)}s  ${step}${note ? ` — ${note}` : ""}`);
};

const dataDir = mkdtempSync(join(tmpdir(), "ap-s6real-"));
const { createTestApp } = await import("../helpers");
const t = await createTestApp("s6real", {
  DATA_DIR: dataDir,
  SANDBOX: "process",
  LLM_BASE_URL: BASE,
  LLM_MODEL: MODEL,
  ...(process.env.LLM_API_KEY ? { LLM_API_KEY: process.env.LLM_API_KEY } : {}),
  LLM_TIMEOUT_MS: "240000",
  LLM_FIRST_BYTE_MS: "200000",
});
let taskId = "";
try {
  const setup = await t.req("POST", "/api/v1/setup", { body: { tenantName: "Real", email: "o@r.test", name: "王负责人", password: "Correct-Horse-42" } });
  const owner = setup.body.token as string;
  const ctx = await t.s.identity.authenticate(new Headers({ authorization: `Bearer ${owner}` }), "trc_s6real");
  const p = await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "PAY", name: "支付服务", description: "支付网关调用、下单与回调" } });
  const projectId = p.body.id as string;
  // No human approval step in this run: the gate + merge queue decide once review and tests pass.
  await t.s.db.root.execute(sql`update project set settings = settings || ${JSON.stringify({ mergePolicy: "auto" })}::jsonb where id = ${projectId}`);
  const dev = (await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name: "开发 · 小码", role: "dev" } })).body;
  await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name: "评审 · 审审", role: "reviewer" } });
  await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name: "测试 · 测测", role: "tester" } });
  const bound = await t.s.repos.bind(ctx, projectId, { provider: "local", name: "payments", files: PAYMENTS_REPO, testCommand: "bun test" });
  mark("bind demo repo (bun test fails on main: the timeout bug)", bound.check.ok);
  const tk = await t.req("POST", "/api/v1/tasks", {
    token: owner,
    body: {
      projectId,
      title: "支付服务下单偶发超时",
      description: "用户反馈下单接口偶尔要等很久才失败。请排查原因并修复。",
      acceptanceCriteria: ["调用网关的超时小于上游网关超时", "仓库测试全部通过"],
      assigneeAgentId: dev.id,
    },
  });
  taskId = tk.body.id;
  await t.req("POST", `/api/v1/tasks/${taskId}/transition`, { token: owner, body: { to: "ready" } });
  const { registerHandlers } = await import("../../src/modules/registry");
  await registerHandlers(t.s);
  await t.s.consumers.init();
  await t.s.db.root.execute(sql`delete from job where cron is not null`);

  const deadline = Date.now() + 40 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    await t.s.consumers.drain();
    await t.s.jobs.drain();
    const [row] = await t.s.db.root.select().from(task).where(eq(task.id, taskId));
    if (row!.status !== last) {
      last = row!.status;
      mark(`task → ${last}`, !["blocked", "cancelled"].includes(last), row!.blockedReason ?? undefined);
    }
    if (["done", "blocked", "cancelled"].includes(last)) break;
    await Bun.sleep(2_000);
  }
  const [mq] = await t.s.db.root.select().from(mergeQueueItem).where(eq(mergeQueueItem.taskId, taskId));
  mark("merged by the queue", mq?.status === "merged", mq ? `${mq.status} ${mq.lastError ?? ""}` : "no queue item");
  if (mq?.status === "merged") {
    // What actually landed on main.
    const tmp = mkdtempSync(join(tmpdir(), "ap-s6real-main-"));
    await git(["clone", "-q", bound.repo.url, tmp], { cwd: "/" });
    const diff = (await git(["log", "-p", "-1", "--format=%s", "--", "src/gateway.ts"], { cwd: tmp })).out;
    const line = diff.split("\n").find((l) => l.startsWith("+export const GATEWAY_CALL_TIMEOUT_MS")) ?? "(gateway.ts unchanged)";
    mark("fix on main", /GATEWAY_CALL_TIMEOUT_MS = [1-4][_0-9]{3}\b|[1-4]_?\d{3}/.test(line), line.trim());
    rmSync(tmp, { recursive: true, force: true });
  }
  const reviews = await t.s.db.root.select().from(review).where(eq(review.taskId, taskId));
  const tests = await t.s.db.root.select().from(testRun).where(eq(testRun.taskId, taskId));
  mark("reviews", reviews.length > 0, reviews.map((r) => `${r.verdict}(${(r.comments as unknown[] | null)?.length ?? 0} 条)`).join(" → "));
  mark("test runs", tests.length > 0, tests.map((r) => r.status).join(" → "));
  const dead = await t.s.db.root.select().from(job).where(eq(job.status, "dead"));
  mark("no dead jobs", dead.length === 0, dead.map((j) => `${j.type}: ${String(j.lastError).slice(0, 160)}`).join(" | "));
} finally {
  const calls = await t.s.db.root.select().from(llmCall);
  const byPurpose: Record<string, { n: number; ok: number; avgMs: number; tokensOut: number }> = {};
  for (const c of calls) {
    const b = (byPurpose[c.purpose] ??= { n: 0, ok: 0, avgMs: 0, tokensOut: 0 });
    b.n++;
    if (c.status === "ok") b.ok++;
    b.avgMs += c.latencyMs;
    b.tokensOut += c.tokensOut;
  }
  for (const b of Object.values(byPurpose)) b.avgMs = Math.round(b.avgMs / b.n);
  const out = {
    at: new Date().toISOString(),
    model: MODEL,
    endpoint: new URL(BASE).host,
    minutes: Number(((Date.now() - t0) / 60000).toFixed(1)),
    steps,
    calls: { total: calls.length, ok: calls.filter((c) => c.status === "ok").length, models: [...new Set(calls.map((c) => c.model))], byPurpose },
    failures: calls.filter((c) => c.status !== "ok").map((c) => ({ purpose: c.purpose, error: (c.error ?? "").slice(0, 300) })),
  };
  writeFileSync(resolve(import.meta.dir, `../../../../docs/results/${RESULT}.json`), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out.calls, null, 2));
  if (out.failures.length) console.log("failures:", JSON.stringify(out.failures.slice(0, 8), null, 2));
  await t.close();
  rmSync(dataDir, { recursive: true, force: true });
}
