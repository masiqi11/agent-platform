import { DEFAULT_AGENT_TOOLS } from "@ap/shared";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { Database } from "../../db";
import { agent, chatGroup, groupMember, principal, projectMember } from "../../db/schema";
import type { Audit } from "../../core/audit";
import type { Ctx } from "../../core/context";
import { conflict, invalid, notFound } from "../../core/errors";
import type { Events } from "../../core/events";
import { newId } from "../../core/ids";
import type { Identity } from "../identity/service";
import type { Projects } from "../projects/service";

export type AgentRole = "captain" | "sub_captain" | "dev" | "reviewer" | "tester";
type AgentRow = typeof agent.$inferSelect;

/** Default tool allowlists per role (§12.7 / AGENT_TOOL_ROLES enforces the hard ceiling). */
export const DEFAULT_TOOLS: Record<AgentRole, string[]> = DEFAULT_AGENT_TOOLS;

export interface AgentInput {
  name: string;
  role: AgentRole;
  instructions?: string;
  modelPolicy?: AgentRow["modelPolicy"];
  toolAllowlist?: string[];
  budget?: AgentRow["budget"];
  maxConcurrency?: number;
  sandboxPolicy?: Record<string, unknown>;
}

/** Agent directory (FR-WEB-04, §12.7). Agents don't execute until S4/S5. */
export function createAgents(d: { db: Database; audit: Audit; events: Events; identity: Identity; projects: Projects }) {
  const { db } = d;

  const present = (a: AgentRow) => ({
    id: a.id,
    projectId: a.projectId,
    principalId: a.principalId,
    name: a.name,
    role: a.role as string,
    instructions: a.instructions,
    modelPolicy: a.modelPolicy as Record<string, unknown>,
    toolAllowlist: a.toolAllowlist,
    budget: a.budget as Record<string, unknown>,
    maxConcurrency: a.maxConcurrency,
    status: a.status as string,
    configVersion: a.configVersion,
    createdAt: a.createdAt.toISOString(),
  });

  async function list(ctx: Ctx, projectId: string) {
    await d.identity.projectInTenant(ctx, projectId);
    await d.identity.require(ctx, "project.view", { projectId });
    const rows = await db.root
      .select()
      .from(agent)
      .where(and(eq(agent.tenantId, ctx.tenantId), or(eq(agent.projectId, projectId), isNull(agent.projectId))))
      .orderBy(asc(agent.createdAt));
    return rows.map(present);
  }

  async function get(ctx: Ctx, id: string) {
    const [a] = await db.root
      .select()
      .from(agent)
      .where(and(eq(agent.id, id), eq(agent.tenantId, ctx.tenantId)));
    if (!a) throw notFound("Agent");
    if (a.projectId) await d.identity.require(ctx, "project.view", { projectId: a.projectId });
    return a;
  }

  async function create(ctx: Ctx, projectId: string, input: AgentInput) {
    await d.projects.assertWritable(ctx, projectId);
    await d.identity.require(ctx, "agent.manage", { projectId });
    if (input.role === "captain") throw invalid("全局船长在租户层配置", [{ path: "/role", message: "项目内不可创建全局船长" }]);
    const id = newId("agt");
    const pid = newId("prn");
    await db.tx(async (q) => {
      await q.insert(principal).values({ id: pid, tenantId: ctx.tenantId, kind: "agent", refId: id, displayName: input.name });
      await q.insert(agent).values({
        id,
        tenantId: ctx.tenantId,
        projectId,
        principalId: pid,
        name: input.name,
        role: input.role,
        instructions: input.instructions ?? "",
        modelPolicy: input.modelPolicy ?? {},
        toolAllowlist: input.toolAllowlist ?? DEFAULT_TOOLS[input.role],
        budget: input.budget ?? {},
        maxConcurrency: input.maxConcurrency ?? 3,
        sandboxPolicy: input.sandboxPolicy ?? {},
      });
      await q.insert(projectMember).values({ tenantId: ctx.tenantId, projectId, principalId: pid, role: "member" });
      const groups = await q.select({ id: chatGroup.id }).from(chatGroup).where(eq(chatGroup.projectId, projectId));
      if (groups.length) await q.insert(groupMember).values(groups.map((g) => ({ tenantId: ctx.tenantId, groupId: g.id, principalId: pid })));
      await d.events.emit(ctx, { type: "agent.created", aggregateType: "agent", aggregateId: id, payload: { projectId, role: input.role } });
      await d.events.emit(ctx, { type: "member.changed", aggregateType: "project", aggregateId: projectId, payload: { projectId, principalId: pid, role: "member" } });
      await d.audit.write(ctx, { action: "agent.create", resourceType: "agent", resourceId: id, projectId, after: { name: input.name, role: input.role } });
    });
    return present((await get(ctx, id)) as AgentRow);
  }

  async function update(ctx: Ctx, id: string, patch: Partial<Omit<AgentInput, "role">>) {
    const a = await get(ctx, id);
    await d.identity.require(ctx, "agent.manage", { projectId: a.projectId });
    await db.tx(async (q) => {
      await q
        .update(agent)
        .set({
          name: patch.name ?? a.name,
          instructions: patch.instructions ?? a.instructions,
          modelPolicy: patch.modelPolicy ?? a.modelPolicy,
          toolAllowlist: patch.toolAllowlist ?? a.toolAllowlist,
          budget: patch.budget ?? a.budget,
          maxConcurrency: patch.maxConcurrency ?? a.maxConcurrency,
          sandboxPolicy: patch.sandboxPolicy ?? a.sandboxPolicy,
          configVersion: a.configVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(agent.id, id));
      // Renames apply going forward only; historical messages keep authorLabel (GRP-补2).
      if (patch.name && patch.name !== a.name) await q.update(principal).set({ displayName: patch.name }).where(eq(principal.id, a.principalId));
      await d.events.emit(ctx, { type: "agent.updated", aggregateType: "agent", aggregateId: id, payload: { projectId: a.projectId, configVersion: a.configVersion + 1 } });
      await d.audit.write(ctx, {
        action: "agent.update",
        resourceType: "agent",
        resourceId: id,
        projectId: a.projectId,
        before: { name: a.name, modelPolicy: a.modelPolicy, toolAllowlist: a.toolAllowlist, budget: a.budget },
        after: patch,
      });
    });
    return present(await get(ctx, id));
  }

  /** Pause / disable (needs reason) / reactivate. Disabling bumps tokenVersion, revoking agent tokens (§9.6). */
  async function setStatus(ctx: Ctx, id: string, status: "active" | "paused" | "disabled", reason?: string) {
    const a = await get(ctx, id);
    await d.identity.require(ctx, "agent.manage", { projectId: a.projectId });
    if (status === "disabled" && !reason?.trim()) throw invalid("停用 Agent 需要填写原因", [{ path: "/reason", message: "必填" }]);
    if (a.role === "sub_captain" && status === "disabled") throw conflict("项目船长不能停用，只能暂停");
    await db.tx(async (q) => {
      await q
        .update(agent)
        .set({ status, tokenVersion: status === "disabled" ? a.tokenVersion + 1 : a.tokenVersion, updatedAt: new Date() })
        .where(eq(agent.id, id));
      await d.events.emit(ctx, { type: "agent.updated", aggregateType: "agent", aggregateId: id, payload: { projectId: a.projectId, status } });
      await d.audit.write(ctx, {
        action: `agent.${status === "active" ? "activate" : status === "paused" ? "pause" : "disable"}`,
        resourceType: "agent",
        resourceId: id,
        projectId: a.projectId,
        before: { status: a.status },
        after: { status, reason: reason ?? null },
      });
    });
    return { ok: true };
  }

  return { list, get: async (ctx: Ctx, id: string) => present(await get(ctx, id)), create, update, setStatus, raw: get };
}
export type Agents = ReturnType<typeof createAgents>;
