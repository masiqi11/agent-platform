import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from "@ap/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../db";
import { agent, appUser, chatGroup, groupMember, module_, principal, project, projectMember, task } from "../../db/schema";
import type { Audit } from "../../core/audit";
import type { Ctx } from "../../core/context";
import { DomainError, conflict, invalid, notFound } from "../../core/errors";
import type { Events } from "../../core/events";
import { newId } from "../../core/ids";
import type { Identity } from "../identity/service";

type ProjectRole = "maintainer" | "member" | "viewer";
export interface ProjectDeps {
  db: Database;
  audit: Audit;
  events: Events;
  identity: Identity;
}

const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

/** Projects, members and module catalogue (FR-ORG-01/03/05/06). */
export function createProjects(d: ProjectDeps) {
  const { db } = d;

  const settingsOf = (p: typeof project.$inferSelect): ProjectSettings => ({ ...DEFAULT_PROJECT_SETTINGS, ...(p.settings as Partial<ProjectSettings>) });

  /** One transaction: project + main group + creator as Maintainer + project sub-captain + event + audit. */
  async function create(ctx: Ctx, input: { key: string; name: string; description?: string; defaultBranch?: string }) {
    await d.identity.require(ctx, "project.create");
    const key = input.key.trim().toUpperCase();
    if (!KEY_RE.test(key)) throw invalid("项目 key 格式不正确", [{ path: "/key", message: "2–10 位大写字母或数字，以字母开头" }]);
    const [dup] = await db.root
      .select({ id: project.id })
      .from(project)
      .where(and(eq(project.tenantId, ctx.tenantId), eq(project.key, key)));
    if (dup) throw conflict(`项目 key「${key}」已存在`);
    const id = newId("prj");
    const groupId = newId("grp");
    const agentId = newId("agt");
    const agentPrincipal = newId("prn");
    await db.tx(async (q) => {
      await q.insert(project).values({ id, tenantId: ctx.tenantId, key, name: input.name, description: input.description ?? "", defaultBranch: input.defaultBranch ?? "main", settings: {} });
      await q.insert(projectMember).values({ tenantId: ctx.tenantId, projectId: id, principalId: ctx.actor.principalId, role: "maintainer" });
      await q.insert(principal).values({ id: agentPrincipal, tenantId: ctx.tenantId, kind: "agent", refId: agentId, displayName: `${key} 船长` });
      await q.insert(agent).values({
        id: agentId,
        tenantId: ctx.tenantId,
        projectId: id,
        principalId: agentPrincipal,
        name: `${key} 船长`,
        role: "sub_captain",
        instructions: "你是本项目的船长：读懂群聊，维护带来源的摘要，提议任务与分配，回答项目问题。不写代码，不批准合并。",
        toolAllowlist: [],
      });
      await q.insert(projectMember).values({ tenantId: ctx.tenantId, projectId: id, principalId: agentPrincipal, role: "member" });
      await q.insert(chatGroup).values({ id: groupId, tenantId: ctx.tenantId, projectId: id, name: `${input.name} 主群`, kind: "main", captainAgentId: agentId });
      await q.insert(groupMember).values([
        { tenantId: ctx.tenantId, groupId, principalId: ctx.actor.principalId, role: "owner" },
        { tenantId: ctx.tenantId, groupId, principalId: agentPrincipal, role: "member" },
      ]);
      await d.events.emit(ctx, { type: "project.created", aggregateType: "project", aggregateId: id, payload: { projectId: id, key, mainGroupId: groupId, captainAgentId: agentId } });
      await d.events.emit(ctx, { type: "group.created", aggregateType: "group", aggregateId: groupId, payload: { projectId: id, groupId, kind: "main" } });
      await d.events.emit(ctx, { type: "agent.created", aggregateType: "agent", aggregateId: agentId, payload: { projectId: id, role: "sub_captain" } });
      await d.audit.write(ctx, { action: "project.create", resourceType: "project", resourceId: id, projectId: id, after: { key, name: input.name } });
    });
    return { id, key, mainGroupId: groupId, captainAgentId: agentId };
  }

  /** Projects the caller can see; tenant Owner/Admin/Auditor see all (§9.7). */
  async function list(ctx: Ctx) {
    const tr = ctx.actor.tenantRole;
    const all = tr === "owner" || tr === "admin" || tr === "auditor";
    const rows = all
      ? await db.root.select().from(project).where(eq(project.tenantId, ctx.tenantId)).orderBy(asc(project.createdAt))
      : await db.root
          .select({ p: project })
          .from(project)
          .innerJoin(projectMember, and(eq(projectMember.projectId, project.id), eq(projectMember.principalId, ctx.actor.principalId)))
          .where(eq(project.tenantId, ctx.tenantId))
          .orderBy(asc(project.createdAt))
          .then((r) => r.map((x) => x.p));
    if (rows.length === 0) return [];
    const ids = rows.map((p) => p.id);
    const taskCounts = await db.root
      .select({ projectId: task.projectId, status: task.status, n: sql<number>`count(*)::int` })
      .from(task)
      .where(inArray(task.projectId, ids))
      .groupBy(task.projectId, task.status);
    const agents = await db.root.select({ projectId: agent.projectId, id: agent.id, name: agent.name, role: agent.role, status: agent.status }).from(agent).where(inArray(agent.projectId, ids));
    const lastActivity = await db.root.execute<{ project_id: string; at: Date | null }>(
      sql`select g.project_id, max(m.created_at) as at from chat_group g left join message m on m.group_id = g.id where g.project_id in ${ids} group by g.project_id`,
    );
    const actMap = new Map((lastActivity as unknown as { rows: Array<{ project_id: string; at: string | null }> }).rows.map((r) => [r.project_id, r.at]));
    return rows.map((p) => {
      const counts = Object.fromEntries(taskCounts.filter((c) => c.projectId === p.id).map((c) => [c.status, c.n])) as Record<string, number>;
      const at = actMap.get(p.id);
      return {
        id: p.id,
        key: p.key,
        name: p.name,
        description: p.description,
        status: p.status,
        counts: {
          inProgress: counts.in_progress ?? 0,
          blocked: counts.blocked ?? 0,
          inReview: (counts.in_review ?? 0) + (counts.testing ?? 0),
          total: Object.values(counts).reduce((a, b) => a + b, 0),
        },
        agents: agents.filter((a) => a.projectId === p.id).map((a) => ({ id: a.id, name: a.name, role: a.role as string, status: a.status as string })),
        lastActivityAt: at ? new Date(at).toISOString() : null,
        createdAt: p.createdAt.toISOString(),
      };
    });
  }

  async function get(ctx: Ctx, id: string) {
    const p = await d.identity.projectInTenant(ctx, id);
    await d.identity.require(ctx, "project.view", { projectId: id });
    const groups = await db.root.select().from(chatGroup).where(eq(chatGroup.projectId, id)).orderBy(asc(chatGroup.createdAt));
    const sub = await d.identity.subjectFor(ctx, id);
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      description: p.description,
      defaultBranch: p.defaultBranch,
      status: p.status,
      settings: settingsOf(p) as unknown as Record<string, unknown>,
      mainGroupId: groups.find((g) => g.kind === "main")?.id ?? null,
      myRole: (sub.kind === "human" ? (sub.projectRole ?? null) : null) as string | null,
      canManage: (await d.identity.check(ctx, "project.update", { projectId: id })).allowed,
      createdAt: p.createdAt.toISOString(),
    };
  }

  async function assertWritable(ctx: Ctx, projectId: string) {
    const p = await d.identity.projectInTenant(ctx, projectId);
    if (p.status === "archived") throw new DomainError("conflict", "项目已归档，只读");
    return p;
  }

  async function update(ctx: Ctx, id: string, patch: { name?: string; description?: string; defaultBranch?: string; settings?: Partial<ProjectSettings> }) {
    const p = await assertWritable(ctx, id);
    await d.identity.require(ctx, "project.update", { projectId: id });
    const settings = patch.settings ? { ...(p.settings as object), ...patch.settings } : p.settings;
    await db.tx(async (q) => {
      await q
        .update(project)
        .set({ name: patch.name ?? p.name, description: patch.description ?? p.description, defaultBranch: patch.defaultBranch ?? p.defaultBranch, settings, updatedAt: new Date() })
        .where(eq(project.id, id));
      await d.events.emit(ctx, { type: "project.updated", aggregateType: "project", aggregateId: id, payload: { projectId: id } });
      await d.audit.write(ctx, {
        action: "project.update",
        resourceType: "project",
        resourceId: id,
        projectId: id,
        before: { name: p.name, description: p.description, settings: p.settings },
        after: patch,
      });
    });
    return { ok: true };
  }

  /** FR-ORG-06: active tasks must be finished/cancelled first. */
  async function archive(ctx: Ctx, id: string, reason: string) {
    await assertWritable(ctx, id);
    await d.identity.require(ctx, "project.update", { projectId: id });
    const active = await db.root
      .select({ id: task.id })
      .from(task)
      .where(and(eq(task.projectId, id), sql`${task.status} not in ('done','cancelled')`));
    if (active.length > 0) throw conflict(`还有 ${active.length} 个未结束的任务，请先完成或取消`, { taskIds: active.map((t) => t.id) });
    await db.tx(async (q) => {
      await q.update(project).set({ status: "archived", updatedAt: new Date() }).where(eq(project.id, id));
      await d.events.emit(ctx, { type: "project.archived", aggregateType: "project", aggregateId: id, payload: { projectId: id } });
      await d.audit.write(ctx, { action: "project.archive", resourceType: "project", resourceId: id, projectId: id, after: { reason } });
    });
    return { ok: true };
  }

  async function members(ctx: Ctx, projectId: string) {
    await d.identity.projectInTenant(ctx, projectId);
    await d.identity.require(ctx, "project.view", { projectId });
    const rows = await db.root
      .select({ principalId: projectMember.principalId, role: projectMember.role, name: principal.displayName, kind: principal.kind, refId: principal.refId })
      .from(projectMember)
      .innerJoin(principal, eq(principal.id, projectMember.principalId))
      .where(eq(projectMember.projectId, projectId))
      .orderBy(asc(projectMember.createdAt));
    const users = await db.root.select({ id: appUser.id, email: appUser.email, status: appUser.status }).from(appUser).where(eq(appUser.tenantId, ctx.tenantId));
    const agents = await db.root.select({ id: agent.id, role: agent.role, status: agent.status }).from(agent).where(eq(agent.projectId, projectId));
    return rows.map((r) => {
      const u = r.kind === "human" ? users.find((x) => x.id === r.refId) : undefined;
      const a = r.kind === "agent" ? agents.find((x) => x.id === r.refId) : undefined;
      return {
        principalId: r.principalId,
        name: r.name,
        kind: r.kind as string,
        role: r.role as string,
        email: u?.email ?? null,
        agentRole: (a?.role as string | undefined) ?? null,
        active: r.kind === "human" ? u?.status === "active" : a?.status === "active",
      };
    });
  }

  async function setMember(ctx: Ctx, projectId: string, principalId: string, role: ProjectRole | null) {
    await assertWritable(ctx, projectId);
    await d.identity.require(ctx, "project.update", { projectId });
    const [p] = await db.root
      .select()
      .from(principal)
      .where(and(eq(principal.id, principalId), eq(principal.tenantId, ctx.tenantId)));
    if (!p) throw notFound("成员");
    const [before] = await db.root
      .select()
      .from(projectMember)
      .where(and(eq(projectMember.projectId, projectId), eq(projectMember.principalId, principalId)));
    if (role === null && before?.role === "maintainer") {
      const maint = await db.root
        .select()
        .from(projectMember)
        .where(and(eq(projectMember.projectId, projectId), eq(projectMember.role, "maintainer")));
      if (maint.length <= 1) throw conflict("项目至少需要一位 Maintainer");
    }
    const groups = await db.root.select({ id: chatGroup.id, kind: chatGroup.kind }).from(chatGroup).where(eq(chatGroup.projectId, projectId));
    await db.tx(async (q) => {
      if (role === null) {
        await q.delete(projectMember).where(and(eq(projectMember.projectId, projectId), eq(projectMember.principalId, principalId)));
        for (const g of groups) await q.delete(groupMember).where(and(eq(groupMember.groupId, g.id), eq(groupMember.principalId, principalId)));
      } else {
        await q
          .insert(projectMember)
          .values({ tenantId: ctx.tenantId, projectId, principalId, role })
          .onConflictDoUpdate({ target: [projectMember.projectId, projectMember.principalId], set: { role } });
        const main = groups.find((g) => g.kind === "main");
        if (main) await q.insert(groupMember).values({ tenantId: ctx.tenantId, groupId: main.id, principalId }).onConflictDoNothing();
      }
      // member.changed revokes WS subscriptions immediately (§10.6).
      await d.events.emit(ctx, { type: "member.changed", aggregateType: "project", aggregateId: projectId, payload: { projectId, principalId, role } });
      await d.audit.write(ctx, {
        action: role ? "project.member_set" : "project.member_remove",
        resourceType: "project",
        resourceId: projectId,
        projectId,
        before: before ? { role: before.role } : null,
        after: { principalId, role },
      });
    });
    return { ok: true };
  }

  async function listModules(ctx: Ctx, projectId: string) {
    await d.identity.projectInTenant(ctx, projectId);
    await d.identity.require(ctx, "project.view", { projectId });
    const rows = await db.root.select().from(module_).where(eq(module_.projectId, projectId)).orderBy(asc(module_.name));
    return rows.map((m) => ({ id: m.id, name: m.name, path: m.path, repoId: m.repoId, ownerPrincipalId: m.ownerPrincipalId, dependsOn: m.dependsOn }));
  }

  async function upsertModule(ctx: Ctx, projectId: string, input: { id?: string; name: string; path: string; repoId?: string | null; ownerPrincipalId?: string | null; dependsOn?: string[] }) {
    await assertWritable(ctx, projectId);
    await d.identity.require(ctx, "project.update", { projectId });
    const id = input.id ?? newId("mod");
    await db.tx(async (q) => {
      if (input.id) {
        const r = await q
          .update(module_)
          .set({ name: input.name, path: input.path, repoId: input.repoId ?? null, ownerPrincipalId: input.ownerPrincipalId ?? null, dependsOn: input.dependsOn ?? [], updatedAt: new Date() })
          .where(and(eq(module_.id, input.id), eq(module_.projectId, projectId)))
          .returning();
        if (r.length === 0) throw notFound("模块");
      } else {
        await q.insert(module_).values({
          id,
          tenantId: ctx.tenantId,
          projectId,
          name: input.name,
          path: input.path,
          repoId: input.repoId ?? null,
          ownerPrincipalId: input.ownerPrincipalId ?? null,
          dependsOn: input.dependsOn ?? [],
        });
      }
      await d.audit.write(ctx, { action: input.id ? "module.update" : "module.create", resourceType: "module", resourceId: id, projectId, after: input });
    });
    return { id };
  }

  return { create, list, get, update, archive, members, setMember, listModules, upsertModule, assertWritable, settingsOf };
}
export type Projects = ReturnType<typeof createProjects>;
