import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { PAYMENTS_REPO } from "../src/cli/demo-repos";
import type { Ctx } from "../src/core/context";
import { approval, artifact, auditLog, event, job, localScmIssue, localScmMr, mergeQueueItem, message, proposal, releaseRecord, review, session, task, testRun, workspace } from "../src/db/schema";
import { git } from "../src/modules/scm/service";
import { createTestApp, type TestApp } from "./helpers";

process.env.LLM_BACKOFF_MS = "2";
let t: TestApp;
const PW = "Correct-Horse-42";
const dataDir = mkdtempSync(join(tmpdir(), "ap-s6-"));
let owner = "";
let ownerCtx: Ctx;
let projectId = "";
let groupId = "";
let repoUrl = "";
let cap: { id: string; principalId: string };
const agents: Record<string, { id: string; principalId: string }> = {};

/** Scheduling cycles until nothing is runnable (consumers ⇄ jobs). */
export async function settle(tt: TestApp, max = 40) {
  for (let i = 0; i < max; i++) {
    const a = await tt.s.consumers.drain();
    const b = await tt.s.jobs.drain();
    if (!a && !b) return i;
  }
  return max;
}
const say = async (body: string) => {
  const r = await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: owner, body: { body } });
  expect(r.status).toBe(200);
  return r.body.message as { id: string; seq: number };
};
const after = async (seq: number) => (await t.s.db.root.select().from(message).where(eq(message.groupId, groupId)).orderBy(asc(message.seq))).filter((m) => m.seq > seq);

