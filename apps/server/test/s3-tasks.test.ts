import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Ctx } from "../src/core/context";
import { agent, approval, auditLog, event, inboxItem, mergeQueueItem, repo, review, task, tenant, testRun, workspace } from "../src/db/schema";
import { createTestApp, type TestApp } from "./helpers";

let t: TestApp;
const PW = "Correct-Horse-42";
let owner = "";
let ownerPrincipal = "";
let member = "";
let memberPrincipal = "";
let outsider = "";
let projectId = "";
let groupId = "";
let devAgentId = "";
let devAgent: { id: string; principalId: string } = { id: "", principalId: "" };
let reviewerAgent: { id: string; principalId: string } = { id: "", principalId: "" };
let testerAgent: { id: string; principalId: string } = { id: "", principalId: "" };
let captain: { id: string; principalId: string } = { id: "", principalId: "" };
let tenantId = "";
let repoId = "";

async function join(email: string, name: string, tenantRole = "member") {
  const inv = await t.req("POST", "/api/v1/invitations", { token: owner, body: { tenantRole } });
  const acc = await t.req("POST", `/api/v1/invitations/${inv.body.token}/accept`, { body: { email, name, password: PW } });
  const me = (await t.req("GET", "/api/v1/me", { token: acc.body.token })).body;
  return { token: acc.body.token as string, principalId: me.principalId as string };
}

const agentCtx = (a: { id: string; principalId: string }, role: "dev" | "reviewer" | "tester" | "sub_captain"): Ctx => ({
  tenantId,
  traceId: `trc_test_${role}`,
  actor: { principalId: a.principalId, kind: "agent", displayName: role, agentId: a.id, agentRole: role, projectScope: [projectId] },
});

async function newTask(body: Record<string, unknown> = {}) {
  const r = await t.req("POST", "/api/v1/tasks", {
    token: owner,
    body: { projectId, title: "修复支付回调超时", acceptanceCriteria: ["回调 3s 内返回", "重试最多 5 次"], assigneeAgentId: devAgentId, groupId, ...body },
  });
  expect(r.status).toBe(200);
  return r.body as { id: string; version: number; ref: string; status: string };
}

const transition = (id: string, to: string, extra: Record<string, unknown> = {}, token = owner) => t.req("POST", `/api/v1/tasks/${id}/transition`, { token, body: { to, ...extra } });

async function setFacts(taskId: string, f: { ws?: boolean; mr?: boolean; ci?: boolean; review?: boolean; testPlan?: boolean; test?: boolean; merged?: boolean }) {
  const db = t.s.db.root;
  const head = "abc1234def";
  if (f.ws) {
    await db
      .insert(workspace)
      .values({ id: `ws_${taskId}`, tenantId, taskId, repoId, branch: `task/${taskId}`, headCommit: head, status: "ready" })
      .onConflictDoNothing();
  }
  if (f.mr || f.ci)
    await db
      .update(workspace)
      .set({ mrRef: "!1", ci: f.ci ? { status: "success", sha: head } : null, diffStat: { files: 1, additions: 3, deletions: 1, paths: ["src/pay.ts"] } })
      .where(eq(workspace.taskId, taskId));
  if (f.review)
    await db
      .insert(review)
      .values({ id: `rv_${taskId}_${Date.now()}`, tenantId, taskId, reviewerPrincipalId: reviewerAgent.principalId, reviewerKind: "agent", headSha: head, verdict: "approved", round: 1 });
  if (f.testPlan)
    await db
      .update(task)
      .set({ testPlan: { cases: ["回调超时重放"] } })
      .where(eq(task.id, taskId));
  if (f.test) await db.insert(testRun).values({ id: `tr_${taskId}_${Date.now()}`, tenantId, taskId, testerPrincipalId: testerAgent.principalId, headSha: head, plan: {}, status: "passed" });
  if (f.merged)
    await db
      .insert(mergeQueueItem)
      .values({ id: `mq_${taskId}`, tenantId, projectId, taskId, status: "merged", headSha: head })
      .onConflictDoNothing();
}

