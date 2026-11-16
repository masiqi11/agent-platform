import { DEFAULT_WORKING_HOURS, addWorkingMs, workingMsBetween, type WorkingHours } from "@ap/shared";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../../db";
import { approval, escalation, event, principal, task, tenant, workspace } from "../../db/schema";
import type { Audit } from "../../core/audit";
import type { Ctx } from "../../core/context";
import { DomainError, conflict, forbidden, invalid, notFound } from "../../core/errors";
import type { Events } from "../../core/events";
import { newId } from "../../core/ids";
import type { Identity } from "../identity/service";
import type { Inbox } from "../inbox/service";
import type { Projects } from "../projects/service";
import type { Tasks } from "../tasks/service";

type Row = typeof approval.$inferSelect;
type Kind = Row["kind"];
const H = 3_600_000;
/** Approval windows in working hours. Timeout escalates; nothing ever auto-approves (NTF-补3). */
const TTL_WORKING_H: Record<Kind, number> = { merge: 8, release: 8, credential: 16, budget: 8 };
/** Blocked-task escalation ladder in working hours: owner → maintainer → tenant admin (FR-NTF-03). */
export const ESCALATION_LADDER_H = [4, 8, 16] as const;

export interface ApprovalDeps {
  db: Database;
  audit: Audit;
  events: Events;
  identity: Identity;
  projects: Projects;
  tasks: Tasks;
  inbox: Inbox;
}

