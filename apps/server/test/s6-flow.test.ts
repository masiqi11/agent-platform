import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { BILLING_REPO } from "../src/cli/demo-repos";
import type { Ctx } from "../src/core/context";
import { agent, approval, event, job, mergeQueueItem, review, session, task, workspace } from "../src/db/schema";
import { git } from "../src/modules/scm/service";
import { createTestApp, type TestApp } from "./helpers";

process.env.LLM_BACKOFF_MS = "2";
let t: TestApp;
const PW = "Correct-Horse-42";
const dataDir = mkdtempSync(join(tmpdir(), "ap-s6f-"));
let owner = "";
let ownerCtx: Ctx;
let maint = "";
let maintCtx: Ctx;
let projectId = "";
let repoUrl = "";
const ag: Record<string, { id: string; principalId: string }> = {};

async function settle(max = 40) {
  for (let i = 0; i < max; i++) {
    const a = await t.s.consumers.drain();
    const b = await t.s.jobs.drain();
    if (!a && !b) return;
  }
}
const ctxOf = (token: string) => t.s.identity.authenticate(new Headers({ authorization: `Bearer ${token}` }), "trc_s6f");
const setPolicy = (mergePolicy: "auto" | "require_approval") => t.s.db.root.execute(sql`update project set settings = settings || ${JSON.stringify({ mergePolicy })}::jsonb where id = ${projectId}`);
const load = async (id: string) => (await t.s.db.root.select().from(task).where(eq(task.id, id)))[0]!;
const item = async (id: string) => (await t.s.db.root.select().from(mergeQueueItem).where(eq(mergeQueueItem.taskId, id)))[0];

/**
 * A task whose change is written by the test (not the scripted dev), then handed to the normal
 * machinery: push + MR → CI → dev requests review → reviewer → tester → gate → queue.
 * Files under test/ make the scripted reviewer approve on the first round.
 */
async function manualTask(title: string, files: Record<string, string>) {
  const r = await t.req("POST", "/api/v1/tasks", { token: owner, body: { projectId, title, acceptanceCriteria: ["改动生效", "仓库测试全部通过"], assigneeAgentId: ag.dev!.id } });
  expect(r.status).toBe(200);
  await t.req("POST", `/api/v1/tasks/${r.body.id}/transition`, { token: owner, body: { to: "ready" } });
  const [repo] = await t.s.repos.projectRepos(projectId);
  const ws = await t.s.workspaces.ensure(ownerCtx, await load(r.body.id), repo!);
  for (const [p, body] of Object.entries(files)) await Bun.write(join(ws.worktreePath!, p), body);
  // The owner starts it (ready → in_progress needs only the workspace), so the dev agent is never woken for "ready".
  await t.req("POST", `/api/v1/tasks/${r.body.id}/transition`, { token: owner, body: { to: "in_progress" } });
  const devRow = (await t.s.db.root.select().from(agent).where(eq(agent.id, ag.dev!.id)))[0]!;
  await t.s.workspaces.commit(ownerCtx, await t.s.workspaces.load(ws.id), devRow, await load(r.body.id), title);
  await t.s.workspaces.push(ownerCtx, await t.s.workspaces.load(ws.id), await load(r.body.id));
  await t.s.workspaces.openMr(ownerCtx, await t.s.workspaces.load(ws.id), await load(r.body.id));
  return r.body.id as string;
}

