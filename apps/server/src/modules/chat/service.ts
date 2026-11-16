import { parseMentions, toTsQuery, tokensForIndex, type MentionCandidate } from "@ap/shared";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, sql, type SQL } from "drizzle-orm";
import type { Config } from "../../config";
import type { Database } from "../../db";
import { agent, appUser, attachment, chatGroup, groupMember, message, messageVersion, principal, projectMember, thread } from "../../db/schema";
import type { Audit } from "../../core/audit";
import type { Ctx } from "../../core/context";
import { hmacHex, safeEqual } from "../../core/crypto";
import { DomainError, conflict, forbidden, invalid, notFound } from "../../core/errors";
import type { Events } from "../../core/events";
import { newId } from "../../core/ids";
import type { ObjectStore } from "../../core/object-store";
import type { RateLimiter } from "../../core/rate-limit";
import type { Identity } from "../identity/service";
import type { Projects } from "../projects/service";

export const MAX_MESSAGE_CHARS = 20_000;
const EDIT_WINDOW_MS = 15 * 60_000;
const ATTACH_MIME = /^(image\/(png|jpeg|gif|webp)|text\/(plain|markdown|csv)|application\/(pdf|json|zip|x-yaml))$/;
const DELETED_TEXT = "原消息已删除";

export interface ChatDeps {
  config: Config;
  db: Database;
  audit: Audit;
  events: Events;
  identity: Identity;
  projects: Projects;
  objectStore: ObjectStore;
  rateLimiter: RateLimiter;
}

type GroupRow = typeof chatGroup.$inferSelect;
type MessageRow = typeof message.$inferSelect;

export interface SendInput {
  groupId: string;
  body: string;
  threadId?: string | null;
  replyToId?: string | null;
  attachmentIds?: string[];
  kind?: MessageRow["kind"];
  blocks?: Record<string, unknown> | null;
  /** Set by agent runtime: depth of the wake chain that produced this message (GRP-补3). */
  wakeDepth?: number;
  source?: string;
  externalId?: string;
}