beforeAll(async () => {
  t = await createTestApp("s3tasks");
  const setup = await t.req("POST", "/api/v1/setup", { body: { tenantName: "S3", email: "o@s3.test", name: "王负责人", password: PW } });
  owner = setup.body.token;
  ownerPrincipal = (await t.req("GET", "/api/v1/me", { token: owner })).body.principalId;
  const m = await join("m@s3.test", "李成员");
  member = m.token;
  memberPrincipal = m.principalId;
  outsider = (await join("x@s3.test", "局外人")).token;
  const p = await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "PAY", name: "支付服务" } });
  projectId = p.body.id;
  groupId = p.body.mainGroupId;
  await t.req("PUT", `/api/v1/projects/${projectId}/members/${memberPrincipal}`, { token: owner, body: { role: "member" } });
  const mk = async (name: string, role: string) => (await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name, role } })).body as { id: string; principalId: string };
  devAgent = await mk("开发 A", "dev");
  devAgentId = devAgent.id;
  reviewerAgent = await mk("评审 R", "reviewer");
  testerAgent = await mk("测试 T", "tester");
  const agents = (await t.req("GET", `/api/v1/projects/${projectId}/agents`, { token: owner })).body as Array<{ id: string; principalId: string; role: string }>;
  captain = agents.find((a) => a.role === "sub_captain")!;
  const [tn] = await t.s.db.root.select().from(tenant);
  tenantId = tn!.id;
  repoId = "repo_test";
  await t.s.db.root.insert(repo).values({ id: repoId, tenantId, projectId, name: "pay", provider: "local", externalId: "pay", url: "file:///tmp/pay" });
});
afterAll(async () => t?.close());