export function createApprovals(d: ApprovalDeps) {
  const { db } = d;

  async function tenantClock(tenantId: string): Promise<{ tz: string; wh: WorkingHours }> {
    const [t] = await db.root.select({ tz: tenant.timezone, settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
    const wh = ((t?.settings as { workingHours?: WorkingHours } | undefined)?.workingHours ?? DEFAULT_WORKING_HOURS) as WorkingHours;
    return { tz: t?.tz ?? "Asia/Shanghai", wh };
  }

  async function load(ctx: Ctx, id: string) {
    const [a] = await db.root
      .select()
      .from(approval)
      .where(and(eq(approval.id, id), eq(approval.tenantId, ctx.tenantId)));
    if (!a) throw notFound("审批");
    return a;
  }

  async function currentHead(taskId: string) {
    const [ws] = await db.root.select({ head: workspace.headCommit }).from(workspace).where(eq(workspace.taskId, taskId)).orderBy(desc(workspace.createdAt)).limit(1);
    return ws?.head ?? null;
  }

  async function present(rows: Row[]) {
    const ids = [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy].filter((x): x is string => Boolean(x))))];
    const names = ids.length ? await db.root.select({ id: principal.id, name: principal.displayName }).from(principal).where(inArray(principal.id, ids)) : [];
    const nm = (id: string | null) => (id ? (names.find((n) => n.id === id)?.name ?? null) : null);
    return rows.map((a) => ({
      id: a.id,
      taskId: a.taskId,
      kind: a.kind,
      status: a.status,
      headSha: a.headSha,
      requestedBy: { principalId: a.requestedBy, name: nm(a.requestedBy) },
      decidedBy: a.decidedBy ? { principalId: a.decidedBy, name: nm(a.decidedBy) } : null,
      decidedAt: a.decidedAt?.toISOString() ?? null,
      reason: a.reason,
      rejectTo: a.rejectTo,
      evidence: a.evidence,
      expiresAt: a.expiresAt.toISOString(),
      escalatedAt: a.escalatedAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
    }));
  }

  async function request(ctx: Ctx, taskId: string, input: { kind: Kind; evidence?: Record<string, unknown>; headSha?: string | null }) {
    const t = await d.tasks.load(ctx, taskId);
    await d.identity.require(ctx, "project.view", { projectId: t.projectId });
    await d.projects.assertWritable(ctx, t.projectId);
    const headSha = input.headSha ?? (input.kind === "merge" ? await currentHead(taskId) : null);
    const [dup] = await db.root
      .select()
      .from(approval)
      .where(and(eq(approval.taskId, taskId), eq(approval.kind, input.kind), eq(approval.status, "pending")));
    if (dup && dup.headSha === headSha) return (await present([dup]))[0]!;
    const { tz, wh } = await tenantClock(ctx.tenantId);
    const id = newId("apv");
    const [row] = await db.tx(async (q) => {
      // A newer request for the same task/kind supersedes the old pending one.
      if (dup) await q.update(approval).set({ status: "invalidated", reason: "被新的申请取代" }).where(eq(approval.id, dup.id));
      const r = await q
        .insert(approval)
        .values({
          id,
          tenantId: ctx.tenantId,
          taskId,
          kind: input.kind,
          headSha,
          requestedBy: ctx.actor.principalId,
          evidence: input.evidence ?? {},
          expiresAt: addWorkingMs(new Date(), TTL_WORKING_H[input.kind] * H, tz, wh),
        })
        .returning();
      await d.events.emit(ctx, { type: "approval.requested", aggregateType: "approval", aggregateId: id, payload: { projectId: t.projectId, taskId, approvalId: id, kind: input.kind } });
      await d.audit.write(ctx, { action: "approval.request", resourceType: "approval", resourceId: id, projectId: t.projectId, after: { kind: input.kind, headSha } });
      return r;
    });
    return (await present([row!]))[0]!;
  }

  /** Humans only; never the requester (INV-09); bound to a commit (NTF-补4); reject needs a reason (NTF-补2). */
  async function decide(ctx: Ctx, id: string, input: { decision: "approve" | "reject"; reason?: string; rejectTo?: "in_progress" | "blocked" }) {
    const a = await load(ctx, id);
    const t = await d.tasks.load(ctx, a.taskId);
    const deny = async (msg: string, required: string) => {
      await d.audit.write(ctx, { action: "approval.decide", resourceType: "approval", resourceId: id, projectId: t.projectId, after: { decision: input.decision, reason: msg }, outcome: "denied" });
      return forbidden(required, msg);
    };
    if (ctx.actor.kind !== "human") throw await deny("审批只能由人类做出（INV-09）", "人类审批人");
    if (a.requestedBy === ctx.actor.principalId) throw await deny("申请人不能审批自己的申请（INV-09）", "申请人以外的审批人");
    const action = a.kind === "merge" ? "merge.approve" : a.kind === "release" ? "release.approve" : "approval.decide_budget_credential";
    const dec = await d.identity.check(ctx, action, { projectId: t.projectId });
    if (!dec.allowed) throw await deny("没有该类审批的权限", dec.required);
    if (a.status !== "pending") throw conflict(`审批已${{ approved: "通过", rejected: "拒绝", expired: "过期", invalidated: "失效", pending: "" }[a.status]}`);
    if (a.expiresAt < new Date()) throw conflict("审批已超时，已升级处理；请重新发起");
    if (input.decision === "reject" && !input.reason?.trim()) throw invalid("拒绝必须填写原因", [{ path: "/reason", message: "必填" }]);
    if (a.kind === "merge" && a.headSha) {
      const head = await currentHead(a.taskId);
      if (head && head !== a.headSha) {
        await invalidate(ctx, a.taskId, head);
        throw new DomainError("conflict", "该审批针对的提交已过时（有新提交），审批已失效");
      }
    }
    const status = input.decision === "approve" ? "approved" : "rejected";
    const [row] = await db.tx(async (q) => {
      const r = await q
        .update(approval)
        .set({ status, decidedBy: ctx.actor.principalId, decidedAt: new Date(), reason: input.reason ?? null, rejectTo: input.decision === "reject" ? (input.rejectTo ?? "in_progress") : null })
        .where(and(eq(approval.id, id), eq(approval.status, "pending")))
        .returning();
      if (!r.length) throw conflict("审批已被处理");
      const owners = (await d.tasks.ownersOf([a.taskId])).filter((o) => o.role === "owner").map((o) => o.principalId);
      await d.events.emit(ctx, {
        type: "approval.decided",
        aggregateType: "approval",
        aggregateId: id,
        payload: {
          projectId: t.projectId,
          taskId: a.taskId,
          approvalId: id,
          kind: a.kind,
          status,
          reason: input.reason ?? null,
          rejectTo: r[0]!.rejectTo,
          inboxPrincipalIds: [...owners, a.requestedBy],
        },
      });
      await d.audit.write(ctx, {
        action: "approval.decide",
        resourceType: "approval",
        resourceId: id,
        projectId: t.projectId,
        after: { decision: status, reason: input.reason ?? null, headSha: a.headSha },
      });
      return r;
    });
    // NTF-补2: the reason goes back to the task (as a comment) so it is visible where work happens.
    if (status === "rejected") await d.tasks.comment(ctx, a.taskId, `审批被拒绝（${a.kind}）：${input.reason}`);
    return (await present([row!]))[0]!;
  }

  /** New commits invalidate pending/approved merge approvals for older heads (NTF-补4). */
  async function invalidate(ctx: Ctx, taskId: string, newHead: string) {
    const rows = await db.root
      .update(approval)
      .set({ status: "invalidated", reason: `新提交 ${newHead.slice(0, 8)} 使审批失效` })
      .where(and(eq(approval.taskId, taskId), eq(approval.kind, "merge"), inArray(approval.status, ["pending", "approved"]), sql`coalesce(${approval.headSha}, '') <> ${newHead}`))
      .returning();
    for (const r of rows) await d.events.emit(ctx, { type: "approval.invalidated", aggregateType: "approval", aggregateId: r.id, payload: { taskId, approvalId: r.id, newHead } });
    return rows.length;
  }

  async function list(ctx: Ctx, f: { taskId?: string; mine?: boolean }) {
    if (f.taskId) {
      const t = await d.tasks.load(ctx, f.taskId);
      await d.identity.require(ctx, "project.view", { projectId: t.projectId });
      return present(await db.root.select().from(approval).where(eq(approval.taskId, f.taskId)).orderBy(desc(approval.createdAt)));
    }
    const rows = await db.root
      .select({ a: approval })
      .from(approval)
      .where(and(eq(approval.tenantId, ctx.tenantId), eq(approval.status, "pending")))
      .orderBy(desc(approval.createdAt))
      .limit(200);
    const out: Row[] = [];
    for (const { a } of rows) {
      const t = await d.tasks.load(ctx, a.taskId);
      const action = a.kind === "merge" ? "merge.approve" : a.kind === "release" ? "release.approve" : "approval.decide_budget_credential";
      if ((await d.identity.check(ctx, action, { projectId: t.projectId })).allowed && a.requestedBy !== ctx.actor.principalId) out.push(a);
    }
    return present(out);
  }

  async function get(ctx: Ctx, id: string) {
    const a = await load(ctx, id);
    const t = await d.tasks.load(ctx, a.taskId);
    await d.identity.require(ctx, "project.view", { projectId: t.projectId });
    return (await present([a]))[0]!;
  }

  async function raise(ctx: Ctx, input: { taskId: string; projectId: string; level: number; reason: string; targets: string[] }) {
    const [exists] = await db.root
      .select({ id: escalation.id })
      .from(escalation)
      .where(and(eq(escalation.taskId, input.taskId), eq(escalation.level, input.level), sql`${escalation.acknowledgedAt} is null`, sql`${escalation.reason} = ${input.reason}`));
    if (exists || !input.targets.length) return false;
    await db.tx(async (q) => {
      for (const target of input.targets)
        await q.insert(escalation).values({ id: newId("esc"), tenantId: ctx.tenantId, taskId: input.taskId, level: input.level, reason: input.reason, targetPrincipalId: target });
      await d.events.emit(ctx, {
        type: "escalation.raised",
        aggregateType: "task",
        aggregateId: input.taskId,
        payload: { projectId: input.projectId, taskId: input.taskId, level: input.level, reason: input.reason, inboxPrincipalIds: input.targets },
      });
      await d.audit.write(ctx, {
        action: "escalation.raise",
        resourceType: "task",
        resourceId: input.taskId,
        projectId: input.projectId,
        after: { level: input.level, reason: input.reason, targets: input.targets },
      });
    });
    return true;
  }

  async function ladderTargets(tenantId: string, projectId: string, taskId: string, level: number) {
    if (level === 1) return (await d.tasks.ownersOf([taskId])).filter((o) => o.role === "owner").map((o) => o.principalId);
    if (level === 2) return d.inbox.maintainers(projectId);
    return d.inbox.tenantRoles(tenantId, ["owner", "admin"]);
  }

  /**
   * Timers (FR-NTF-03, NTF-补3, TSK-补10): expired approvals → `expired` + escalate (never approve);
   * blocked tasks climb the ladder by working hours in the tenant's timezone.
   */
  async function sweep(now = new Date()) {
    let expired = 0;
    let escalated = 0;
    const due = await db.root
      .select()
      .from(approval)
      .where(and(eq(approval.status, "pending"), lt(approval.expiresAt, now)));
    for (const a of due) {
      const ctx = await d.identity.systemCtx(a.tenantId);
      const [t] = await db.root.select().from(task).where(eq(task.id, a.taskId));
      if (!t) continue;
      const r = await db.root
        .update(approval)
        .set({ status: "expired", escalatedAt: now })
        .where(and(eq(approval.id, a.id), eq(approval.status, "pending")))
        .returning();
      if (!r.length) continue;
      expired++;
      await d.audit.write(ctx, { action: "approval.expire", resourceType: "approval", resourceId: a.id, projectId: t.projectId, after: { kind: a.kind } });
      const level = a.kind === "merge" || a.kind === "release" ? 2 : 3;
      if (await raise(ctx, { taskId: t.id, projectId: t.projectId, level, reason: `审批超时（${a.kind}）`, targets: await ladderTargets(a.tenantId, t.projectId, t.id, level) })) escalated++;
    }
    const blocked = await db.root.select().from(task).where(eq(task.status, "blocked"));
    for (const t of blocked) {
      const [since] = await db.root
        .select({ at: event.occurredAt })
        .from(event)
        .where(and(eq(event.aggregateId, t.id), eq(event.type, "task.status_changed"), sql`${event.payload}->>'to' = 'blocked'`))
        .orderBy(desc(event.seq))
        .limit(1);
      if (!since) continue;
      const { tz, wh } = await tenantClock(t.tenantId);
      const elapsed = workingMsBetween(since.at, now, tz, wh);
      const ctx = await d.identity.systemCtx(t.tenantId);
      for (let i = 0; i < ESCALATION_LADDER_H.length; i++) {
        if (elapsed < ESCALATION_LADDER_H[i]! * H) break;
        if (
          await raise(ctx, {
            taskId: t.id,
            projectId: t.projectId,
            level: i + 1,
            reason: `阻塞超过 ${ESCALATION_LADDER_H[i]} 个工作小时：${t.blockedReason ?? ""}`,
            targets: await ladderTargets(t.tenantId, t.projectId, t.id, i + 1),
          })
        )
          escalated++;
      }
    }
    return { expired, escalated };
  }

  return { request, decide, invalidate, list, get, sweep, raise };
}

export type Approvals = ReturnType<typeof createApprovals>;