/** Groups, members, threads and the timeline (FR-GRP-01…10). */
export function createChat(d: ChatDeps) {
  const { db } = d;

  async function groupFor(ctx: Ctx, groupId: string): Promise<GroupRow> {
    const [g] = await db.root
      .select()
      .from(chatGroup)
      .where(and(eq(chatGroup.id, groupId), eq(chatGroup.tenantId, ctx.tenantId)));
    if (!g) throw notFound("群");
    return g;
  }

  /** Read access: project members (or tenant-wide viewers) — 404 outside tenant (INV-11). */
  async function readableGroup(ctx: Ctx, groupId: string) {
    const g = await groupFor(ctx, groupId);
    await d.identity.require(ctx, "project.view", { projectId: g.projectId });
    return g;
  }

  async function candidates(g: GroupRow): Promise<MentionCandidate[]> {
    const rows = await db.root
      .select({ principalId: principal.id, name: principal.displayName, kind: principal.kind, refId: principal.refId })
      .from(projectMember)
      .innerJoin(principal, eq(principal.id, projectMember.principalId))
      .where(eq(projectMember.projectId, g.projectId));
    const agents = await db.root.select({ id: agent.id, status: agent.status }).from(agent).where(eq(agent.projectId, g.projectId));
    return rows.map((r) => ({
      principalId: r.principalId,
      name: r.name,
      kind: r.kind as MentionCandidate["kind"],
      active: r.kind === "agent" ? agents.find((a) => a.id === r.refId)?.status === "active" : true,
    }));
  }

  /** Appends a message. Seq allocation locks the group row: strictly increasing, no gaps (INV-21). */
  async function send(ctx: Ctx, input: SendInput) {
    const g = await groupFor(ctx, input.groupId);
    await d.projects.assertWritable(ctx, g.projectId);
    await d.identity.require(ctx, "message.send", { projectId: g.projectId });
    if (g.status === "archived") throw conflict("群已归档");
    const body = input.body.replace(/\r\n/g, "\n");
    if (!body.trim() && !input.attachmentIds?.length) throw invalid("消息不能为空", [{ path: "/body", message: "不能为空" }]);
    if (body.length > MAX_MESSAGE_CHARS) throw new DomainError("too_large", `消息超过 ${MAX_MESSAGE_CHARS} 字，请改为附件上传`);
    if (ctx.actor.kind === "human") await d.rateLimiter.hit("message", ctx.actor.principalId);

    const cands = await candidates(g);
    const m = parseMentions(body, cands);
    if (m.ambiguous.length)
      throw invalid(
        "提及的名字有重名，请从下拉中选择具体的人",
        m.ambiguous.map((n) => ({ path: "/body", message: `@${n} 有多个匹配` })),
      );
    if (m.all) {
      const sub = await d.identity.subjectFor(ctx, g.projectId);
      if (!(sub.kind === "human" && (sub.projectRole === "maintainer" || sub.tenantRole === "owner"))) throw forbidden("Project Maintainer", "只有 Maintainer 可以 @所有人");
    }
    const inactiveAgents = cands.filter((c) => m.principalIds.includes(c.principalId) && c.kind === "agent" && c.active === false).map((c) => c.name);

    if (input.replyToId) {
      const [r] = await db.root
        .select({ id: message.id })
        .from(message)
        .where(and(eq(message.id, input.replyToId), eq(message.groupId, g.id)));
      if (!r) throw invalid("引用的消息不存在", [{ path: "/replyToId", message: "不存在" }]);
    }
    if (input.threadId) {
      const [t] = await db.root
        .select({ id: thread.id })
        .from(thread)
        .where(and(eq(thread.id, input.threadId), eq(thread.groupId, g.id)));
      if (!t) throw invalid("线程不存在", [{ path: "/threadId", message: "不存在" }]);
    }
    const id = newId("msg");
    const row = await db.tx(async (q) => {
      // External sources: idempotent on (source, external_id) (INV-06 groundwork).
      if (input.externalId) {
        const [ex] = await q
          .select()
          .from(message)
          .where(and(eq(message.source, input.source ?? "web"), eq(message.externalId, input.externalId)));
        if (ex) return ex;
      }
      const locked = await q.execute<{ next_seq: string }>(sql`select next_seq from chat_group where id = ${g.id} for update`);
      const seq = Number((locked as unknown as { rows: Array<{ next_seq: string }> }).rows[0]!.next_seq);
      await q
        .update(chatGroup)
        .set({ nextSeq: seq + 1, updatedAt: new Date() })
        .where(eq(chatGroup.id, g.id));
      const [inserted] = await q
        .insert(message)
        .values({
          id,
          tenantId: ctx.tenantId,
          groupId: g.id,
          threadId: input.threadId ?? null,
          seq,
          authorPrincipalId: ctx.actor.principalId,
          authorLabel: ctx.actor.displayName,
          kind: input.kind ?? "text",
          body,
          blocks: input.blocks ?? null,
          mentions: m.principalIds,
          replyToId: input.replyToId ?? null,
          source: input.source ?? "web",
          externalId: input.externalId ?? null,
          wakeDepth: input.wakeDepth ?? 0,
          tokens: sql`to_tsvector('simple', ${tokensForIndex(body)})`,
        })
        .returning();
      if (input.attachmentIds?.length) {
        await q
          .update(attachment)
          .set({ messageId: id })
          .where(and(inArray(attachment.id, input.attachmentIds), eq(attachment.groupId, g.id), eq(attachment.uploadedBy, ctx.actor.principalId), isNull(attachment.messageId)));
      }
      // The author has read up to their own message.
      await q
        .update(groupMember)
        .set({ lastReadSeq: sql`greatest(${groupMember.lastReadSeq}, ${seq})` })
        .where(and(eq(groupMember.groupId, g.id), eq(groupMember.principalId, ctx.actor.principalId)));
      await d.events.emit(ctx, {
        type: "message.created",
        aggregateType: "message",
        aggregateId: id,
        payload: {
          projectId: g.projectId,
          groupId: g.id,
          messageId: id,
          seq,
          threadId: input.threadId ?? null,
          mentionIds: m.principalIds,
          mentionAll: m.all,
          authorKind: ctx.actor.kind,
          wakeDepth: input.wakeDepth ?? 0,
          kind: input.kind ?? "text",
        },
      });
      await d.audit.write(ctx, { action: "message.create", resourceType: "message", resourceId: id, projectId: g.projectId, after: { groupId: g.id, seq, kind: input.kind ?? "text" } });
      return inserted!;
    });
    return { message: (await present(ctx, [row]))[0]!, warnings: inactiveAgents.map((n) => `${n} 已停用，不会响应提及`) };
  }

  /** Builds the API shape; deleted bodies are replaced by a placeholder (GRP-补6). */
  async function present(_ctx: Ctx, rows: MessageRow[]) {
    if (rows.length === 0) return [];
    const authorIds = [...new Set(rows.map((r) => r.authorPrincipalId))];
    const authors = await db.root.select({ id: principal.id, kind: principal.kind, name: principal.displayName }).from(principal).where(inArray(principal.id, authorIds));
    const replyIds = rows.map((r) => r.replyToId).filter((x): x is string => Boolean(x));
    const replies = replyIds.length
      ? await db.root
          .select({ id: message.id, seq: message.seq, body: message.body, authorLabel: message.authorLabel, deletedAt: message.deletedAt })
          .from(message)
          .where(inArray(message.id, replyIds))
      : [];
    const atts = await db.root
      .select()
      .from(attachment)
      .where(
        inArray(
          attachment.messageId,
          rows.map((r) => r.id),
        ),
      );
    return rows.map((r) => {
      const a = authors.find((x) => x.id === r.authorPrincipalId);
      const rp = replies.find((x) => x.id === r.replyToId);
      return {
        id: r.id,
        groupId: r.groupId,
        threadId: r.threadId,
        seq: r.seq,
        author: { principalId: r.authorPrincipalId, name: r.authorLabel, kind: (a?.kind ?? "human") as string, currentName: a?.name ?? r.authorLabel },
        kind: r.kind as string,
        body: r.deletedAt ? DELETED_TEXT : r.body,
        blocks: r.deletedAt ? null : (r.blocks as Record<string, unknown> | null),
        mentions: r.mentions,
        replyTo: rp ? { id: rp.id, seq: rp.seq, authorLabel: rp.authorLabel, excerpt: rp.deletedAt ? DELETED_TEXT : rp.body.slice(0, 140) } : null,
        attachments: atts.filter((x) => x.messageId === r.id).map((x) => ({ id: x.id, name: x.name, size: x.size, mime: x.mime, scanStatus: x.scanStatus as string })),
        source: r.source,
        editedAt: r.editedAt?.toISOString() ?? null,
        deleted: Boolean(r.deletedAt),
        correctedAt: r.correctedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  /** Timeline paging by seq (§10.3): afterSeq / beforeSeq / aroundSeq, limit ≤ 200. */
  async function timeline(ctx: Ctx, groupId: string, opts: { afterSeq?: number; beforeSeq?: number; aroundSeq?: number; limit?: number; threadId?: string }) {
    const g = await readableGroup(ctx, groupId);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const base: SQL[] = [eq(message.groupId, g.id)];
    if (opts.threadId) base.push(eq(message.threadId, opts.threadId));
    let rows: MessageRow[];
    if (opts.aroundSeq !== undefined) {
      const half = Math.floor(limit / 2);
      const before = await db.root
        .select()
        .from(message)
        .where(and(...base, lt(message.seq, opts.aroundSeq)))
        .orderBy(desc(message.seq))
        .limit(half);
      const after = await db.root
        .select()
        .from(message)
        .where(and(...base, gte(message.seq, opts.aroundSeq)))
        .orderBy(asc(message.seq))
        .limit(limit - half);
      rows = [...before.reverse(), ...after];
    } else if (opts.afterSeq !== undefined) {
      rows = await db.root
        .select()
        .from(message)
        .where(and(...base, gt(message.seq, opts.afterSeq)))
        .orderBy(asc(message.seq))
        .limit(limit);
    } else {
      const cond = opts.beforeSeq !== undefined ? and(...base, lt(message.seq, opts.beforeSeq)) : and(...base);
      rows = (await db.root.select().from(message).where(cond).orderBy(desc(message.seq)).limit(limit)).reverse();
    }
    const [first] = await db.root
      .select({ seq: message.seq })
      .from(message)
      .where(and(...base))
      .orderBy(asc(message.seq))
      .limit(1);
    const [me] = await db.root
      .select({ lastReadSeq: groupMember.lastReadSeq })
      .from(groupMember)
      .where(and(eq(groupMember.groupId, g.id), eq(groupMember.principalId, ctx.actor.principalId)));
    return {
      items: await present(ctx, rows),
      hasMoreBefore: rows.length > 0 && first !== undefined && rows[0]!.seq > first.seq,
      latestSeq: g.nextSeq - 1,
      lastReadSeq: me?.lastReadSeq ?? 0,
    };
  }

  async function messageFor(ctx: Ctx, id: string) {
    const [m] = await db.root
      .select()
      .from(message)
      .where(and(eq(message.id, id), eq(message.tenantId, ctx.tenantId)));
    if (!m) throw notFound("消息");
    const g = await readableGroup(ctx, m.groupId);
    return { m, g };
  }

  async function isMaintainer(ctx: Ctx, projectId: string) {
    const s = await d.identity.subjectFor(ctx, projectId);
    return s.kind === "human" && (s.projectRole === "maintainer" || s.tenantRole === "owner");
  }

  /** GRP-补6: author within 15 min (later: Maintainer); agent messages are never edited, only marked corrected. */
  async function edit(ctx: Ctx, id: string, body: string) {
    const { m, g } = await messageFor(ctx, id);
    await d.projects.assertWritable(ctx, g.projectId);
    if (m.deletedAt) throw conflict("消息已删除");
    const [author] = await db.root.select({ kind: principal.kind }).from(principal).where(eq(principal.id, m.authorPrincipalId));
    if (author?.kind === "agent") throw conflict("Agent 消息不可编辑，只能标注为已更正");
    const own = m.authorPrincipalId === ctx.actor.principalId;
    const inWindow = Date.now() - m.createdAt.getTime() < EDIT_WINDOW_MS;
    if (!((own && inWindow) || (await isMaintainer(ctx, g.projectId)))) throw forbidden(own ? "Project Maintainer（已超过 15 分钟编辑窗口）" : "消息作者");
    if (body.length > MAX_MESSAGE_CHARS) throw new DomainError("too_large", "消息过长");
    const cands = await candidates(g);
    const mentions = parseMentions(body, cands).principalIds;
    await db.tx(async (q) => {
      const [v] = await q
        .select({ n: sql<number>`coalesce(max(version),0)::int` })
        .from(messageVersion)
        .where(eq(messageVersion.messageId, id));
      await q.insert(messageVersion).values({ messageId: id, version: (v?.n ?? 0) + 1, body: m.body, blocks: m.blocks, editedBy: ctx.actor.principalId });
      await q
        .update(message)
        .set({ body, mentions, editedAt: new Date(), tokens: sql`to_tsvector('simple', ${tokensForIndex(body)})` })
        .where(eq(message.id, id));
      await d.events.emit(ctx, { type: "message.updated", aggregateType: "message", aggregateId: id, payload: { projectId: g.projectId, groupId: g.id, messageId: id, seq: m.seq } });
      await d.audit.write(ctx, { action: "message.edit", resourceType: "message", resourceId: id, projectId: g.projectId, before: { length: m.body.length }, after: { length: body.length } });
    });
    return { ok: true };
  }

  async function markCorrected(ctx: Ctx, id: string) {
    const { m, g } = await messageFor(ctx, id);
    await d.identity.require(ctx, "message.send", { projectId: g.projectId });
    await db.tx(async (q) => {
      await q.update(message).set({ correctedAt: new Date() }).where(eq(message.id, id));
      await d.events.emit(ctx, { type: "message.updated", aggregateType: "message", aggregateId: id, payload: { projectId: g.projectId, groupId: g.id, messageId: id, seq: m.seq } });
      await d.audit.write(ctx, { action: "message.mark_corrected", resourceType: "message", resourceId: id, projectId: g.projectId });
    });
    return { ok: true };
  }

  /** Soft delete; seq placeholder stays (INV-21); references keep pointing at it. */
  async function remove(ctx: Ctx, id: string, reason: string) {
    const { m, g } = await messageFor(ctx, id);
    if (m.deletedAt) return { ok: true };
    const own = m.authorPrincipalId === ctx.actor.principalId && ctx.actor.kind === "human";
    if (!(own || (await isMaintainer(ctx, g.projectId)))) throw forbidden("Project Maintainer");
    await db.tx(async (q) => {
      await q.update(message).set({ deletedAt: new Date(), deletedBy: ctx.actor.principalId, tokens: null }).where(eq(message.id, id));
      await d.events.emit(ctx, { type: "message.deleted", aggregateType: "message", aggregateId: id, payload: { projectId: g.projectId, groupId: g.id, messageId: id, seq: m.seq } });
      await d.audit.write(ctx, { action: "message.delete", resourceType: "message", resourceId: id, projectId: g.projectId, after: { reason } });
    });
    return { ok: true };
  }

  async function versions(ctx: Ctx, id: string) {
    const { m } = await messageFor(ctx, id);
    const rows = await db.root.select().from(messageVersion).where(eq(messageVersion.messageId, m.id)).orderBy(asc(messageVersion.version));
    return rows.map((v) => ({ version: v.version, body: m.deletedAt ? DELETED_TEXT : v.body, editedBy: v.editedBy, createdAt: v.createdAt.toISOString() }));
  }

  /** In-project search over groups the caller can read; jump with aroundSeq (FR-GRP-07). */
  async function search(ctx: Ctx, projectId: string, opts: { q: string; groupId?: string; author?: string; from?: string; to?: string; limit?: number }) {
    await d.identity.projectInTenant(ctx, projectId);
    await d.identity.require(ctx, "project.view", { projectId });
    await d.rateLimiter.hit("search", ctx.actor.principalId);
    const tsq = toTsQuery(opts.q);
    if (!tsq) return [];
    const cond: SQL[] = [eq(chatGroup.projectId, projectId), isNull(message.deletedAt), sql`${message.tokens} @@ to_tsquery('simple', ${tsq})`];
    if (opts.groupId) cond.push(eq(message.groupId, opts.groupId));
    if (opts.author) cond.push(eq(message.authorPrincipalId, opts.author));
    if (opts.from) cond.push(gte(message.createdAt, new Date(opts.from)));
    if (opts.to) cond.push(lte(message.createdAt, new Date(opts.to)));
    const rows = await db.root
      .select({ m: message, groupName: chatGroup.name, rank: sql<number>`ts_rank(${message.tokens}, to_tsquery('simple', ${tsq}))` })
      .from(message)
      .innerJoin(chatGroup, eq(chatGroup.id, message.groupId))
      .where(and(...cond))
      .orderBy(desc(sql`ts_rank(${message.tokens}, to_tsquery('simple', ${tsq}))`), desc(message.createdAt))
      .limit(Math.min(opts.limit ?? 30, 100));
    const terms = [...new Set(opts.q.split(/\s+/).filter(Boolean))];
    return rows.map(({ m, groupName, rank }) => ({
      messageId: m.id,
      groupId: m.groupId,
      groupName,
      seq: m.seq,
      authorLabel: m.authorLabel,
      snippet: snippet(m.body, terms),
      rank: Number(rank),
      createdAt: m.createdAt.toISOString(),
    }));
  }

  /** Groups of a project with unread counts and mention flags for the caller (GRP-补4). */
  async function listGroups(ctx: Ctx, projectId: string) {
    await d.identity.projectInTenant(ctx, projectId);
    await d.identity.require(ctx, "project.view", { projectId });
    const groups = await db.root.select().from(chatGroup).where(eq(chatGroup.projectId, projectId)).orderBy(asc(chatGroup.createdAt));
    if (groups.length === 0) return [];
    const mine = await db.root
      .select()
      .from(groupMember)
      .where(
        and(
          eq(groupMember.principalId, ctx.actor.principalId),
          inArray(
            groupMember.groupId,
            groups.map((g) => g.id),
          ),
        ),
      );
    const out = [];
    for (const g of groups) {
      const last = mine.find((x) => x.groupId === g.id)?.lastReadSeq ?? 0;
      const [u] = await db.root
        .select({
          unread: sql<number>`count(*)::int`,
          mentioned: sql<boolean>`coalesce(bool_or(${message.mentions} @> ${JSON.stringify([ctx.actor.principalId])}::jsonb), false)`,
        })
        .from(message)
        .where(and(eq(message.groupId, g.id), gt(message.seq, last), isNull(message.deletedAt), sql`${message.authorPrincipalId} <> ${ctx.actor.principalId}`));
      out.push({
        id: g.id,
        name: g.name,
        kind: g.kind as string,
        status: g.status as string,
        member: mine.some((x) => x.groupId === g.id),
        unread: u?.unread ?? 0,
        mentioned: Boolean(u?.mentioned),
        lastReadSeq: last,
        latestSeq: g.nextSeq - 1,
      });
    }
    return out;
  }

  async function createGroup(ctx: Ctx, projectId: string, name: string) {
    await d.projects.assertWritable(ctx, projectId);
    await d.identity.require(ctx, "group.create", { projectId });
    const id = newId("grp");
    const [main] = await db.root
      .select()
      .from(chatGroup)
      .where(and(eq(chatGroup.projectId, projectId), eq(chatGroup.kind, "main")));
    await db.tx(async (q) => {
      await q.insert(chatGroup).values({ id, tenantId: ctx.tenantId, projectId, name, kind: "topic", captainAgentId: main?.captainAgentId ?? null });
      const members = await q.select({ principalId: projectMember.principalId }).from(projectMember).where(eq(projectMember.projectId, projectId));
      if (members.length)
        await q
          .insert(groupMember)
          .values(members.map((m) => ({ tenantId: ctx.tenantId, groupId: id, principalId: m.principalId, role: m.principalId === ctx.actor.principalId ? "owner" : "member" })));
      await d.events.emit(ctx, { type: "group.created", aggregateType: "group", aggregateId: id, payload: { projectId, groupId: id, kind: "topic" } });
      await d.audit.write(ctx, { action: "group.create", resourceType: "group", resourceId: id, projectId, after: { name } });
    });
    return { id };
  }

  /** Main group cannot be archived/deleted (FR-GRP-01). */
  async function archiveGroup(ctx: Ctx, groupId: string) {
    const g = await groupFor(ctx, groupId);
    await d.identity.require(ctx, "group.create", { projectId: g.projectId });
    if (g.kind === "main") throw conflict("主群不可归档或删除");
    await db.tx(async (q) => {
      await q.update(chatGroup).set({ status: "archived", updatedAt: new Date() }).where(eq(chatGroup.id, g.id));
      await d.audit.write(ctx, { action: "group.archive", resourceType: "group", resourceId: g.id, projectId: g.projectId });
    });
    return { ok: true };
  }

  async function groupMembers(ctx: Ctx, groupId: string) {
    const g = await readableGroup(ctx, groupId);
    const rows = await db.root
      .select({ principalId: principal.id, name: principal.displayName, kind: principal.kind, refId: principal.refId, role: groupMember.role })
      .from(groupMember)
      .innerJoin(principal, eq(principal.id, groupMember.principalId))
      .where(eq(groupMember.groupId, g.id))
      .orderBy(asc(groupMember.createdAt));
    const agents = await db.root.select({ id: agent.id, role: agent.role, status: agent.status }).from(agent).where(eq(agent.tenantId, ctx.tenantId));
    const users = await db.root.select({ id: appUser.id, status: appUser.status }).from(appUser).where(eq(appUser.tenantId, ctx.tenantId));
    return rows.map((r) => {
      const a = r.kind === "agent" ? agents.find((x) => x.id === r.refId) : undefined;
      return {
        principalId: r.principalId,
        name: r.name,
        kind: r.kind as string,
        role: r.role,
        agentRole: (a?.role as string | undefined) ?? null,
        active: a ? a.status === "active" : users.find((u) => u.id === r.refId)?.status === "active",
      };
    });
  }

  async function markRead(ctx: Ctx, groupId: string, seq: number) {
    const g = await readableGroup(ctx, groupId);
    await db.root
      .insert(groupMember)
      .values({ tenantId: ctx.tenantId, groupId: g.id, principalId: ctx.actor.principalId, lastReadSeq: seq })
      .onConflictDoUpdate({ target: [groupMember.groupId, groupMember.principalId], set: { lastReadSeq: sql`greatest(${groupMember.lastReadSeq}, ${seq})` } });
    return { ok: true };
  }

  async function createThread(ctx: Ctx, groupId: string, input: { title: string; rootMessageId?: string }) {
    const g = await groupFor(ctx, groupId);
    await d.identity.require(ctx, "message.send", { projectId: g.projectId });
    const id = newId("thr");
    await db.tx(async (q) => {
      await q.insert(thread).values({ id, tenantId: ctx.tenantId, groupId: g.id, title: input.title, rootMessageId: input.rootMessageId ?? null, createdBy: ctx.actor.principalId });
      if (input.rootMessageId)
        await q
          .update(message)
          .set({ threadId: id })
          .where(and(eq(message.id, input.rootMessageId), eq(message.groupId, g.id)));
      await d.events.emit(ctx, { type: "thread.created", aggregateType: "group", aggregateId: g.id, payload: { projectId: g.projectId, groupId: g.id, threadId: id } });
      await d.audit.write(ctx, { action: "thread.create", resourceType: "thread", resourceId: id, projectId: g.projectId, after: { title: input.title } });
    });
    return { id };
  }

  async function listThreads(ctx: Ctx, groupId: string) {
    const g = await readableGroup(ctx, groupId);
    const rows = await db.root.select().from(thread).where(eq(thread.groupId, g.id)).orderBy(desc(thread.createdAt));
    const counts = await db.root
      .select({ threadId: message.threadId, n: sql<number>`count(*)::int`, last: sql<string>`max(${message.createdAt})` })
      .from(message)
      .where(eq(message.groupId, g.id))
      .groupBy(message.threadId);
    return rows.map((t) => {
      const c = counts.find((x) => x.threadId === t.id);
      return {
        id: t.id,
        title: t.title,
        status: t.status as string,
        rootMessageId: t.rootMessageId,
        messageCount: c?.n ?? 0,
        lastAt: c?.last ? new Date(c.last).toISOString() : t.createdAt.toISOString(),
      };
    });
  }

  /** GRP-补7: whitelist, size cap, SHA-256, scan status (no scanner → "unscanned"). */
  async function upload(ctx: Ctx, groupId: string, file: File) {
    const g = await groupFor(ctx, groupId);
    await d.identity.require(ctx, "message.send", { projectId: g.projectId });
    if (file.size > d.config.maxUploadMb * 1024 * 1024) throw new DomainError("too_large", `附件超过 ${d.config.maxUploadMb} MB`);
    const mime = (file.type || "application/octet-stream").split(";")[0]!.trim().toLowerCase();
    if (!ATTACH_MIME.test(mime)) throw invalid("不支持的附件类型", [{ path: "/file", message: mime }]);
    const id = newId("att");
    const safeName = file.name.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 120) || "file";
    const stored = await d.objectStore.put(`attachments/${ctx.tenantId}/${g.id}/${id}/${safeName}`, Buffer.from(await file.arrayBuffer()));
    await db.tx(async (q) => {
      await q.insert(attachment).values({
        id,
        tenantId: ctx.tenantId,
        groupId: g.id,
        uri: stored.uri,
        name: safeName,
        sha256: stored.sha256,
        size: stored.size,
        mime,
        scanStatus: "unscanned",
        uploadedBy: ctx.actor.principalId,
      });
      await d.audit.write(ctx, {
        action: "attachment.upload",
        resourceType: "attachment",
        resourceId: id,
        projectId: g.projectId,
        after: { name: safeName, size: stored.size, sha256: stored.sha256 },
      });
    });
    return { id, name: safeName, size: stored.size, mime, sha256: stored.sha256 };
  }

  /** Short-lived signed download link (5 min). */
  async function attachmentLink(ctx: Ctx, id: string) {
    const [a] = await db.root
      .select()
      .from(attachment)
      .where(and(eq(attachment.id, id), eq(attachment.tenantId, ctx.tenantId)));
    if (!a) throw notFound("附件");
    await readableGroup(ctx, a.groupId);
    const exp = Date.now() + 5 * 60_000;
    return { url: `/api/v1/attachments/${id}/raw?exp=${exp}&sig=${hmacHex(d.config.auth.secret, `${id}.${exp}`)}`, expiresAt: new Date(exp).toISOString() };
  }

  async function attachmentRaw(id: string, exp: number, sig: string) {
    if (!Number.isFinite(exp) || exp < Date.now() || !safeEqual(sig, hmacHex(d.config.auth.secret, `${id}.${exp}`))) throw notFound("附件");
    const [a] = await db.root.select().from(attachment).where(eq(attachment.id, id));
    if (!a) throw notFound("附件");
    const inlineOk = a.mime.startsWith("image/") && a.scanStatus !== "infected";
    return { data: await d.objectStore.get(a.uri), mime: a.mime, name: a.name, inline: inlineOk };
  }

  return {
    send,
    timeline,
    edit,
    markCorrected,
    remove,
    versions,
    search,
    listGroups,
    createGroup,
    archiveGroup,
    groupMembers,
    markRead,
    createThread,
    listThreads,
    upload,
    attachmentLink,
    attachmentRaw,
    readableGroup,
    present,
  };
}
export type Chat = ReturnType<typeof createChat>;

function snippet(body: string, terms: string[]): string {
  const lower = body.toLowerCase();
  let at = -1;
  for (const t of terms) {
    at = lower.indexOf(t.toLowerCase());
    if (at >= 0) break;
  }
  const start = Math.max(0, at - 40);
  return (start > 0 ? "…" : "") + body.slice(start, start + 160) + (start + 160 < body.length ? "…" : "");
}