describe("S3 tasks", () => {
  test("FR-TSK-01/02/03: create with sources; per-project numbering; creator is owner", async () => {
    const msg = await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: owner, body: { body: "回调超时了" } });
    const a = await newTask({ sourceMessageIds: [msg.body.message.id] });
    const b = await newTask({ title: "第二个" });
    expect(Number(b.ref.split("-")[1])).toBe(Number(a.ref.split("-")[1]) + 1);
    const g = await t.req("GET", `/api/v1/tasks/${a.id}`, { token: member });
    expect(g.body.status).toBe("backlog");
    expect(g.body.owners[0].principalId).toBe(ownerPrincipal);
    expect(g.body.sourceMessageIds).toEqual([msg.body.message.id]);
    expect(g.body.facts.hasAcceptanceCriteria).toBe(true);
  });

  test("INV-11: outsider (not a project member) cannot read tasks", async () => {
    const a = await newTask();
    expect((await t.req("GET", `/api/v1/tasks/${a.id}`, { token: outsider })).status).toBe(403);
    expect((await t.req("GET", `/api/v1/projects/${projectId}/tasks`, { token: outsider })).status).toBe(403);
  });

  test("INV-02: cannot enter ready without assignee + owner + criteria; reason lists what's missing", async () => {
    const a = await newTask({ assigneeAgentId: null, acceptanceCriteria: [] });
    const r = await transition(a.id, "ready");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("illegal_transition");
    expect(r.body.details.missingLabels).toEqual(["验收标准", "负责 Agent"]);
    // Removing the last human owner is refused.
    const rm = await t.req("DELETE", `/api/v1/tasks/${a.id}/owners/${ownerPrincipal}`, { token: owner });
    expect(rm.status).toBe(409);
  });

  test("INV-03: every transition (allowed or denied) leaves an event and an audit row with policy", async () => {
    const a = await newTask();
    expect((await transition(a.id, "done")).status).toBe(409);
    expect((await transition(a.id, "ready")).status).toBe(200);
    const evs = await t.s.db.root.select().from(event).where(eq(event.aggregateId, a.id));
    expect(evs.map((e) => e.type)).toContain("task.transition_denied");
    const changed = evs.find((e) => e.type === "task.status_changed")!;
    expect((changed.payload as { from: string; to: string }).to).toBe("ready");
    expect((changed.payload as { policy: { rule: string } }).policy.rule).toBe("backlog->ready");
    const audits = await t.s.db.root.select().from(auditLog).where(eq(auditLog.resourceId, a.id));
    expect(audits.some((x) => x.action === "task.transition" && x.outcome === "denied")).toBe(true);
    expect(audits.some((x) => x.action === "task.transition" && x.outcome === "allowed")).toBe(true);
  });

  test("full legal path backlog → ready → in_progress → blocked → in_progress → in_review → in_progress(rework) → in_review → testing → in_progress(fail) … → done", async () => {
    const a = await newTask();
    const dev = agentCtx(devAgent, "dev");
    const rev = agentCtx(reviewerAgent, "reviewer");
    const tst = agentCtx(testerAgent, "tester");
    expect((await transition(a.id, "ready")).status).toBe(200);
    expect((await transition(a.id, "in_progress")).body.details.missingLabels).toEqual(["工作区就绪"]);
    await setFacts(a.id, { ws: true });
    await t.s.tasks.transition(dev, a.id, "in_progress");
    expect((await transition(a.id, "blocked", { reason: "缺少测试账号" })).body.details.missingLabels).toEqual(["需要谁决策"]);
    expect((await transition(a.id, "blocked", { reason: "缺少测试账号", needs: "王负责人" })).status).toBe(200);
    expect((await transition(a.id, "in_progress")).status).toBe(200);
    // Humans cannot submit for review — only the assignee agent can.
    await setFacts(a.id, { mr: true, ci: true });
    expect((await transition(a.id, "in_review")).body.details.code).toBe("actor_not_allowed");
    // A different dev agent (not the assignee) is not allowed either.
    await t.s.tasks.transition(dev, a.id, "in_review");
    await expect(t.s.tasks.transition(rev, a.id, "in_progress")).rejects.toThrow(/修改意见/);
    await t.s.tasks.transition(rev, a.id, "in_progress", { reason: "缺少超时单测" });
    await t.s.tasks.transition(dev, a.id, "in_review");
    await setFacts(a.id, { review: true });
    await expect(t.s.tasks.transition(rev, a.id, "testing")).rejects.toThrow(/测试计划/);
    await setFacts(a.id, { testPlan: true });
    await t.s.tasks.transition(rev, a.id, "testing");
    await t.s.tasks.transition(tst, a.id, "in_progress", { reason: "重放用例失败" });
    await t.s.tasks.transition(dev, a.id, "in_review");
    await t.s.tasks.transition(rev, a.id, "testing");
    expect((await transition(a.id, "done")).body.details.missingLabels).toEqual(["测试通过", "合并完成", "Issue 已关闭"]);
    await setFacts(a.id, { test: true, merged: true });
    const sys = await t.s.identity.systemCtx(tenantId);
    const done = await t.s.tasks.transition(sys, a.id, "done");
    expect(done.status).toBe("done");
    // Terminal: nothing leaves done, not even cancel; reopening = follow-up task (TSK-补1).
    expect((await transition(a.id, "cancelled", { reason: "x" })).body.details.code).toBe("no_such_transition");
    const fu = await t.req("POST", `/api/v1/tasks/${a.id}/follow-up`, { token: owner, body: {} });
    expect(fu.body.followUpOf).toBe(a.id);
    expect(fu.body.owners[0].principalId).toBe(ownerPrincipal);
    const detail = await t.req("GET", `/api/v1/tasks/${a.id}/timeline`, { token: owner });
    expect(detail.body.filter((e: { type: string }) => e.type === "task.status_changed").length).toBe(12);
  });

  test("TSK-补4: rework above the review limit auto-blocks and escalates", async () => {
    const a = await newTask();
    const dev = agentCtx(devAgent, "dev");
    const rev = agentCtx(reviewerAgent, "reviewer");
    await transition(a.id, "ready");
    await setFacts(a.id, { ws: true, mr: true, ci: true });
    await t.s.tasks.transition(dev, a.id, "in_progress");
    for (let i = 0; i < 3; i++) {
      await t.s.tasks.transition(dev, a.id, "in_review");
      await t.s.tasks.transition(rev, a.id, "in_progress", { reason: `第 ${i + 1} 轮` });
    }
    await t.s.tasks.transition(dev, a.id, "in_review");
    const r = await t.s.tasks.transition(rev, a.id, "in_progress", { reason: "第 4 轮" });
    expect(r.status).toBe("blocked");
    expect(r.task.blockedReason).toBe("返工超限");
  });

  test("cancel: needs reason; member can cancel only own tasks", async () => {
    const a = await newTask();
    expect((await transition(a.id, "cancelled")).body.details.missingLabels).toEqual(["取消原因"]);
    expect((await transition(a.id, "cancelled", { reason: "重复" }, member)).body.details.code).toBe("actor_not_allowed");
    const mine = await t.req("POST", "/api/v1/tasks", { token: member, body: { projectId, title: "成员自己的任务" } });
    expect((await transition(mine.body.id, "cancelled", { reason: "不需要了" }, member)).status).toBe(200);
  });

  test("TSK-补7: PATCH with stale If-Match → 409 已被他人修改", async () => {
    const a = await newTask();
    const ok = await t.req("PATCH", `/api/v1/tasks/${a.id}`, { token: owner, body: { priority: "P1" }, headers: { "if-match": String(a.version) } });
    expect(ok.status).toBe(200);
    const stale = await t.req("PATCH", `/api/v1/tasks/${a.id}`, { token: owner, body: { priority: "P0" }, headers: { "if-match": String(a.version) } });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toContain("已被他人修改");
  });

  test("TSK-补3: member cannot reassign; maintainer can; only dev agents can be assignees", async () => {
    const a = await newTask();
    const other = (await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name: "开发 B", role: "dev" } })).body;
    expect((await t.req("PATCH", `/api/v1/tasks/${a.id}`, { token: member, body: { assigneeAgentId: other.id } })).status).toBe(403);
    expect((await t.req("PATCH", `/api/v1/tasks/${a.id}`, { token: owner, body: { assigneeAgentId: other.id } })).body.assignee.name).toBe("开发 B");
    expect((await t.req("PATCH", `/api/v1/tasks/${a.id}`, { token: owner, body: { assigneeAgentId: reviewerAgent.id } })).status).toBe(400);
  });

  test("INV-07: the captain cannot create tasks or change status directly", async () => {
    const cap = agentCtx(captain, "sub_captain");
    await expect(t.s.tasks.create(cap, { projectId, title: "船长直接建任务" })).rejects.toThrow(/INV-07/);
    const a = await newTask();
    await expect(t.s.tasks.transition(cap, a.id, "ready")).rejects.toThrow(/当前身份不能执行/);
  });

  test("task comments notify owners via inbox (merged per task)", async () => {
    const a = await newTask();
    await t.req("POST", `/api/v1/tasks/${a.id}/comments`, { token: member, body: { body: "我来补充复现步骤" } });
    await t.req("POST", `/api/v1/tasks/${a.id}/comments`, { token: member, body: { body: "日志在附件" } });
    t.s.consumers.register(t.s.inbox.consumer);
    await t.s.consumers.init();
    await t.s.consumers.drain();
    const inbox = await t.req("GET", "/api/v1/inbox?kind=task", { token: owner });
    const item = inbox.body.items.find((i: { refId: string }) => i.refId === a.id);
    expect(item.count).toBeGreaterThanOrEqual(2);
    expect(item.title).toContain("评论了任务");
  });
});

