import {
  DEFAULT_PROJECT_SETTINGS,
  GUARD_LABELS,
  REWORK_REVIEW_LIMIT,
  REWORK_TEST_LIMIT,
  STATUS_LABELS,
  checkTransition,
  emptyFacts,
  nextStatuses,
  type ProjectSettings,
  type TaskActorRole,
  type TaskFacts,
  type TaskStatus,
  type TransitionInput,
} from "@ap/shared";
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../db";
import {
  agent,
  approval,
  event,
  mergeQueueItem,
  principal,
  project,
  projectMember,
  review,
  task,
  taskComment,
  taskLink,
  taskOwner,
  testRun,
  workspace,
  type AcceptanceCriterion,
} from "../../db/schema";
import type { Audit } from "../../core/audit";
import type { Ctx } from "../../core/context";
import { DomainError, conflict, forbidden, invalid, notFound } from "../../core/errors";
import type { Events } from "../../core/events";
import { newId } from "../../core/ids";
import type { Identity } from "../identity/service";
import type { Projects } from "../projects/service";

type TaskRow = typeof task.$inferSelect;
type Priority = TaskRow["priority"];
type TaskType = TaskRow["type"];

export interface TaskDeps {
  db: Database;
  audit: Audit;
  events: Events;
  identity: Identity;
  projects: Projects;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  type?: TaskType;
  priority?: Priority;
  acceptanceCriteria?: Array<string | { text: string }>;
  dueAt?: string | null;
  assigneeAgentId?: string | null;
  ownerPrincipalIds?: string[];
  groupId?: string | null;
  sourceMessageIds?: string[];
  followUpOf?: string | null;
  /** Set when executing an accepted proposal: the human confirmed the captain's assignment. */
  viaProposalId?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  type?: TaskType;
  priority?: Priority;
  acceptanceCriteria?: AcceptanceCriterion[] | Array<{ id?: string; text: string; verdict?: AcceptanceCriterion["verdict"]; note?: string }>;
  dueAt?: string | null;
  assigneeAgentId?: string | null;
  testPlan?: Record<string, unknown> | null;
}

const normCriteria = (list: Array<string | { id?: string; text: string; verdict?: AcceptanceCriterion["verdict"]; note?: string }>): AcceptanceCriterion[] =>
  list
    .map((c) => (typeof c === "string" ? { text: c } : c))
    .filter((c) => c.text.trim())
    .map((c, i) => ({
      id: (c as { id?: string }).id ?? `ac${i + 1}`,
      text: c.text.trim(),
      ...((c as AcceptanceCriterion).verdict ? { verdict: (c as AcceptanceCriterion).verdict } : {}),
      ...((c as AcceptanceCriterion).note ? { note: (c as AcceptanceCriterion).note } : {}),
    }));

/**
 * Tasks (FR-TSK-01…06). `transition()` is the ONLY place that writes `task.status` (§12.6):
 * board drags, agent tools and the merge queue all call it. Illegal attempts are rejected,
 * audited as denied and emitted as `task.transition_denied` (INV-03).
 */
