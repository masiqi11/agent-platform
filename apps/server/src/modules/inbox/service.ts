import type { DomainEvent } from "@ap/shared";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../db";
import { appUser, chatGroup, groupMember, inboxItem, principal, project, projectMember, proposal, task } from "../../db/schema";
import type { Ctx } from "../../core/context";
import type { Consumer, Events } from "../../core/events";
import { newId } from "../../core/ids";
import type { Identity } from "../identity/service";

type Kind = (typeof inboxItem.$inferSelect)["kind"];
export interface NotifyItem {
  principalId: string;
  kind: Kind;
  refType: string;
  refId: string;
  groupKey: string;
  title: string;
  projectId?: string | null;
}

export interface InboxDeps {
  db: Database;
  events: Events;
  identity: Identity;
}

/**
 * Unified inbox (FR-NTF-01, NTF-补5): per-user read state, consecutive notifications about the
 * same thing merge into one row (count++), filters by kind, "mark all read".
 */
export function createInbox(d: InboxDeps) {
  const { db } = d;

  /** Human principals only — agents have no inbox. */
  async function humansOnly(ids: string[]) {
    if (!ids.length) return [];
    const rows = await db.root
      .select({ id: principal.id })
      .from(principal)
      .where(and(inArray(principal.id, [...new Set(ids)]), eq(principal.kind, "human")));
    return rows.map((r) => r.id);
  }

  async function notify(ctx: Ctx, items: NotifyItem[]) {
    const humans = new Set(await humansOnly(items.map((i) => i.principalId)));
    const touched = new Set<string>();
    for (const it of items) {
      if (!humans.has(it.principalId)) continue;
      const [existing] = await db.root
        .select()
        .from(inboxItem)
        .where(and(eq(inboxItem.principalId, it.principalId), eq(inboxItem.groupKey, it.groupKey), isNull(inboxItem.readAt)));
      if (existing) {
        await db.root
          .update(inboxItem)
          .set({ count: existing.count + 1, title: it.title, refType: it.refType, refId: it.refId, updatedAt: new Date() })
          .where(eq(inboxItem.id, existing.id));
      } else {
        await db.root.insert(inboxItem).values({ id: newId("inb"), tenantId: ctx.tenantId, ...it, projectId: it.projectId ?? null });
      }
      touched.add(it.principalId);
    }
    if (touched.size) await d.events.emit(ctx, { type: "inbox.updated", aggregateType: "user", aggregateId: ctx.tenantId, payload: { inboxPrincipalIds: [...touched] } });
    return touched.size;
  }

  async function maintainers(projectId: string) {
    const rows = await db.root
      .select({ id: projectMember.principalId })
      .from(projectMember)
      .innerJoin(principal, eq(principal.id, projectMember.principalId))
      .where(and(eq(projectMember.projectId, projectId), eq(projectMember.role, "maintainer"), eq(principal.kind, "human")));
    return rows.map((r) => r.id);
  }

  async function tenantRoles(tenantId: string, roles: Array<"owner" | "admin">) {
    const rows = await db.root
      .select({ id: principal.id })
      .from(appUser)
      .innerJoin(principal, and(eq(principal.refId, appUser.id), eq(principal.kind, "human")))
      .where(and(eq(appUser.tenantId, tenantId), inArray(appUser.tenantRole, roles), eq(appUser.status, "active")));
    return rows.map((r) => r.id);
  }

  async function label(principalId: string) {
    const [p] = await db.root.select({ name: principal.displayName }).from(principal).where(eq(principal.id, principalId));
    return p?.name ?? "系统";
  }

  async function taskRef(taskId: string) {
    const [t] = await db.root.select({ number: task.number, title: task.title, key: project.key }).from(task).innerJoin(project, eq(project.id, task.projectId)).where(eq(task.id, taskId));
    return t ? `${t.key}-${t.number} ${t.title}` : "任务";
  }

  /** Event → inbox rows. At-least-once delivery is fine: merging by groupKey makes replays harmless-ish. */
  const consumer: Consumer = {
    name: "inbox",
    types: [
      "message.created",
      "proposal.created",
      "approval.requested",
      "task.created",
      "task.status_changed",
      "task.comment_added",
      "task.updated",
      "task.assigned",
      "escalation.raised",
      "question.asked",
    ],
    async handle(e: DomainEvent) {
      const p = e.payload as Record<string, unknown>;
      const ctx = await d.identity.systemCtx(e.tenantId, e.traceId);
      const projectId = (p.projectId as string) ?? null;
      const actor = e.actorPrincipalId;
      const explicit = Array.isArray(p.inboxPrincipalIds) ? (p.inboxPrincipalIds as string[]).filter((x) => x !== actor) : [];
      const who = await label(actor);
      switch (e.type) {
        case "message.created": {
          let ids = (p.mentionIds as string[]) ?? [];
          if (p.mentionAll) {
            const members = await db.root
              .select({ id: groupMember.principalId })
              .from(groupMember)
              .where(eq(groupMember.groupId, p.groupId as string));
            ids = [...ids, ...members.map((m) => m.id)];
          }
          ids = ids.filter((x) => x !== actor);
          if (!ids.length) return;
          const [g] = await db.root
            .select({ name: chatGroup.name })
            .from(chatGroup)
            .where(eq(chatGroup.id, p.groupId as string));
          await notify(
            ctx,
            ids.map((id) => ({
              principalId: id,
              kind: "mention",
              refType: "message",
              refId: p.messageId as string,
              groupKey: `mention:${p.groupId as string}`,
              title: `${who} 在 #${g?.name ?? "群"} 提到了你`,
              projectId,
            })),
          );
          return;
        }
        case "proposal.created": {
          const [pr] = await db.root
            .select()
            .from(proposal)
            .where(eq(proposal.id, p.proposalId as string));
          const title = typeof pr?.payload.title === "string" ? pr.payload.title : "新的提议";
          const ids = [...(await maintainers(projectId!)), ...explicit];
          await notify(
            ctx,
            ids.map((id) => ({
              principalId: id,
              kind: "proposal",
              refType: "proposal",
              refId: p.proposalId as string,
              groupKey: `proposal:${p.proposalId as string}`,
              title: `${who} 提议：${title}`,
              projectId,
            })),
          );
          return;
        }
        case "approval.requested": {
          const kind = p.kind as string;
          const ids = explicit.length
            ? explicit
            : kind === "merge" || kind === "release"
              ? [...(await maintainers(projectId!)), ...(await tenantRoles(e.tenantId, ["owner"]))]
              : await tenantRoles(e.tenantId, ["owner", "admin"]);
          const ref = p.taskId ? await taskRef(p.taskId as string) : "";
          const kindLabel = ({ merge: "合并", release: "发布", credential: "凭据", budget: "预算" } as Record<string, string>)[kind] ?? kind;
          await notify(
            ctx,
            ids
              .filter((x) => x !== actor)
              .map((id) => ({
                principalId: id,
                kind: "approval",
                refType: "approval",
                refId: p.approvalId as string,
                groupKey: `approval:${p.approvalId as string}`,
                title: `待审批（${kindLabel}）：${ref}`,
                projectId,
              })),
          );
          return;
        }
        case "escalation.raised": {
          const ref = p.taskId ? await taskRef(p.taskId as string) : "";
          await notify(
            ctx,
            explicit.map((id) => ({
              principalId: id,
              kind: "escalation",
              refType: "task",
              refId: (p.taskId as string) ?? "",
              groupKey: `escalation:${(p.taskId as string) ?? e.aggregateId}:${String(p.level ?? 1)}`,
              title: `升级（L${String(p.level ?? 1)}）：${(p.reason as string) ?? ""} · ${ref}`,
              projectId,
            })),
          );
          return;
        }
        case "question.asked": {
          await notify(
            ctx,
            explicit.map((id) => ({
              principalId: id,
              kind: "question",
              refType: "question",
              refId: (p.questionId as string) ?? e.aggregateId,
              groupKey: `question:${(p.questionId as string) ?? e.aggregateId}`,
              title: `${who} 有问题需要你回答`,
              projectId,
            })),
          );
          return;
        }
        default: {
          if (!explicit.length || !p.taskId) return;
          const ref = await taskRef(p.taskId as string);
          const verb =
            e.type === "task.created"
              ? "创建了任务"
              : e.type === "task.status_changed"
                ? `把任务改为「${statusLabel(p.to as string)}」`
                : e.type === "task.comment_added"
                  ? "评论了任务"
                  : e.type === "task.assigned"
                    ? "改派了任务"
                    : "更新了任务";
          await notify(
            ctx,
            explicit.map((id) => ({ principalId: id, kind: "task", refType: "task", refId: p.taskId as string, groupKey: `task:${p.taskId as string}`, title: `${who} ${verb}：${ref}`, projectId })),
          );
        }
      }
    },
  };

  async function list(ctx: Ctx, f: { kind?: string; unread?: boolean; limit?: number } = {}) {
    const cond: SQL[] = [eq(inboxItem.principalId, ctx.actor.principalId), eq(inboxItem.tenantId, ctx.tenantId)];
    if (f.kind) cond.push(eq(inboxItem.kind, f.kind as Kind));
    if (f.unread) cond.push(isNull(inboxItem.readAt));
    const rows = await db.root
      .select({ i: inboxItem, projectName: project.name, projectKey: project.key })
      .from(inboxItem)
      .leftJoin(project, eq(project.id, inboxItem.projectId))
      .where(and(...cond))
      .orderBy(desc(inboxItem.updatedAt))
      .limit(Math.min(f.limit ?? 100, 200));
    const [c] = await db.root
      .select({ n: sql<number>`count(*)::int` })
      .from(inboxItem)
      .where(and(eq(inboxItem.principalId, ctx.actor.principalId), isNull(inboxItem.readAt)));
    return {
      unread: c?.n ?? 0,
      items: rows.map(({ i, projectName, projectKey }) => ({
        id: i.id,
        kind: i.kind,
        refType: i.refType,
        refId: i.refId,
        title: i.title,
        count: i.count,
        projectId: i.projectId,
        projectName: projectName ?? null,
        projectKey: projectKey ?? null,
        read: Boolean(i.readAt),
        updatedAt: i.updatedAt.toISOString(),
      })),
    };
  }

  async function markRead(ctx: Ctx, input: { ids?: string[]; all?: boolean }) {
    const cond: SQL[] = [eq(inboxItem.principalId, ctx.actor.principalId), isNull(inboxItem.readAt)];
    if (!input.all) {
      if (!input.ids?.length) return { ok: true as const, updated: 0 };
      cond.push(inArray(inboxItem.id, input.ids));
    }
    const rows = await db.root
      .update(inboxItem)
      .set({ readAt: new Date() })
      .where(and(...cond))
      .returning({ id: inboxItem.id });
    return { ok: true as const, updated: rows.length };
  }

  return { notify, consumer, list, markRead, maintainers, tenantRoles };
}

const STATUS: Record<string, string> = { backlog: "待整理", ready: "就绪", in_progress: "开发中", blocked: "阻塞", in_review: "评审中", testing: "测试中", done: "已完成", cancelled: "已取消" };
const statusLabel = (s: string) => STATUS[s] ?? s;

export type Inbox = ReturnType<typeof createInbox>;