describe("S3 proposals", () => {
  test("FR-CAP-05: proposal must cite existing source messages; humans accept → task (owner = acceptor) → ready", async () => {
    const cap = agentCtx(captain, "sub_captain");
    await expect(t.s.proposals.create(cap, { projectId, groupId, kind: "create_task", payload: { title: "x" }, sourceMessageIds: ["msg_nope"] })).rejects.toThrow(/来源消息/);
    const src = await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: member, body: { body: "请修复退款接口偶发 500" } });
    const p = await t.s.proposals.create(cap, {
      projectId,
      groupId,
      kind: "create_task",
      payload: { title: "修复退款接口偶发 500", acceptanceCriteria: ["复现用例通过", "错误率 < 0.1%"], assigneeAgentId: devAgentId },
      sourceMessageIds: [src.body.message.id, "msg_hallucinated"],
    });
    expect(p.sourceMessageIds).toEqual([src.body.message.id]);
    expect(p.messageId).toBeTruthy();
    // CAP-补2: follow-up info updates the same pending proposal rather than posting another.
    const again = await t.s.proposals.create(cap, {
      projectId,
      groupId,
      kind: "create_task",
      payload: { title: "修复退款接口偶发 500（含重试）", acceptanceCriteria: ["复现用例通过"], assigneeAgentId: devAgentId },
      sourceMessageIds: [src.body.message.id],
    });
    expect(again.id).toBe(p.id);
    expect(again.updated).toBe(true);
    // Agents can't decide (INV-07); viewers/outsiders can't either.
    await expect(t.s.proposals.accept(cap, p.id)).rejects.toThrow(/INV-07/);
    expect((await t.req("POST", `/api/v1/proposals/${p.id}/accept`, { token: outsider })).status).toBe(403);
    const acc = await t.req("POST", `/api/v1/proposals/${p.id}/accept`, { token: member });
    expect(acc.status).toBe(200);
    expect(acc.body.status).toBe("accepted");
    const tk = await t.req("GET", `/api/v1/tasks/${acc.body.resultTaskIds[0]}`, { token: member });
    expect(tk.body.status).toBe("ready");
    expect(tk.body.owners.map((o: { principalId: string }) => o.principalId)).toEqual([memberPrincipal]);
    expect(tk.body.sourceMessageIds).toEqual([src.body.message.id]);
    expect((await t.req("POST", `/api/v1/proposals/${p.id}/accept`, { token: member })).status).toBe(409);
    // The card in the chat reflects the decision.
    const tl = await t.req("GET", `/api/v1/groups/${groupId}/messages?limit=5`, { token: member });
    const card = tl.body.items.find((m: { id: string }) => m.id === p.messageId);
    expect(card.blocks.status).toBe("accepted");
  });

  test("CAP-补3 duplicate hint; reject requires reason; expiry sweep", async () => {
    const cap = agentCtx(captain, "sub_captain");
    await newTask({ title: "支付回调超时重试机制" });
    const src = await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: member, body: { body: "回调超时要加重试" } });
    const g2 = await t.req("POST", `/api/v1/projects/${projectId}/groups`, { token: owner, body: { name: "回调专项" } });
    const p = await t.s.proposals.create(cap, { projectId, groupId: g2.body.id, kind: "create_task", payload: { title: "支付回调超时重试机制优化" }, sourceMessageIds: [src.body.message.id] });
    expect((p.payload.duplicates as unknown[]).length).toBeGreaterThan(0);
    expect((await t.req("POST", `/api/v1/proposals/${p.id}/reject`, { token: owner, body: { reason: "" } })).status).toBe(400);
    const p2 = await t.s.proposals.create(cap, { projectId, groupId: null, kind: "create_task", payload: { title: "过期测试" }, sourceMessageIds: [src.body.message.id] });
    const r = await t.s.proposals.sweep(new Date(Date.now() + 73 * 3_600_000));
    expect(r.expired).toBeGreaterThanOrEqual(2);
    expect((await t.req("GET", `/api/v1/proposals/${p2.id}`, { token: owner })).body.status).toBe("expired");
  });
});