export function createTasks(d: TaskDeps) {
  const { db } = d;

  async function load(ctx: Ctx, id: string): Promise<TaskRow> {
    const [t] = await db.root
      .select()
      .from(task)
      .where(and(eq(task.id, id), eq(task.tenantId, ctx.tenantId)));
    if (!t) throw notFound("任务");
    return t;
  }

  async function readable(ctx: Ctx, id: string) {
    const t = await load(ctx, id);
    await d.identity.require(ctx, "project.view", { projectId: t.projectId });
    return t;
  }

  async function ownersOf(taskIds: string[]) {
    if (!taskIds.length) return [];
    return db.root
      .select({ taskId: taskOwner.taskId, principalId: taskOwner.principalId, role: taskOwner.role, name: principal.displayName, kind: principal.kind })
      .from(taskOwner)
      .innerJoin(principal, eq(principal.id, taskOwner.principalId))
      .where(inArray(taskOwner.taskId, taskIds));
  }

  async function settingsOf(projectId: string): Promise<ProjectSettings> {
    const [p] = await db.root.select({ settings: project.settings }).from(project).where(eq(project.id, projectId));
    return { ...DEFAULT_PROJECT_SETTINGS, ...((p?.settings ?? {}) as Partial<ProjectSettings>) };
  }

  /** Guard facts — one computation shared by the server check and the UI gate list (§12.6). */
  async function facts(t: TaskRow): Promise<TaskFacts> {
    const f = emptyFacts();
    const owners = await ownersOf([t.id]);
    const [ws] = await db.root.select().from(workspace).where(eq(workspace.taskId, t.id)).orderBy(desc(workspace.createdAt)).limit(1);
    const head = ws?.headCommit ?? null;
    const reviews = head
      ? await db.root
          .select()
          .from(review)
          .where(and(eq(review.taskId, t.id), eq(review.headSha, head), eq(review.superseded, false)))
          .orderBy(desc(review.createdAt))
      : [];
    const tests = head
      ? await db.root
          .select()
          .from(testRun)
          .where(and(eq(testRun.taskId, t.id), eq(testRun.headSha, head), eq(testRun.superseded, false)))
          .orderBy(desc(testRun.createdAt))
          .limit(1)
      : [];
    const approvals = head
      ? await db.root
          .select()
          .from(approval)
          .where(and(eq(approval.taskId, t.id), eq(approval.kind, "merge"), eq(approval.headSha, head), eq(approval.status, "approved")))
          .limit(1)
      : [];
    const [mq] = await db.root.select().from(mergeQueueItem).where(eq(mergeQueueItem.taskId, t.id));
    const blockers = await db.root
      .select({ status: task.status })
      .from(taskLink)
      .innerJoin(task, eq(task.id, taskLink.otherTaskId))
      .where(and(eq(taskLink.taskId, t.id), eq(taskLink.kind, "blocks")));
    const settings = await settingsOf(t.projectId);
    // Human reviewer verdict overrides the agent's (TSK-补5): the latest human review wins if present.
    const human = reviews.find((r) => r.reviewerKind === "human");
    const effective = human ?? reviews[0];
    f.hasTitle = t.title.trim().length > 0;
    f.hasAcceptanceCriteria = t.acceptanceCriteria.length > 0;
    f.hasAssignee = Boolean(t.assigneeAgentId);
    f.hasHumanOwner = owners.some((o) => o.role === "owner" && o.kind === "human");
    f.workspaceReady = ws?.status === "ready";
    f.mrOpened = Boolean(ws?.mrRef);
    f.ciPassed = ws?.ci?.status === "success" && ws.ci.sha === head;
    f.evidenceComplete = Boolean(ws?.diffStat) && f.ciPassed;
    f.reviewApproved = effective?.verdict === "approved";
    f.testPlanExists = Boolean(t.testPlan);
    f.testPassed = tests[0]?.status === "passed";
    f.merged = mq?.status === "merged";
    // Issue state is reconciled by the SCM sync (S5); the merge queue closes the issue as part of merging.
    f.issueClosed = f.merged;
    f.mergeApprovalRequired = settings.mergePolicy === "require_approval";
    f.mergeApproved = approvals.length > 0;
    f.openBlockers = blockers.filter((b) => b.status !== "done" && b.status !== "cancelled").length;
    return f;
  }

  /** Roles the actor holds relative to this task (server-computed; never trusted from the client). */
  async function rolesFor(ctx: Ctx, t: TaskRow): Promise<Set<TaskActorRole>> {
    const roles = new Set<TaskActorRole>();
    const a = ctx.actor;
    if (a.kind === "system") {
      roles.add("merge_queue");
      return roles;
    }
    if (a.kind === "agent") {
      const [ag] = await db.root.select().from(agent).where(eq(agent.principalId, a.principalId));
      if (!ag || ag.status !== "active") return roles;
      const [pm] = await db.root
        .select()
        .from(projectMember)
        .where(and(eq(projectMember.projectId, t.projectId), eq(projectMember.principalId, a.principalId)));
      if (!pm && ag.projectId !== t.projectId) return roles;
      if (ag.role === "dev" && t.assigneeAgentId === ag.id) roles.add("assignee_agent");
      if (ag.role === "reviewer") roles.add("reviewer_agent");
      if (ag.role === "tester") roles.add("tester_agent");
      // sub_captain / captain get nothing: they can only propose (INV-07).
      return roles;
    }
    const owners = await ownersOf([t.id]);
    if (owners.some((o) => o.principalId === a.principalId && o.role === "owner")) roles.add("human_owner");
    if (owners.some((o) => o.principalId === a.principalId && o.role === "reviewer")) roles.add("human_reviewer");
    const sub = await d.identity.subjectFor(ctx, t.projectId);
    if (sub.kind === "human" && (sub.projectRole === "maintainer" || sub.tenantRole === "owner")) {
      roles.add("maintainer");
      roles.add("human_reviewer");
    }
    return roles;
  }

  async function present(ctx: Ctx, rows: TaskRow[]) {
    if (!rows.length) return [];
    const [p] = await db.root.select({ key: project.key }).from(project).where(eq(project.id, rows[0]!.projectId));
    const owners = await ownersOf(rows.map((r) => r.id));
    const agentIds = rows.map((r) => r.assigneeAgentId).filter((x): x is string => Boolean(x));
    const agents = agentIds.length ? await db.root.select({ id: agent.id, name: agent.name, status: agent.status, principalId: agent.principalId }).from(agent).where(inArray(agent.id, agentIds)) : [];
    return rows.map((t) => {
      const ag = agents.find((a) => a.id === t.assigneeAgentId);
      return {
        id: t.id,
        projectId: t.projectId,
        ref: `${p?.key ?? "T"}-${t.number}`,
        number: t.number,
        title: t.title,
        description: t.description,
        type: t.type,
        priority: t.priority,
        status: t.status,
        assignee: ag ? { id: ag.id, name: ag.name, status: ag.status, principalId: ag.principalId } : null,
        owners: owners.filter((o) => o.taskId === t.id && o.role === "owner").map((o) => ({ principalId: o.principalId, name: o.name })),
        reviewers: owners.filter((o) => o.taskId === t.id && o.role === "reviewer").map((o) => ({ principalId: o.principalId, name: o.name })),
        acceptanceCriteria: t.acceptanceCriteria,
        testPlan: t.testPlan ?? null,
        dueAt: t.dueAt?.toISOString() ?? null,
        groupId: t.groupId,
        sourceMessageIds: t.sourceMessageIds,
        followUpOf: t.followUpOf,
        blockedReason: t.blockedReason,
        blockedNeeds: t.blockedNeeds,
        issueRef: t.issueRef,
        issueUrl: t.issueUrl,
        version: t.version,
        reworkReviewCount: t.reworkReviewCount,
        reworkTestCount: t.reworkTestCount,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      };
    });
  }

  async function validateAssignee(projectId: string, agentId: string | null | undefined) {
    if (!agentId) return;
    const [ag] = await db.root.select().from(agent).where(eq(agent.id, agentId));
    if (!ag || ag.projectId !== projectId) throw invalid("负责 Agent 不属于本项目", [{ path: "/assigneeAgentId", message: "无效" }]);
    if (ag.role !== "dev") throw invalid("只有开发 Agent 可以作为负责 Agent", [{ path: "/assigneeAgentId", message: "角色必须是开发" }]);
    if (ag.status === "disabled") throw invalid("该 Agent 已停用", [{ path: "/assigneeAgentId", message: "已停用" }]);
  }

  async function validateOwners(projectId: string, ids: string[]) {
    if (!ids.length) return;
    const rows = await db.root
      .select({ id: principal.id, kind: principal.kind })
      .from(projectMember)
      .innerJoin(principal, eq(principal.id, projectMember.principalId))
      .where(and(eq(projectMember.projectId, projectId), inArray(projectMember.principalId, ids)));
    const bad = ids.filter((id) => !rows.some((r) => r.id === id && r.kind === "human"));
    if (bad.length) throw invalid("owner 必须是本项目的人类成员", [{ path: "/ownerPrincipalIds", message: bad.join(",") }]);
  }

  async function create(ctx: Ctx, input: CreateTaskInput) {
    await d.projects.assertWritable(ctx, input.projectId);
    await d.identity.require(ctx, "task.create", { projectId: input.projectId });
    if (!input.title.trim()) throw invalid("标题不能为空", [{ path: "/title", message: "必填" }]);
    // INV-07: captains can only propose — never create tasks directly.
    if (ctx.actor.kind === "agent" && (ctx.actor.agentRole === "captain" || ctx.actor.agentRole === "sub_captain")) throw forbidden("人类确认", "船长只能提议，不能直接创建任务（INV-07）");
    if (input.assigneeAgentId && !input.viaProposalId) await d.identity.require(ctx, "task.assign", { projectId: input.projectId });
    await validateAssignee(input.projectId, input.assigneeAgentId);
    const owners = [...new Set(input.ownerPrincipalIds?.length ? input.ownerPrincipalIds : ctx.actor.kind === "human" ? [ctx.actor.principalId] : [])];
    await validateOwners(input.projectId, owners);
    const id = newId("tsk");
    const row = await db.tx(async (q) => {
      // Per-project numbering under a row lock: no duplicates under concurrency.
      await q.execute(sql`select id from project where id = ${input.projectId} for update`);
      const r = await q.execute<{ n: number }>(sql`select coalesce(max(number), 0)::int + 1 as n from task where project_id = ${input.projectId}`);
      const number = Number((r as unknown as { rows: Array<{ n: number }> }).rows[0]!.n);
      const [t] = await q
        .insert(task)
        .values({
          id,
          tenantId: ctx.tenantId,
          projectId: input.projectId,
          groupId: input.groupId ?? null,
          number,
          title: input.title.trim(),
          description: input.description ?? "",
          type: input.type ?? "feature",
          priority: input.priority ?? "P2",
          acceptanceCriteria: normCriteria(input.acceptanceCriteria ?? []),
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          assigneeAgentId: input.assigneeAgentId ?? null,
          sourceMessageIds: input.sourceMessageIds ?? [],
          followUpOf: input.followUpOf ?? null,
          createdBy: ctx.actor.principalId,
        })
        .returning();
      for (const pid of owners) await q.insert(taskOwner).values({ taskId: id, principalId: pid, role: "owner" });
      if (input.followUpOf) await q.insert(taskLink).values({ taskId: id, otherTaskId: input.followUpOf, kind: "follow_up" });
      await d.events.emit(ctx, {
        type: "task.created",
        aggregateType: "task",
        aggregateId: id,
        payload: { projectId: input.projectId, taskId: id, groupId: input.groupId ?? null, inboxPrincipalIds: owners },
      });
      if (input.assigneeAgentId)
        await d.events.emit(ctx, {
          type: "task.assigned",
          aggregateType: "task",
          aggregateId: id,
          payload: { projectId: input.projectId, taskId: id, agentId: input.assigneeAgentId, previousAgentId: null },
        });
      await d.audit.write(ctx, {
        action: "task.create",
        resourceType: "task",
        resourceId: id,
        projectId: input.projectId,
        after: { number, title: t!.title, owners, assignee: input.assigneeAgentId ?? null, sourceMessageIds: input.sourceMessageIds ?? [] },
        policy: input.viaProposalId ? { viaProposalId: input.viaProposalId } : {},
      });
      return t!;
    });
    return (await present(ctx, [row]))[0]!;
  }

  async function get(ctx: Ctx, id: string) {
    const t = await readable(ctx, id);
    const f = await facts(t);
    const roles = await rolesFor(ctx, t);
    const p = (await present(ctx, [t]))[0]!;
    return {
      ...p,
      facts: f,
      myRoles: [...roles],
      allowed: nextStatuses(t.status as TaskStatus)
        .map((to) => ({ to, check: checkTransition(t.status as TaskStatus, to, roles, f, { reason: "x", needs: "x", evidenceArtifactId: "x" }) }))
        .map((x) => ({ to: x.to, ok: x.check.ok, reason: x.check.ok ? null : x.check.reason, missing: x.check.ok ? [] : x.check.missing })),
    };
  }

  async function list(ctx: Ctx, projectId: string, f: { status?: string; assigneeAgentId?: string; ownerPrincipalId?: string; priority?: string; q?: string; groupId?: string } = {}) {
    await d.identity.projectInTenant(ctx, projectId);
    await d.identity.require(ctx, "project.view", { projectId });
    const cond: SQL[] = [eq(task.projectId, projectId)];
    if (f.status) cond.push(inArray(task.status, f.status.split(",") as TaskRow["status"][]));
    if (f.assigneeAgentId) cond.push(eq(task.assigneeAgentId, f.assigneeAgentId));
    if (f.priority) cond.push(inArray(task.priority, f.priority.split(",") as Priority[]));
    if (f.groupId) cond.push(eq(task.groupId, f.groupId));
    if (f.q) cond.push(sql`(${task.title} ilike ${"%" + f.q + "%"} or ${task.number}::text = ${f.q.replace(/^\D+-/, "")})`);
    if (f.ownerPrincipalId) cond.push(sql`exists (select 1 from task_owner o where o.task_id = ${task.id} and o.principal_id = ${f.ownerPrincipalId})`);
    const rows = await db.root
      .select()
      .from(task)
      .where(and(...cond))
      .orderBy(asc(sql`case ${task.priority} when 'P0' then 0 when 'P1' then 1 when 'P2' then 2 else 3 end`), desc(task.updatedAt))
      .limit(500);
    return present(ctx, rows);
  }

  function checkVersion(t: TaskRow, ifMatch?: string | null) {
    if (ifMatch === undefined || ifMatch === null || ifMatch === "") return;
    const v = Number(String(ifMatch).replace(/^W\//, "").replace(/"/g, ""));
    if (!Number.isFinite(v) || v !== t.version) throw new DomainError("conflict", "任务已被他人修改，请刷新后重试", { currentVersion: t.version });
  }

  async function update(ctx: Ctx, id: string, patch: UpdateTaskInput, ifMatch?: string | null) {
    const t = await load(ctx, id);
    await d.projects.assertWritable(ctx, t.projectId);
    await d.identity.require(ctx, "task.create", { projectId: t.projectId });
    checkVersion(t, ifMatch);
    if (t.status === "done" || t.status === "cancelled") throw conflict("任务已结束，不能修改；请创建后续任务");
    const roles = await rolesFor(ctx, t);
    const reassign = patch.assigneeAgentId !== undefined && patch.assigneeAgentId !== t.assigneeAgentId;
    if (reassign) {
      await d.identity.require(ctx, "task.assign", { projectId: t.projectId });
      // Mid-flight reassignment needs an owner or maintainer (TSK-补3).
      if (!["backlog", "ready"].includes(t.status) && !roles.has("human_owner") && !roles.has("maintainer")) throw forbidden("任务 owner 或 Maintainer", "进行中的任务改派需要 owner 或 Maintainer");
      if (patch.assigneeAgentId === null && t.status !== "backlog") throw invalid("进入就绪后必须有负责 Agent（INV-02）", [{ path: "/assigneeAgentId", message: "不能为空" }]);
      await validateAssignee(t.projectId, patch.assigneeAgentId);
    }
    if (patch.acceptanceCriteria && patch.acceptanceCriteria.length === 0 && t.status !== "backlog")
      throw invalid("就绪后的任务必须保留验收标准", [{ path: "/acceptanceCriteria", message: "不能为空" }]);
    const next = {
      title: patch.title?.trim() ?? t.title,
      description: patch.description ?? t.description,
      type: patch.type ?? t.type,
      priority: patch.priority ?? t.priority,
      acceptanceCriteria: patch.acceptanceCriteria ? normCriteria(patch.acceptanceCriteria) : t.acceptanceCriteria,
      dueAt: patch.dueAt === undefined ? t.dueAt : patch.dueAt ? new Date(patch.dueAt) : null,
      assigneeAgentId: patch.assigneeAgentId === undefined ? t.assigneeAgentId : patch.assigneeAgentId,
      testPlan: patch.testPlan === undefined ? t.testPlan : patch.testPlan,
    };
    if (!next.title) throw invalid("标题不能为空", [{ path: "/title", message: "必填" }]);
    const row = await db.tx(async (q) => {
      const [u] = await q
        .update(task)
        .set({ ...next, version: t.version + 1, updatedAt: new Date() })
        .where(and(eq(task.id, id), eq(task.version, t.version)))
        .returning();
      if (!u) throw new DomainError("conflict", "任务已被他人修改，请刷新后重试");
      await d.events.emit(ctx, { type: "task.updated", aggregateType: "task", aggregateId: id, payload: { projectId: t.projectId, taskId: id, fields: Object.keys(patch) } });
      if (reassign)
        await d.events.emit(ctx, {
          type: "task.assigned",
          aggregateType: "task",
          aggregateId: id,
          payload: { projectId: t.projectId, taskId: id, agentId: next.assigneeAgentId, previousAgentId: t.assigneeAgentId },
        });
      await d.audit.write(ctx, { action: reassign ? "task.reassign" : "task.update", resourceType: "task", resourceId: id, projectId: t.projectId, before: pick(t, Object.keys(patch)), after: patch });
      return u;
    });
    return (await present(ctx, [row]))[0]!;
  }

  /** The single status-write entry point (§12.6). */
  async function transition(ctx: Ctx, id: string, to: TaskStatus, input: TransitionInput = {}, opts: { ifMatch?: string | null; viaProposalId?: string } = {}) {
    const t = await load(ctx, id);
    await d.identity.require(ctx, "project.view", { projectId: t.projectId });
    await d.projects.assertWritable(ctx, t.projectId);
    checkVersion(t, opts.ifMatch);
    const from = t.status as TaskStatus;
    const roles = await rolesFor(ctx, t);
    // Members may cancel only tasks they own; maintainers any (§9.7) — encoded via roles.
    const f = await facts(t);
    const check = checkTransition(from, to, roles, f, input);
    const policy = { rule: check.ok ? `${check.rule.from}->${check.rule.to}` : null, roles: [...roles], missing: check.ok ? [] : check.missing, viaProposalId: opts.viaProposalId ?? null };
    if (!check.ok) {
      await d.events.emit(ctx, {
        type: "task.transition_denied",
        aggregateType: "task",
        aggregateId: id,
        payload: { projectId: t.projectId, taskId: id, from, to, code: check.code, missing: check.missing },
      });
      await d.audit.write(ctx, {
        action: "task.transition",
        resourceType: "task",
        resourceId: id,
        projectId: t.projectId,
        before: { status: from },
        after: { status: to, reason: check.reason },
        policy,
        outcome: "denied",
      });
      throw new DomainError("illegal_transition", check.reason, { code: check.code, from, to, missing: check.missing, missingLabels: check.missing.map((m) => GUARD_LABELS[m]) });
    }
    let finalTo: TaskStatus = to;
    const set: Partial<TaskRow> = { status: to, version: t.version + 1, updatedAt: new Date() };
    if (to === "blocked") Object.assign(set, { blockedReason: input.reason!.trim(), blockedNeeds: input.needs!.trim() });
    if (from === "blocked") Object.assign(set, { blockedReason: null, blockedNeeds: null });
    if (from === "in_review" && to === "in_progress") set.reworkReviewCount = t.reworkReviewCount + 1;
    if (from === "testing" && to === "in_progress") set.reworkTestCount = t.reworkTestCount + 1;
    // Rework limit: too many round trips → blocked + escalate to the human owner (TSK-补4).
    if ((set.reworkReviewCount ?? 0) > REWORK_REVIEW_LIMIT || (set.reworkTestCount ?? 0) > REWORK_TEST_LIMIT) {
      finalTo = "blocked";
      Object.assign(set, { status: "blocked", blockedReason: "返工超限", blockedNeeds: "人类 owner" });
    }
    const row = await db.tx(async (q) => {
      const [u] = await q
        .update(task)
        .set(set)
        .where(and(eq(task.id, id), eq(task.version, t.version), eq(task.status, from)))
        .returning();
      if (!u) throw new DomainError("conflict", "任务状态已被他人修改，请刷新后重试");
      const owners = (await ownersOf([id])).filter((o) => o.role === "owner").map((o) => o.principalId);
      await d.events.emit(ctx, {
        type: "task.status_changed",
        aggregateType: "task",
        aggregateId: id,
        payload: {
          projectId: t.projectId,
          taskId: id,
          from,
          to: finalTo,
          actorKind: ctx.actor.kind,
          reason: input.reason ?? null,
          policy,
          inboxPrincipalIds: owners.filter((o) => o !== ctx.actor.principalId),
        },
      });
      await d.audit.write(ctx, {
        action: "task.transition",
        resourceType: "task",
        resourceId: id,
        projectId: t.projectId,
        before: { status: from },
        after: { status: finalTo, reason: input.reason ?? null, needs: input.needs ?? null },
        policy,
      });
      if (finalTo !== to)
        await d.events.emit(ctx, {
          type: "escalation.raised",
          aggregateType: "task",
          aggregateId: id,
          payload: { projectId: t.projectId, taskId: id, level: 1, reason: "返工超限", inboxPrincipalIds: owners },
        });
      return u;
    });
    return { task: (await present(ctx, [row]))[0]!, status: finalTo, label: STATUS_LABELS[finalTo] };
  }

  async function setOwner(ctx: Ctx, id: string, principalId: string, role: "owner" | "reviewer", add: boolean) {
    const t = await load(ctx, id);
    await d.projects.assertWritable(ctx, t.projectId);
    const roles = await rolesFor(ctx, t);
    if (!roles.has("human_owner") && !roles.has("maintainer")) throw forbidden("任务 owner 或 Maintainer");
    if (add) await validateOwners(t.projectId, [principalId]);
    await db.tx(async (q) => {
      if (add) await q.insert(taskOwner).values({ taskId: id, principalId, role }).onConflictDoNothing();
      else {
        if (role === "owner") {
          const owners = (await ownersOf([id])).filter((o) => o.role === "owner");
          // Never leave a task without a human owner (INV-02, TSK-补6).
          if (owners.length <= 1 && owners[0]?.principalId === principalId) throw conflict("不能移除最后一个人类 owner，请先指定继任者");
        }
        await q.delete(taskOwner).where(and(eq(taskOwner.taskId, id), eq(taskOwner.principalId, principalId), eq(taskOwner.role, role)));
      }
      await d.events.emit(ctx, {
        type: "task.updated",
        aggregateType: "task",
        aggregateId: id,
        payload: { projectId: t.projectId, taskId: id, fields: [role + "s"], inboxPrincipalIds: add ? [principalId] : [] },
      });
      await d.audit.write(ctx, { action: add ? "task.owner_add" : "task.owner_remove", resourceType: "task", resourceId: id, projectId: t.projectId, after: { principalId, role } });
    });
    return { ok: true as const };
  }

  async function comment(ctx: Ctx, id: string, body: string) {
    const t = await readable(ctx, id);
    await d.projects.assertWritable(ctx, t.projectId);
    await d.identity.require(ctx, "message.send", { projectId: t.projectId });
    if (!body.trim()) throw invalid("评论不能为空", [{ path: "/body", message: "必填" }]);
    const cid = newId("tcm");
    await db.tx(async (q) => {
      await q.insert(taskComment).values({ id: cid, tenantId: ctx.tenantId, taskId: id, authorPrincipalId: ctx.actor.principalId, body });
      const owners = (await ownersOf([id])).filter((o) => o.role === "owner" && o.principalId !== ctx.actor.principalId).map((o) => o.principalId);
      await d.events.emit(ctx, { type: "task.comment_added", aggregateType: "task", aggregateId: id, payload: { projectId: t.projectId, taskId: id, commentId: cid, inboxPrincipalIds: owners } });
      await d.audit.write(ctx, { action: "task.comment", resourceType: "task", resourceId: id, projectId: t.projectId, after: { commentId: cid } });
    });
    return { id: cid };
  }

  async function comments(ctx: Ctx, id: string) {
    await readable(ctx, id);
    const rows = await db.root
      .select({ id: taskComment.id, body: taskComment.body, createdAt: taskComment.createdAt, authorPrincipalId: taskComment.authorPrincipalId, name: principal.displayName, kind: principal.kind })
      .from(taskComment)
      .innerJoin(principal, eq(principal.id, taskComment.authorPrincipalId))
      .where(eq(taskComment.taskId, id))
      .orderBy(asc(taskComment.createdAt));
    return rows.map((r) => ({ id: r.id, body: r.body, author: { principalId: r.authorPrincipalId, name: r.name, kind: r.kind }, createdAt: r.createdAt.toISOString() }));
  }

  /** "Reopen" after done = a linked follow-up task inheriting owners (TSK-补1). */
  async function followUp(ctx: Ctx, id: string, input: { title?: string; description?: string }) {
    const t = await readable(ctx, id);
    const owners = (await ownersOf([id])).filter((o) => o.role === "owner").map((o) => o.principalId);
    const [p] = await db.root.select({ key: project.key }).from(project).where(eq(project.id, t.projectId));
    return create(ctx, {
      projectId: t.projectId,
      title: input.title ?? `后续：${t.title}`,
      description: input.description ?? `源自 ${p?.key}-${t.number}`,
      type: t.type,
      priority: t.priority,
      ownerPrincipalIds: owners,
      groupId: t.groupId,
      followUpOf: t.id,
      acceptanceCriteria: [],
    });
  }

  /** Task timeline (OBS-补2): every event about the task, oldest first. */
  async function timeline(ctx: Ctx, id: string) {
    const t = await readable(ctx, id);
    const rows = await db.root
      .select({ seq: event.seq, type: event.type, payload: event.payload, actor: event.actorPrincipalId, createdAt: event.occurredAt, name: principal.displayName, kind: principal.kind })
      .from(event)
      .leftJoin(principal, eq(principal.id, event.actorPrincipalId))
      .where(and(eq(event.tenantId, ctx.tenantId), or(eq(event.aggregateId, id), sql`${event.payload}->>'taskId' = ${id}`)))
      .orderBy(asc(event.seq))
      .limit(1000);
    void t;
    return rows.map((r) => ({
      seq: r.seq,
      type: r.type,
      payload: r.payload as Record<string, unknown>,
      actor: { principalId: r.actor, name: r.name ?? "系统", kind: r.kind ?? "system" },
      createdAt: r.createdAt.toISOString(),
    }));
  }

  return { create, get, list, update, transition, setOwner, comment, comments, followUp, timeline, facts, rolesFor, load, present, ownersOf };
}

function pick(row: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, row[k]]));
}

export type Tasks = ReturnType<typeof createTasks>;