beforeAll(async () => {
  t = await createTestApp("s6main", { DATA_DIR: dataDir, SANDBOX: "process" });
  const setup = await t.req("POST", "/api/v1/setup", { body: { tenantName: "S6", email: "o@s6.test", name: "王负责人", password: PW } });
  owner = setup.body.token;
  ownerCtx = await t.s.identity.authenticate(new Headers({ authorization: `Bearer ${owner}` }), "trc_s6");
  const p = await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "PAY", name: "支付服务", description: "支付网关" } });
  projectId = p.body.id;
  groupId = p.body.mainGroupId;
  for (const [name, role] of [
    ["开发 A", "dev"],
    ["评审 R", "reviewer"],
    ["测试 T", "tester"],
  ] as const)
    agents[role] = (await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name, role } })).body;
  cap = ((await t.req("GET", `/api/v1/projects/${projectId}/agents`, { token: owner })).body as Array<{ id: string; principalId: string; role: string }>).find((a) => a.role === "sub_captain")!;
  const bound = await t.s.repos.bind(ownerCtx, projectId, { provider: "local", name: "payments", files: PAYMENTS_REPO, testCommand: "bun test" });
  repoUrl = bound.repo.url;
  const { registerHandlers } = await import("../src/modules/registry");
  await registerHandlers(t.s);
  await t.s.consumers.init();
  await t.s.db.root.delete(job).where(sql`${job.cron} is not null`);
});
afterAll(async () => {
  await t?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("S6 main scenario §22.2 — scripted model + local SCM (CI)", () => {
  let taskId = "";
  let mainBefore = "";

  test("steps 1–3: request → captain summary + follow-up → details → proposal with criteria and suggested owner", async () => {
    mainBefore = (await git(["rev-parse", "main"], { cwd: repoUrl })).out;
    const m1 = await say(`@[${cap.principalId}] 支付服务最近超时，帮我查一下`);
    const t0 = Date.now();
    await settle(t);
    const r1 = await after(m1.seq);
    expect(r1.find((m) => m.authorPrincipalId === cap.principalId && m.kind === "text")?.body).toContain("支付服务最近超时");
    expect(r1.some((m) => m.kind === "question")).toBe(true);
    expect(Date.now() - t0).toBeLessThan(60_000); // step 2: within a minute
    await say("从昨天下午 3 点开始，下单接口 p99 超过 30 秒才失败，上游网关 5 秒就断开");
    await settle(t);
    const [prp] = await t.s.db.root
      .select()
      .from(proposal)
      .where(and(eq(proposal.groupId, groupId), eq(proposal.status, "pending")));
    expect(prp).toBeTruthy();
    expect((prp!.payload as { acceptanceCriteria: string[] }).acceptanceCriteria.length).toBeGreaterThan(0);
  });

  test("step 4: human confirms in Web → task created and synced to an Issue", async () => {
    const [prp] = await t.s.db.root
      .select()
      .from(proposal)
      .where(and(eq(proposal.groupId, groupId), eq(proposal.status, "pending")));
    const acc = await t.req("POST", `/api/v1/proposals/${prp!.id}/accept`, { token: owner });
    expect(acc.status).toBe(200);
    const [p2] = await t.s.db.root.select().from(proposal).where(eq(proposal.id, prp!.id));
    taskId = p2!.resultTaskIds[0]!;
    await settle(t);
    const [row] = await t.s.db.root.select().from(task).where(eq(task.id, taskId));
    expect(row!.assigneeAgentId).toBe(agents.dev!.id);
    expect(row!.issueRef).toBe("#1");
  });

  test("steps 5–7: dev fixes + MR; reviewer leaves two comments; dev reworks; reviewer approves; tester runs tests with report and log", async () => {
    const [row] = await t.s.db.root.select().from(task).where(eq(task.id, taskId));
    expect(row!.status).toBe("testing");
    const reviews = await t.s.db.root.select().from(review).where(eq(review.taskId, taskId)).orderBy(asc(review.round));
    expect(reviews.map((r) => r.verdict)).toEqual(["changes_requested", "approved"]);
    expect(reviews[0]!.comments).toHaveLength(2);
    expect(reviews[0]!.superseded).toBe(true); // made on the first head; the rework commit superseded it
    const [ws] = await t.s.db.root.select().from(workspace).where(eq(workspace.taskId, taskId));
    expect(reviews[1]!.headSha).toBe(ws!.headCommit!);
    const log = await git(["log", "--format=%an|%s", `main..${ws!.branch}`], { cwd: repoUrl });
    expect(log.out.split("\n")).toHaveLength(2);
    expect(log.out).toContain("按评审意见修改");
    expect((await git(["show", `${ws!.branch}:test/gateway-default.test.ts`], { cwd: repoUrl, allowFail: true })).ok).toBe(true);
    const runs = await t.s.db.root.select().from(testRun).where(eq(testRun.taskId, taskId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "passed", headSha: ws!.headCommit! });
    expect(runs[0]!.criteriaResults.every((c) => c.verdict === "met")).toBe(true);
    const [logArt] = await t.s.db.root.select().from(artifact).where(eq(artifact.id, runs[0]!.logArtifactId!));
    expect(logArt!.kind).toBe("log");
    // INV-08: three different agents did dev, review and test.
    expect(reviews.every((r) => r.reviewerPrincipalId === agents.reviewer!.principalId)).toBe(true);
    expect(runs[0]!.testerPrincipalId).toBe(agents.tester!.principalId);
    // Independent review/test checkouts existed only for the run and are gone (FR-REL-02, §12.7).
    expect(existsSync(`${ws!.worktreePath!}.review`)).toBe(false);
    expect(existsSync(`${ws!.worktreePath!}.test`)).toBe(false);
    const sess = await t.s.db.root
      .select()
      .from(session)
      .where(and(eq(session.scopeType, "task"), eq(session.scopeId, taskId)));
    expect(sess.length).toBe(3);
  });

  test("step 8: merge approval with evidence → human approves → merge queue merges, Issue closed, task done", async () => {
    const [ap] = await t.s.db.root
      .select()
      .from(approval)
      .where(and(eq(approval.taskId, taskId), eq(approval.kind, "merge"), eq(approval.status, "pending")));
    expect(ap).toBeTruthy();
    expect(Object.keys(ap!.evidence).sort()).toEqual(["ci", "cost", "diff", "mr", "review", "risk", "tests"]);
    expect(String(ap!.evidence.tests)).toContain("通过");
    // Nothing is merged before the human decides (no auto approval, NTF-补3).
    expect((await git(["rev-parse", "main"], { cwd: repoUrl })).out).toBe(mainBefore);
    const dec = await t.req("POST", `/api/v1/approvals/${ap!.id}/decide`, { token: owner, body: { decision: "approve", reason: "证据齐全" } });
    expect(dec.status).toBe(200);
    await settle(t);
    const [row] = await t.s.db.root.select().from(task).where(eq(task.id, taskId));
    expect(row!.status).toBe("done");
    const [mq] = await t.s.db.root.select().from(mergeQueueItem).where(eq(mergeQueueItem.taskId, taskId));
    expect(mq!.status).toBe("merged");
    const mainAfter = (await git(["rev-parse", "main"], { cwd: repoUrl })).out;
    expect(mainAfter).toBe(mq!.mergeSha!);
    expect((await git(["show", "main:src/gateway.ts"], { cwd: repoUrl })).out).toContain("= 3_000");
    const [mr] = await t.s.db.root.select().from(localScmMr).where(eq(localScmMr.repoPath, repoUrl));
    expect(mr!.state).toBe("merged");
    const [iss] = await t.s.db.root.select().from(localScmIssue).where(eq(localScmIssue.repoPath, repoUrl));
    expect(iss!.state).toBe("closed");
    const [rel] = await t.s.db.root.select().from(releaseRecord).where(eq(releaseRecord.taskId, taskId));
    expect(rel).toMatchObject({ mergeCommit: mainAfter, mrRef: "!1" });
    expect(rel!.approvedBy).toBeTruthy();
    expect(rel!.testRunId).toBeTruthy();
  });

  test("step 9: the captain posts a completion summary with MR, test report and release record", async () => {
    const [card] = await t.s.db.root
      .select()
      .from(message)
      .where(and(eq(message.groupId, groupId), eq(message.kind, "summary_card"), sql`${message.blocks}->'completion'->>'taskId' = ${taskId}`));
    expect(card).toBeTruthy();
    expect(card!.authorPrincipalId).toBe(cap.principalId);
    expect(card!.body).toContain("!1");
    expect(card!.body).toContain("测试：通过");
    expect(card!.body).toContain("发布记录：rel_");
  });

  test("step 10: the whole chain is auditable — messages, task, sessions, artifacts, approvals, merge", async () => {
    const tl = await t.req("GET", `/api/v1/tasks/${taskId}/timeline`, { token: owner });
    const types = new Set((tl.body as Array<{ type: string }>).map((e) => e.type));
    for (const ty of [
      "task.created",
      "task.assigned",
      "wake.requested",
      "workspace.created",
      "commit.pushed",
      "mr.opened",
      "pipeline.completed",
      "review.submitted",
      "test_run.completed",
      "approval.requested",
      "approval.decided",
      "merge.queued",
      "merge.completed",
      "release.recorded",
    ])
      expect(types.has(ty)).toBe(true);
    const sessions = await t.s.db.root
      .select()
      .from(session)
      .where(and(eq(session.scopeType, "task"), eq(session.scopeId, taskId)));
    expect(new Set(sessions.map((s) => s.agentId))).toEqual(new Set([agents.dev!.id, agents.reviewer!.id, agents.tester!.id]));
    const audits = await t.s.db.root.select({ a: auditLog.action }).from(auditLog);
    for (const a of ["task.create", "workspace.push", "review.submit", "test.submit", "approval.decide", "merge.complete"]) expect(audits.some((x) => x.a === a)).toBe(true);
    const verify = await t.req("GET", "/api/v1/audit/verify", { token: owner });
    expect(verify.status).toBe(200);
    expect(verify.body.ok).toBe(true);
    // The default branch's own CI ran after the merge (GIT-补4) and was green.
    const mainRuns = (await t.s.db.root.select().from(event).where(eq(event.type, "pipeline.completed"))).filter((e) => (e.payload as { purpose?: string }).purpose === "main");
    expect(mainRuns.map((e) => (e.payload as { status: string }).status)).toEqual(["success"]);
  });
});
