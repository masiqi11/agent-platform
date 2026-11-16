import { STATUS_LABELS, type TaskStatus } from "@ap/shared";
import { and, desc, eq, inArray, lt, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "../../db";
import { agent, chatGroup, message, proposal, task } from "../../db/schema";
import type { Audit } from "../../core/audit";
import type { Ctx } from "../../core/context";
import { DomainError, conflict, forbidden, invalid, notFound } from "../../core/errors";
import type { Events } from "../../core/events";
import { newId } from "../../core/ids";
import { log } from "../../core/logger";
import type { Chat } from "../chat/service";
import type { Identity } from "../identity/service";
import type { Inbox } from "../inbox/service";
import type { Projects } from "../projects/service";
import type { Tasks } from "../tasks/service";

type Row = typeof proposal.$inferSelect;
type Kind = Row["kind"];
const TTL_MS = 72 * 3_600_000;
const REMIND_BEFORE_MS = 24 * 3_600_000;
/** Follow-up info within this window updates the pending proposal instead of posting another (CAP-补2). */
const UPDATE_WINDOW_MS = 2 * 3_600_000;

export interface ProposalDeps {
  db: Database;
  audit: Audit;
  events: Events;
  identity: Identity;
  projects: Projects;
  chat: Chat;
  tasks: Tasks;
  inbox: Inbox;
}

export interface CreateTaskPayload {
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  priority?: "P0" | "P1" | "P2" | "P3";
  type?: "feature" | "bug" | "hotfix" | "chore";
  assigneeAgentId?: string | null;
  rationale?: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Character-bigram Jaccard: cheap CJK-friendly similarity for duplicate hints (CAP-补3). */
export function similarity(a: string, b: string) {
  const grams = (s: string) => {
    const t = s.toLowerCase().replace(/\s+/g, "");
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Proposals (FR-CAP-05/10, CAP-补2/3): the captain's only way to change anything. Humans
 * accept/reject; acceptance executes through the normal services (tasks.create / transition),
 * so every policy and audit still applies (INV-07).
 */
type ProposalRow = typeof proposal.$inferSelect;

export function createProposals(d: ProposalDeps) {
  const { db } = d;
  const hooks: { afterAccept?: (ctx: Ctx, p: ProposalRow, taskIds: string[]) => Promise<void> } = {};

  async function load(ctx: Ctx, id: string) {
    const [p] = await db.root
      .select()
      .from(proposal)
      .where(and(eq(proposal.id, id), eq(proposal.tenantId, ctx.tenantId)));
    if (!p) throw notFound("提议");
    return p;
  }

  async function validSources(projectId: string, ids: string[]) {
    if (!ids.length) return [];
    const rows = await db.root
      .select({ id: message.id })
      .from(message)
      .innerJoin(chatGroup, eq(chatGroup.id, message.groupId))
      .where(and(inArray(message.id, ids), eq(chatGroup.projectId, projectId), isNull(message.deletedAt)));
    // Keep only references that exist (FR-CAP-05, determinism: never cite a hallucinated id).
    return ids.filter((id) => rows.some((r) => r.id === id));
  }

  async function duplicates(projectId: string, title: string) {
    const open = await db.root
      .select({ id: task.id, number: task.number, title: task.title })
      .from(task)
      .where(and(eq(task.projectId, projectId), ne(task.status, "done"), ne(task.status, "cancelled")));
    return open
      .map((t) => ({ taskId: t.id, number: t.number, title: t.title, score: Math.round(similarity(title, t.title) * 100) / 100 }))
      .filter((x) => x.score >= 0.45)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

  function cardBody(kind: Kind, payload: Record<string, unknown>, status: Row["status"]) {
    const statusText = { pending: "待确认", accepted: "已确认", rejected: "已拒绝", expired: "已过期", superseded: "已被取代" }[status];
    if (kind === "create_task") {
      const ac = (payload.acceptanceCriteria as string[] | undefined) ?? [];
      return [`【任务提议 · ${statusText}】${str(payload.title)}`, payload.description ? str(payload.description) : "", ac.length ? `验收标准：\n${ac.map((x) => `- ${x}`).join("\n")}` : ""]
        .filter(Boolean)
        .join("\n");
    }
    if (kind === "transition") return `【状态变更提议 · ${statusText}】${str(payload.taskRef)} → ${STATUS_LABELS[payload.to as TaskStatus] ?? str(payload.to)}`;
    if (kind === "assign") return `【分配提议 · ${statusText}】${str(payload.taskRef)} → ${str(payload.agentName ?? payload.assigneeAgentId)}`;
    return `【提议 · ${statusText}】`;
  }

  async function present(rows: Row[]) {
    return rows.map((p) => ({
      id: p.id,
      projectId: p.projectId,
      groupId: p.groupId,
      kind: p.kind,
      payload: p.payload,
      status: p.status,
      sourceMessageIds: p.sourceMessageIds,
      proposedBy: p.proposedBy,
      decidedBy: p.decidedBy,
      decidedAt: p.decidedAt?.toISOString() ?? null,
      reason: p.reason,
      messageId: p.messageId,
      resultTaskIds: p.resultTaskIds,
      expiresAt: p.expiresAt.toISOString(),
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }));
  }

  async function syncCard(ctx: Ctx, p: Row) {
    if (!p.messageId) return;
    await d.chat.updateCard(
      ctx,
      p.messageId,
      { proposalId: p.id, kind: p.kind, status: p.status, payload: p.payload, resultTaskIds: p.resultTaskIds, reason: p.reason },
      cardBody(p.kind, p.payload, p.status),
    );
  }

  async function create(ctx: Ctx, input: { projectId: string; groupId?: string | null; kind: Kind; payload: Record<string, unknown>; sourceMessageIds: string[]; policy?: string }) {
    await d.projects.assertWritable(ctx, input.projectId);
    await d.identity.require(ctx, "task.create", { projectId: input.projectId });
    if (input.kind === "create_task" && !str(input.payload.title).trim()) throw invalid("提议缺少标题", [{ path: "/payload/title", message: "必填" }]);
    if (input.kind === "merge") throw invalid("合并通过审批流程发起，不能作为提议");
    const sources = await validSources(input.projectId, input.sourceMessageIds);
    if (!sources.length) throw invalid("提议必须引用至少一条存在的来源消息", [{ path: "/sourceMessageIds", message: "为空或均不存在" }]);
    const payload = { ...input.payload };
    if (input.kind === "create_task") payload.duplicates = await duplicates(input.projectId, str(payload.title));
    if (payload.assigneeAgentId) {
      const [ag] = await db.root
        .select({ name: agent.name, projectId: agent.projectId, role: agent.role })
        .from(agent)
        .where(eq(agent.id, str(payload.assigneeAgentId)));
      if (!ag || ag.projectId !== input.projectId || ag.role !== "dev") delete payload.assigneeAgentId;
      else payload.agentName = ag.name;
    }

    // CAP-补2: an open proposal of the same kind from the same proposer in the same group gets updated.
    if (input.groupId) {
      const [open] = await db.root
        .select()
        .from(proposal)
        .where(
          and(
            eq(proposal.groupId, input.groupId),
            eq(proposal.kind, input.kind),
            eq(proposal.status, "pending"),
            eq(proposal.proposedBy, ctx.actor.principalId),
            sql`${proposal.createdAt} > now() - make_interval(secs => ${UPDATE_WINDOW_MS / 1000})`,
            input.kind === "create_task" ? sql`true` : sql`${proposal.payload}->>'taskId' = ${str(payload.taskId)}`,
          ),
        )
        .orderBy(desc(proposal.createdAt))
        .limit(1);
      if (open) {
        const merged = [...new Set([...open.sourceMessageIds, ...sources])];
        const [u] = await db.tx(async (q) => {
          const r = await q
            .update(proposal)
            .set({ payload, sourceMessageIds: merged, updatedAt: new Date(), expiresAt: new Date(Date.now() + TTL_MS) })
            .where(eq(proposal.id, open.id))
            .returning();
          await d.events.emit(ctx, { type: "proposal.updated", aggregateType: "proposal", aggregateId: open.id, payload: { projectId: input.projectId, groupId: input.groupId, proposalId: open.id } });
          await d.audit.write(ctx, { action: "proposal.update", resourceType: "proposal", resourceId: open.id, projectId: input.projectId, before: open.payload, after: payload });
          return r;
        });
        await syncCard(ctx, u!);
        return { ...(await present([u!]))[0]!, updated: true };
      }
    }

    const id = newId("prp");
    const [row] = await db.tx(async (q) => {
      const r = await q
        .insert(proposal)
        .values({
          id,
          tenantId: ctx.tenantId,
          projectId: input.projectId,
          groupId: input.groupId ?? null,
          kind: input.kind,
          payload,
          sourceMessageIds: sources,
          proposedBy: ctx.actor.principalId,
          policy: input.policy ?? null,
          expiresAt: new Date(Date.now() + TTL_MS),
        })
        .returning();
      await d.events.emit(ctx, {
        type: "proposal.created",
        aggregateType: "proposal",
        aggregateId: id,
        payload: { projectId: input.projectId, groupId: input.groupId ?? null, proposalId: id, kind: input.kind },
      });
      await d.audit.write(ctx, { action: "proposal.create", resourceType: "proposal", resourceId: id, projectId: input.projectId, after: { kind: input.kind, payload, sourceMessageIds: sources } });
      return r;
    });
    let p = row!;
    if (input.groupId) {
      const sent = await d.chat.send(ctx, {
        groupId: input.groupId,
        kind: "proposal_card",
        body: cardBody(p.kind, p.payload, p.status),
        blocks: { proposalId: id, kind: p.kind, status: p.status, payload: p.payload, sourceMessageIds: sources },
        source: "system",
      });
      const [withMsg] = await db.root.update(proposal).set({ messageId: sent.message.id }).where(eq(proposal.id, id)).returning();
      p = withMsg!;
    }
    return { ...(await present([p!]))[0]!, updated: false };
  }

  async function list(ctx: Ctx, projectId: string, status?: string) {
    await d.identity.projectInTenant(ctx, projectId);
    await d.identity.require(ctx, "project.view", { projectId });
    const rows = await db.root
      .select()
      .from(proposal)
      .where(and(eq(proposal.projectId, projectId), status ? eq(proposal.status, status as Row["status"]) : sql`true`))
      .orderBy(desc(proposal.createdAt))
      .limit(200);
    return present(rows);
  }

  async function get(ctx: Ctx, id: string) {
    const p = await load(ctx, id);
    await d.identity.require(ctx, "project.view", { projectId: p.projectId });
    return (await present([p]))[0]!;
  }

  async function requireDecider(ctx: Ctx, p: Row) {
    if (ctx.actor.kind !== "human") throw forbidden("人类成员", "提议只能由人确认（INV-07）");
    await d.identity.require(ctx, "proposal.decide", { projectId: p.projectId });
    if (p.status !== "pending") throw conflict(`提议已${{ accepted: "确认", rejected: "拒绝", expired: "过期", superseded: "被取代", pending: "" }[p.status]}`);
    if (p.expiresAt < new Date()) throw conflict("提议已过期");
  }

  /** Humans may edit title / description / criteria / assignee before confirming (CAP-补2). */
  async function edit(ctx: Ctx, id: string, patch: Partial<CreateTaskPayload>) {
    const p = await load(ctx, id);
    await requireDecider(ctx, p);
    const payload = { ...p.payload, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    const [u] = await db.tx(async (q) => {
      const r = await q.update(proposal).set({ payload, updatedAt: new Date() }).where(eq(proposal.id, id)).returning();
      await d.events.emit(ctx, { type: "proposal.updated", aggregateType: "proposal", aggregateId: id, payload: { projectId: p.projectId, groupId: p.groupId, proposalId: id } });
      await d.audit.write(ctx, { action: "proposal.edit", resourceType: "proposal", resourceId: id, projectId: p.projectId, before: p.payload, after: payload });
      return r;
    });
    await syncCard(ctx, u!);
    return (await present([u!]))[0]!;
  }

  async function accept(ctx: Ctx, id: string) {
    const p = await load(ctx, id);
    await requireDecider(ctx, p);
    const pl = p.payload;
    const resultTaskIds: string[] = [];
    if (p.kind === "create_task") {
      const t = await d.tasks.create(ctx, {
        projectId: p.projectId,
        groupId: p.groupId,
        title: str(pl.title),
        description: (pl.description as string) ?? "",
        acceptanceCriteria: (pl.acceptanceCriteria as string[]) ?? [],
        priority: (pl.priority as CreateTaskPayload["priority"]) ?? "P2",
        type: (pl.type as CreateTaskPayload["type"]) ?? "feature",
        // The confirming human becomes the owner (§9.7 "确认后成为 owner").
        ownerPrincipalIds: [ctx.actor.principalId],
        sourceMessageIds: p.sourceMessageIds,
        assigneeAgentId: (pl.assigneeAgentId as string) ?? null,
        viaProposalId: id,
      });
      resultTaskIds.push(t.id);
      // "船长提议 + 人类确认" → ready, if the guards already hold.
      if (t.assignee && t.acceptanceCriteria.length) await d.tasks.transition(ctx, t.id, "ready", {}, { viaProposalId: id }).catch(() => undefined);
    } else if (p.kind === "assign") {
      await d.tasks.update(ctx, str(pl.taskId), { assigneeAgentId: str(pl.assigneeAgentId) });
      resultTaskIds.push(str(pl.taskId));
    } else if (p.kind === "transition") {
      await d.tasks.transition(ctx, str(pl.taskId), pl.to as TaskStatus, { reason: pl.reason as string | undefined, needs: pl.needs as string | undefined }, { viaProposalId: id });
      resultTaskIds.push(str(pl.taskId));
    } else throw new DomainError("invalid", "不支持的提议类型");
    const [u] = await db.tx(async (q) => {
      const r = await q
        .update(proposal)
        .set({ status: "accepted", decidedBy: ctx.actor.principalId, decidedAt: new Date(), resultTaskIds, updatedAt: new Date() })
        .where(and(eq(proposal.id, id), eq(proposal.status, "pending")))
        .returning();
      if (!r.length) throw conflict("提议已被处理");
      await d.events.emit(ctx, {
        type: "proposal.decided",
        aggregateType: "proposal",
        aggregateId: id,
        payload: { projectId: p.projectId, groupId: p.groupId, proposalId: id, status: "accepted", resultTaskIds },
      });
      await d.audit.write(ctx, { action: "proposal.accept", resourceType: "proposal", resourceId: id, projectId: p.projectId, after: { resultTaskIds } });
      return r;
    });
    await syncCard(ctx, u!);
    // Post-accept policy (captain assignment, CAP-补7) — late-bound to avoid a module cycle.
    if (hooks.afterAccept) await hooks.afterAccept(ctx, u!, resultTaskIds).catch((e: Error) => log.warn("proposal.after_accept_failed", { err: e.message, stack: e.stack?.slice(0, 600) }));
    return (await present([u!]))[0]!;
  }

  async function reject(ctx: Ctx, id: string, reason: string) {
    const p = await load(ctx, id);
    await requireDecider(ctx, p);
    if (!reason.trim()) throw invalid("拒绝需要填写原因", [{ path: "/reason", message: "必填" }]);
    const [u] = await db.tx(async (q) => {
      const r = await q.update(proposal).set({ status: "rejected", decidedBy: ctx.actor.principalId, decidedAt: new Date(), reason, updatedAt: new Date() }).where(eq(proposal.id, id)).returning();
      await d.events.emit(ctx, { type: "proposal.decided", aggregateType: "proposal", aggregateId: id, payload: { projectId: p.projectId, groupId: p.groupId, proposalId: id, status: "rejected" } });
      await d.audit.write(ctx, { action: "proposal.reject", resourceType: "proposal", resourceId: id, projectId: p.projectId, after: { reason } });
      return r;
    });
    await syncCard(ctx, u!);
    return (await present([u!]))[0]!;
  }

  /** Expire stale proposals; remind once 24h before expiry (CAP-补2). Idempotent. */
  async function sweep(now = new Date()) {
    const due = await db.root
      .select()
      .from(proposal)
      .where(and(eq(proposal.status, "pending"), lt(proposal.expiresAt, now)));
    for (const p of due) {
      const ctx = await d.identity.systemCtx(p.tenantId);
      const [u] = await db.tx(async (q) => {
        const r = await q
          .update(proposal)
          .set({ status: "expired", updatedAt: now })
          .where(and(eq(proposal.id, p.id), eq(proposal.status, "pending")))
          .returning();
        if (r.length) {
          await d.events.emit(ctx, {
            type: "proposal.decided",
            aggregateType: "proposal",
            aggregateId: p.id,
            payload: { projectId: p.projectId, groupId: p.groupId, proposalId: p.id, status: "expired" },
          });
          await d.audit.write(ctx, { action: "proposal.expire", resourceType: "proposal", resourceId: p.id, projectId: p.projectId });
        }
        return r;
      });
      if (u) await syncCard(ctx, u);
    }
    const remind = await db.root
      .select()
      .from(proposal)
      .where(and(eq(proposal.status, "pending"), isNull(proposal.remindedAt), lt(proposal.expiresAt, new Date(now.getTime() + REMIND_BEFORE_MS))));
    for (const p of remind) {
      const ctx = await d.identity.systemCtx(p.tenantId);
      await db.root.update(proposal).set({ remindedAt: now }).where(eq(proposal.id, p.id));
      const ids = await d.inbox.maintainers(p.projectId);
      await d.inbox.notify(
        ctx,
        ids.map((pid) => ({
          principalId: pid,
          kind: "proposal",
          refType: "proposal",
          refId: p.id,
          groupKey: `proposal:${p.id}`,
          title: `提议即将过期：${str(p.payload.title)}`,
          projectId: p.projectId,
        })),
      );
    }
    return { expired: due.length, reminded: remind.length };
  }

  return { create, list, get, edit, accept, reject, sweep, hooks };
}

export type Proposals = ReturnType<typeof createProposals>;