beforeAll(async () => {
  t = await createTestApp("s6flow", { DATA_DIR: dataDir, SANDBOX: "process" });
  const setup = await t.req("POST", "/api/v1/setup", { body: { tenantName: "S6F", email: "o@s6f.test", name: "王负责人", password: PW } });
  owner = setup.body.token;
  ownerCtx = await ctxOf(owner);
  const p = await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "PAY", name: "支付服务" } });
  projectId = p.body.id;
  const inv = await t.req("POST", "/api/v1/invitations", { token: owner, body: { tenantRole: "member" } });
  const acc = await t.req("POST", `/api/v1/invitations/${inv.body.token}/accept`, { body: { email: "m@s6f.test", name: "林维护", password: PW } });
  maint = acc.body.token;
  const me = (await t.req("GET", "/api/v1/me", { token: maint })).body;
  await t.req("PUT", `/api/v1/projects/${projectId}/members/${me.principalId}`, { token: owner, body: { role: "maintainer" } });
  maintCtx = await ctxOf(maint);
  for (const [name, role] of [
    ["开发 A", "dev"],
    ["评审 R", "reviewer"],
    ["测试 T", "tester"],
  ] as const)
    ag[role] = (await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name, role } })).body;
  repoUrl = (await t.s.repos.bind(ownerCtx, projectId, { provider: "local", name: "billing", files: BILLING_REPO, testCommand: "bun test" })).repo.url;
  const { registerHandlers } = await import("../src/modules/registry");
  await registerHandlers(t.s);
  await t.s.consumers.init();
  await t.s.db.root.delete(job).where(sql`${job.cron} is not null`);
});
afterAll(async () => {
  await t?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("S6 merge queue", () => {
  test("TRAP-10: two items queued together both merge without a poke; the second is rebased and CI re-runs on the rebased commit", async () => {
    await setPolicy("auto");
    const a = await manualTask("加功能 A", {
      "src/a.ts": "export const a = 1;\n",
      "test/a.test.ts": 'import { expect, test } from "bun:test";\nimport { a } from "../src/a";\ntest("a", () => expect(a).toBe(1));\n',
    });
    const b = await manualTask("加功能 B", {
      "src/b.ts": "export const b = 2;\n",
      "test/b.test.ts": 'import { expect, test } from "bun:test";\nimport { b } from "../src/b";\ntest("b", () => expect(b).toBe(2));\n',
    });
    await settle();
    expect((await load(a)).status).toBe("done");
    expect((await load(b)).status).toBe("done");
    const [ia, ib] = [(await item(a))!, (await item(b))!];
    expect(ia.status).toBe("merged");
    expect(ib.status).toBe("merged");
    const first = ia.position < ib.position ? ia : ib;
    const second = first === ia ? ib : ia;
    expect(first.mergeSha).toBe(first.headSha);
    expect(second.rebasedSha).not.toBe(second.headSha);
    expect(second.mergeSha).toBe(second.rebasedSha);
    const main = await git(["ls-tree", "--name-only", "-r", "main"], { cwd: repoUrl });
    expect(main.out).toContain("src/a.ts");
    expect(main.out).toContain("src/b.ts");
  });

  test("FR-GIT-06: a conflicting item goes to a human with the files listed; the next item still merges", async () => {
    await setPolicy("auto");
    const c1 = await manualTask("改 README（甲）", { "README.md": "# billing\n甲\n", "test/c1.test.ts": 'import { test } from "bun:test";\ntest("c1", () => {});\n' });
    const c2 = await manualTask("改 README（乙）", { "README.md": "# billing\n乙\n", "test/c2.test.ts": 'import { test } from "bun:test";\ntest("c2", () => {});\n' });
    const c3 = await manualTask("加功能 C", { "src/c.ts": "export const c = 3;\n", "test/c.test.ts": 'import { test } from "bun:test";\ntest("c", () => {});\n' });
    await settle();
    const statuses = await Promise.all([c1, c2, c3].map(async (id) => (await item(id))!.status));
    expect(statuses.filter((s) => s === "merged")).toHaveLength(2);
    const conflicted = [(await item(c1))!, (await item(c2))!].find((i) => i.status === "needs_human")!;
    expect(conflicted.conflictFiles).toEqual(["README.md"]);
    expect((await item(c3))!.status).toBe("merged");
    const failed = (await t.s.db.root.select().from(event).where(eq(event.type, "merge.failed"))).find((e) => (e.payload as { taskId: string }).taskId === conflicted.taskId);
    expect((failed!.payload as { inboxPrincipalIds: string[] }).inboxPrincipalIds.length).toBeGreaterThan(0);
    expect((await load(conflicted.taskId)).status).toBe("testing");
  });

  test("GIT-补4: a red default branch pauses the queue; green resumes it", async () => {
    await setPolicy("auto");
    const head = (await git(["rev-parse", "main"], { cwd: repoUrl })).out;
    await t.s.mergeQueue.onMainPipeline((await load((await t.s.db.root.select().from(task).limit(1))[0]!.id)).tenantId, projectId, head, "failed");
    expect((await t.s.mergeQueue.queueState(projectId)).paused).toBe(true);
    const d = await manualTask("暂停期间的改动", { "src/d.ts": "export const d = 4;\n", "test/d.test.ts": 'import { test } from "bun:test";\ntest("d", () => {});\n' });
    await settle();
    expect((await item(d))!.status).toBe("queued");
    expect((await load(d)).status).toBe("testing");
    const esc = (await t.s.db.root.select().from(event).where(eq(event.type, "escalation.raised"))).filter((e) => e.aggregateId === projectId);
    expect(esc.length).toBe(1);
    await t.s.mergeQueue.onMainPipeline((await load(d)).tenantId, projectId, head, "success");
    await settle();
    expect((await t.s.mergeQueue.queueState(projectId)).paused).toBe(false);
    expect((await load(d)).status).toBe("done");
  });
});

describe("S6 gates and evidence", () => {
  test("TRAP-8: the gate failed only because CI was running; pipeline.completed re-checks it without a poke", async () => {
    await setPolicy("auto");
    // A task whose review and test are done while CI on the head is still running must not merge until CI completes.
    const id2 = await manualTask("CI 晚到 2", { "src/f.ts": "export const f = 6;\n", "test/f.test.ts": 'import { test } from "bun:test";\ntest("f", () => {});\n' });
    await t.s.consumers.drain();
    // Run CI for the head but intercept: keep the pipeline result for later.
    const [ws] = await t.s.db.root.select().from(workspace).where(eq(workspace.taskId, id2));
    await t.s.db.root.delete(job).where(eq(job.type, "ci.local_run"));
    // Drive review + test by hand (humans), while CI is still running.
    await t.s.db.root
      .update(task)
      .set({ status: "in_review", testPlan: { cases: ["仓库测试"] } })
      .where(eq(task.id, id2));
    await t.s.quality.submitReview(ownerCtx, id2, { verdict: "approved", criteria: {} });
    await t.s.quality.submitTest(maintCtx, id2, { status: "passed", criteriaResults: (await load(id2)).acceptanceCriteria.map((c) => ({ id: c.id, verdict: "met" as const })) });
    await settle();
    expect((await load(id2)).status).toBe("testing");
    const g = await t.s.quality.gate(await load(id2));
    expect(g.missing).toEqual(["ci_passed"]);
    expect(await item(id2)).toBeUndefined();
    // CI finishes → pipeline.completed → gate re-evaluated → queued → merged.
    await t.s.workspaces.applyCi(ws!.id, { sha: ws!.headCommit!, status: "success", pipelineId: "late" });
    await settle();
    expect((await load(id2)).status).toBe("done");
  });

  test("a new commit after review approval makes the old conclusions stale (review, test, approval, queue)", async () => {
    await setPolicy("require_approval");
    const id = await manualTask("评审后再推", { "src/g.ts": "export const g = 7;\n", "test/g.test.ts": 'import { test } from "bun:test";\ntest("g", () => {});\n' });
    await settle();
    expect((await load(id)).status).toBe("testing");
    const [ap] = await t.s.db.root
      .select()
      .from(approval)
      .where(and(eq(approval.taskId, id), eq(approval.status, "pending")));
    expect(ap).toBeTruthy();
    expect((await t.s.quality.gate(await load(id))).missing).toEqual(["merge_approval"]);
    // Someone pushes another commit onto the branch (e.g. the dev agent after a takeover hand-back).
    const ws = (await t.s.db.root.select().from(workspace).where(eq(workspace.taskId, id)))[0]!;
    await Bun.write(join(ws.worktreePath!, "src/g.ts"), "export const g = 8;\n");
    const devRow = (await t.s.db.root.select().from(agent).where(eq(agent.id, ag.dev!.id)))[0]!;
    await t.s.workspaces.commit(ownerCtx, ws, devRow, await load(id), "再改一下");
    await t.s.workspaces.push(ownerCtx, await t.s.workspaces.load(ws.id), await load(id));
    await t.s.consumers.drain();
    const g = await t.s.quality.gate(await load(id));
    expect(g.missing).toContain("review_approved");
    expect(g.missing).toContain("test_passed");
    const [ap2] = await t.s.db.root.select().from(approval).where(eq(approval.id, ap!.id));
    expect(ap2!.status).toBe("invalidated");
    const reviews = await t.s.db.root.select().from(review).where(eq(review.taskId, id));
    expect(reviews.every((r) => r.superseded)).toBe(true);
    // Approving the stale approval is refused.
    const dec = await t.req("POST", `/api/v1/approvals/${ap!.id}/decide`, { token: owner, body: { decision: "approve" } });
    expect(dec.status).toBe(409);
  });

  test("INV-08: dev ≠ reviewer ≠ tester — agents by role, humans by what they already did on the task", async () => {
    await setPolicy("require_approval");
    const id = await manualTask("职责分离", { "src/h.ts": "export const h = 9;\n" });
    await t.s.db.root.delete(job).where(sql`${job.type} in ('dev.turn','qa.turn')`);
    await t.s.consumers.drain();
    await t.s.db.root.delete(job).where(sql`${job.type} in ('dev.turn','qa.turn')`);
    await t.s.db.root
      .update(task)
      .set({ status: "in_review", testPlan: { cases: ["仓库测试"] } })
      .where(eq(task.id, id));
    const devRow = (await t.s.db.root.select().from(agent).where(eq(agent.id, ag.dev!.id)))[0]!;
    const testerRow = (await t.s.db.root.select().from(agent).where(eq(agent.id, ag.tester!.id)))[0]!;
    const sesD = await t.s.runtime.getOrCreateSession(devRow.tenantId, devRow, "task", id, null);
    const devCtx = await t.s.runtime.agentCtx(devRow, sesD.id, "trc");
    await expect(t.s.quality.submitReview(devCtx, id, { verdict: "approved" })).rejects.toThrow();
    const sesT = await t.s.runtime.getOrCreateSession(testerRow.tenantId, testerRow, "task", id, null);
    const testerCtx = await t.s.runtime.agentCtx(testerRow, sesT.id, "trc");
    await expect(t.s.quality.submitReview(testerCtx, id, { verdict: "approved" })).rejects.toThrow();
    // A human who reviewed cannot also test.
    await t.s.quality.submitReview(maintCtx, id, { verdict: "approved" });
    expect((await load(id)).status).toBe("testing");
    await expect(t.s.quality.submitTest(maintCtx, id, { status: "passed", criteriaResults: (await load(id)).acceptanceCriteria.map((c) => ({ id: c.id, verdict: "met" as const })) })).rejects.toThrow(
      "INV-08",
    );
    // The dev agent cannot record tests for its own task either.
    await expect(t.s.quality.submitTest(devCtx, id, { status: "passed", criteriaResults: [] })).rejects.toThrow();
    // Tool ceiling: the dev agent has no submit_review / submit_test_result at all.
    expect(t.s.runtime.effectiveTools(devRow)).not.toContain("submit_review");
    expect(t.s.runtime.effectiveTools(devRow)).not.toContain("submit_test_result");
    // A human who took over the task cannot review it.
    const id2 = await manualTask("接管者不能评审", { "src/i.ts": "export const i = 1;\n" });
    await t.s.db.root.delete(job).where(sql`${job.type} in ('dev.turn','qa.turn')`);
    await t.s.db.root.update(task).set({ status: "in_review", takenOverBy: ownerCtx.actor.principalId }).where(eq(task.id, id2));
    await expect(t.s.quality.submitReview(ownerCtx, id2, { verdict: "approved" })).rejects.toThrow("接管");
  });

  test("TSK-补5: a human reviewer can still request changes after the agent approved; the gate fails and the item leaves the queue", async () => {
    await setPolicy("require_approval");
    const id = await manualTask("人类覆盖", { "src/j.ts": "export const j = 1;\n", "test/j.test.ts": 'import { test } from "bun:test";\ntest("j", () => {});\n' });
    await settle();
    expect((await load(id)).status).toBe("testing");
    expect((await t.s.quality.gate(await load(id))).missing).toEqual(["merge_approval"]);
    const r = await t.req("POST", `/api/v1/tasks/${id}/reviews`, { token: owner, body: { verdict: "changes_requested", comments: [{ path: "src/j.ts", line: 1, body: "命名不清楚" }] } });
    expect(r.status).toBe(200);
    await t.s.consumers.drain();
    const g = await t.s.quality.gate(await load(id));
    expect(g.missing).toContain("review_approved");
  });

  test("TRAP-6: an approval decision wakes no captain session and no dev turn", async () => {
    await setPolicy("require_approval");
    const id = await manualTask("审批不唤醒船长", { "src/k.ts": "export const k = 1;\n", "test/k.test.ts": 'import { test } from "bun:test";\ntest("k", () => {});\n' });
    await settle();
    const [ap] = await t.s.db.root
      .select()
      .from(approval)
      .where(and(eq(approval.taskId, id), eq(approval.status, "pending")));
    const before = await t.s.db.root.select({ n: sql<number>`count(*)::int` }).from(session);
    const beforeJobs = await t.s.db.root
      .select({ n: sql<number>`count(*)::int` })
      .from(job)
      .where(sql`${job.type} in ('captain.turn','dev.turn')`);
    await t.req("POST", `/api/v1/approvals/${ap!.id}/decide`, { token: owner, body: { decision: "approve" } });
    await settle();
    expect((await load(id)).status).toBe("done");
    const afterS = await t.s.db.root.select({ n: sql<number>`count(*)::int` }).from(session);
    const afterJobs = await t.s.db.root
      .select({ n: sql<number>`count(*)::int` })
      .from(job)
      .where(sql`${job.type} in ('captain.turn','dev.turn')`);
    expect(afterJobs[0]!.n).toBe(beforeJobs[0]!.n);
    // Only the captain's resident session (completion summary) may be touched; no new session is created by the decision.
    expect(afterS[0]!.n - before[0]!.n).toBeLessThanOrEqual(1);
  });

  test("GIT-补7: a change touching a sensitive path needs a human review even after the agent approved", async () => {
    await setPolicy("auto");
    const id = await manualTask("改依赖清单", { "package.json": '{ "name": "billing", "private": true }\n', "test/pkg.test.ts": 'import { test } from "bun:test";\ntest("pkg", () => {});\n' });
    await settle();
    const row = await load(id);
    expect(row.status).toBe("in_review");
    const f = await t.s.tasks.facts(row);
    expect(f.humanReviewRequired).toBe(true);
    const rv = await t.s.db.root.select().from(review).where(eq(review.taskId, id));
    expect(rv.map((r) => [r.reviewerKind, r.verdict])).toEqual([["agent", "approved"]]);
    const r = await t.req("POST", `/api/v1/tasks/${id}/reviews`, { token: maint, body: { verdict: "approved", summary: "依赖清单改动已人工确认" } });
    expect(r.status).toBe(200);
    await settle();
    expect((await load(id)).status).toBe("done");
  });

  test("GIT-补6: a done task offers a rollback task that reverts the merge commit", async () => {
    const [done] = await t.s.db.root
      .select()
      .from(task)
      .where(and(eq(task.projectId, projectId), eq(task.status, "done")))
      .limit(1);
    const r = await t.req("POST", `/api/v1/tasks/${done!.id}/rollback`, { token: owner });
    expect(r.status).toBe(200);
    expect(r.body.type).toBe("hotfix");
    expect(r.body.followUpOf).toBe(done!.id);
    expect(r.body.description).toContain("git revert");
  });
});