describe("S3 approvals & escalation", () => {
  test("INV-09: only humans decide; requester can't self-approve; reject needs reason; timeout never approves", async () => {
    const a = await newTask();
    await setFacts(a.id, { ws: true });
    const req = await t.req("POST", `/api/v1/tasks/${a.id}/approvals`, { token: member, body: { kind: "merge", evidence: { diff: "+3 -1" } } });
    expect(req.status).toBe(200);
    expect(req.body.headSha).toBe("abc1234def");
    // Same task/kind/head while pending → the same approval (dedupe).
    expect((await t.req("POST", `/api/v1/tasks/${a.id}/approvals`, { token: owner, body: { kind: "merge" } })).body.id).toBe(req.body.id);
    const self = await t.req("POST", `/api/v1/approvals/${req.body.id}/decide`, { token: member, body: { decision: "approve" } });
    expect(self.status).toBe(403);
    expect(self.body.message).toContain("INV-09");
    await expect(t.s.approvals.decide(agentCtx(reviewerAgent, "reviewer"), req.body.id, { decision: "approve" })).rejects.toThrow(/INV-09/);
    expect((await t.req("POST", `/api/v1/approvals/${req.body.id}/decide`, { token: owner, body: { decision: "reject" } })).status).toBe(400);
    const rej = await t.req("POST", `/api/v1/approvals/${req.body.id}/decide`, { token: owner, body: { decision: "reject", reason: "缺少回滚方案" } });
    expect(rej.body.status).toBe("rejected");
    const comments = await t.req("GET", `/api/v1/tasks/${a.id}/comments`, { token: owner });
    expect(comments.body.at(-1).body).toContain("缺少回滚方案");
    // A member lacks merge-approval rights even for someone else's request.
    const byOwner = await t.req("POST", `/api/v1/tasks/${a.id}/approvals`, { token: owner, body: { kind: "merge" } });
    const m = await t.req("POST", `/api/v1/approvals/${byOwner.body.id}/decide`, { token: member, body: { decision: "approve" } });
    expect(m.status).toBe(403);
    expect(m.body.details.required).toContain("Maintainer");
    // Timeout: expired, escalated, never approved (NTF-补3).
    const req3 = byOwner;
    await t.s.approvals.sweep(new Date(Date.now() + 14 * 86_400_000));
    const [row] = await t.s.db.root.select().from(approval).where(eq(approval.id, req3.body.id));
    expect(row!.status).toBe("expired");
    const maint = await join("mt@s3.test", "张维护");
    await t.req("PUT", `/api/v1/projects/${projectId}/members/${maint.principalId}`, { token: owner, body: { role: "maintainer" } });
    expect((await t.req("POST", `/api/v1/approvals/${req3.body.id}/decide`, { token: maint.token, body: { decision: "approve" } })).status).toBe(409);
  });

  test("NTF-补4: a new commit invalidates the approval", async () => {
    const a = await newTask();
    await setFacts(a.id, { ws: true });
    const req = await t.req("POST", `/api/v1/tasks/${a.id}/approvals`, { token: member, body: { kind: "merge" } });
    await t.s.db.root.update(workspace).set({ headCommit: "fff0000999" }).where(eq(workspace.taskId, a.id));
    const r = await t.req("POST", `/api/v1/approvals/${req.body.id}/decide`, { token: owner, body: { decision: "approve" } });
    expect(r.status).toBe(409);
    expect((await t.req("GET", `/api/v1/approvals/${req.body.id}`, { token: owner })).body.status).toBe("invalidated");
  });

  test("FR-NTF-03 + TSK-补10: blocked tasks escalate by working hours (owner → maintainer → admin)", async () => {
    const a = await newTask();
    await transition(a.id, "ready");
    await setFacts(a.id, { ws: true });
    await transition(a.id, "in_progress");
    await transition(a.id, "blocked", { reason: "等待第三方证书", needs: "王负责人" });
    // Move the blocked event to a known Monday 09:00 (+08:00) and sweep at Monday 15:00: 6 working hours → L1 only.
    await t.s.db.root
      .update(event)
      .set({ occurredAt: new Date("2026-11-16T01:00:00Z") })
      .where(eq(event.aggregateId, a.id));
    await t.s.approvals.sweep(new Date("2026-11-16T07:00:00Z"));
    let esc = await t.s.db.root.select().from(event).where(eq(event.aggregateId, a.id));
    expect(esc.filter((e) => e.type === "escalation.raised").map((e) => (e.payload as { level: number }).level)).toEqual([1]);
    // Friday-evening style gap: sweep a week later → L2 and L3 too.
    await t.s.approvals.sweep(new Date("2026-11-23T07:00:00Z"));
    esc = await t.s.db.root.select().from(event).where(eq(event.aggregateId, a.id));
    expect(esc.filter((e) => e.type === "escalation.raised").map((e) => (e.payload as { level: number }).level)).toEqual([1, 2, 3]);
    await t.s.consumers.drain();
    const items = await t.s.db.root.select().from(inboxItem).where(eq(inboxItem.kind, "escalation"));
    expect(items.length).toBeGreaterThan(0);
  });
});

void agent;
