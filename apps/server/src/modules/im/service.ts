import { parseCommand, type DomainEvent } from "@ap/shared";
import { and, count, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Config } from "../../config";
import type { Database } from "../../db";
import {
  agent,
  appUser,
  approval,
  bindCode,
  binding,
  chatGroup,
  externalIdentity,
  message,
  outboundDelivery,
  principal,
  project,
  proposal,
  summary,
  task,
  type BindingSettings,
} from "../../db/schema";
import type { Audit } from "../../core/audit";
import type { Ctx } from "../../core/context";
import { sha256Hex } from "../../core/crypto";
import { DomainError, conflict, forbidden, invalid, notFound } from "../../core/errors";
import type { Consumer, Events } from "../../core/events";
import type { Idempotency } from "../../core/idempotency";
import { newId } from "../../core/ids";
import { RetryLater, type JobRow, type Jobs } from "../../core/jobs";
import { log } from "../../core/logger";
import type { RateLimiter } from "../../core/rate-limit";
import type { Chat } from "../chat/service";
import type { Identity } from "../identity/service";
import type { Inbox } from "../inbox/service";
import type { Projects } from "../projects/service";
import type { Tasks } from "../tasks/service";
import { receipt, renderForIm } from "./render";
import { IM_PROVIDER_LABEL, ImLifecycleError, ImThrottled, type ImAdapter, type ImInbound, type ImReplyHandle } from "./types";

export interface ImDeps {
  config: Config;
  db: Database;
  audit: Audit;
  events: Events;
  jobs: Jobs;
  identity: Identity;
  projects: Projects;
  chat: Chat;
  tasks: Tasks;
  inbox: Inbox;
  idempotency: Idempotency;
  rateLimiter: RateLimiter;
}

type BindingRow = typeof binding.$inferSelect;
type Lifecycle = Extract<ImInbound, { kind: "lifecycle" }>["event"];

const BIND_CODE_TTL_MS = 10 * 60_000;
const BIND_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const EXTERNAL_LABEL = "外部成员";
const DEFAULT_SUMMARY_INTERVAL_MIN = 60;
/** During quiet hours a reply still goes out if someone spoke in the IM chat this recently. */
const ACTIVE_CONVERSATION_MS = 10 * 60_000;
const DELIVER_ATTEMPTS = 6;
const LIFECYCLE_TEXT: Record<Lifecycle | "unbound", string> = {
  bot_removed: "机器人已被移出群",
  chat_disbanded: "群已解散",
  app_revoked: "应用权限已被回收",
  unbound: "已解除绑定",
};

const HELP = [
  "**可用命令**",
  "- `/help` 查看帮助",
  "- `/status` 项目进展概览",
  "- `/summary` 让船长更新群摘要（需绑定身份）",
  "- `/task 标题` 创建任务，详情在 Web 补充（需绑定身份与成员权限）",
  "- `/bind 项目标识` 把本群绑定到项目主群（需 Maintainer）",
  "",
  "直接 @我 描述问题，船长会在群里回复。提议确认、审批都在 Web 完成。",
  "身份绑定：在 Web「个人设置 → IM 身份」生成绑定码，私聊我发送绑定码。",
].join("\n");

/** HH:MM in a time zone. */
function localMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}
const hhmm = (s: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  return m ? (Number(m[1]) % 24) * 60 + Number(m[2]) : null;
};

/** IM-补8: when the current quiet window ends, or null when not in one. */
export function quietUntil(settings: BindingSettings, now = new Date()): Date | null {
  const q = settings.quietHours;
  if (!q) return null;
  const start = hhmm(q.start);
  const end = hhmm(q.end);
  if (start === null || end === null || start === end) return null;
  const cur = localMinutes(now, q.tz ?? "Asia/Shanghai");
  const inside = start < end ? cur >= start && cur < end : cur >= start || cur < end;
  if (!inside) return null;
  const wait = (end - cur + 24 * 60) % (24 * 60);
  return new Date(now.getTime() + wait * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds());
}

export function validateSettings(s: BindingSettings): BindingSettings {
  const out: BindingSettings = {};
  if (s.quietHours) {
    if (hhmm(s.quietHours.start) === null || hhmm(s.quietHours.end) === null) throw invalid("免打扰时段格式应为 HH:MM", [{ path: "/settings/quietHours", message: "HH:MM" }]);
    if (s.quietHours.tz) {
      try {
        new Intl.DateTimeFormat("en-GB", { timeZone: s.quietHours.tz });
      } catch {
        throw invalid("未知时区", [{ path: "/settings/quietHours/tz", message: s.quietHours.tz }]);
      }
    }
    out.quietHours = { start: s.quietHours.start.trim(), end: s.quietHours.end.trim(), ...(s.quietHours.tz ? { tz: s.quietHours.tz } : {}) };
  }
  if (s.summaryMinIntervalMin !== undefined) out.summaryMinIntervalMin = Math.min(Math.max(Math.round(s.summaryMinIntervalMin), 0), 24 * 60);
  if (s.mirrorHumans !== undefined) out.mirrorHumans = Boolean(s.mirrorHumans);
  return out;
}

/**
 * IM gateway (§12.3, S9). The IM is an entry point and a notification channel only (INV-06):
 * every effect goes through the same services and permission checks as the Web console, and the
 * database stays the source of truth. Unmapped IM accounts are "外部成员" with no permissions
 * (INV-20); redelivered IM messages have no second effect (FR-IM-07, INV-16).
 */
export function createIm(d: ImDeps, adapters: ImAdapter[] = []) {
  const { db } = d;
  const registry = new Map(adapters.map((a) => [a.provider, a] as const));

  const adapterFor = (provider: string) => {
    const a = registry.get(provider);
    if (!a) throw new DomainError("upstream_unavailable", `${IM_PROVIDER_LABEL[provider] ?? provider} 未配置`);
    return a;
  };
  const label = (provider: string) => IM_PROVIDER_LABEL[provider] ?? provider;
  const chatLink = (projectId: string, groupId: string, seq?: number) => `${d.config.publicUrl}/projects/${projectId}/chat?g=${groupId}${seq ? `&seq=${seq}` : ""}`;
  const taskLink = (projectId: string, taskId: string) => `${d.config.publicUrl}/projects/${projectId}/tasks/${taskId}`;

  async function reply(to: ImReplyHandle | undefined, provider: string, text: string) {
    if (!to) return;
    try {
      await adapterFor(provider).reply(to, receipt(text));
    } catch (e) {
      log.warn("im.reply_failed", { provider, err: (e as Error).message });
    }
  }

  /* ───────────── identities (FR-IM-05, IM-补1) ───────────── */

  /** The external member principal for an unmapped IM account: one per account, no memberships. */
  async function externalPrincipal(tenantId: string, provider: string, externalUserId: string): Promise<string> {
    const ref = `${provider}:${externalUserId}`;
    const [p] = await db.root
      .select({ id: principal.id })
      .from(principal)
      .where(and(eq(principal.tenantId, tenantId), eq(principal.kind, "external"), eq(principal.refId, ref)))
      .limit(1);
    if (p) return p.id;
    const id = newId("prn");
    await db.root.insert(principal).values({ id, tenantId, kind: "external", refId: ref, displayName: EXTERNAL_LABEL });
    return id;
  }

  type Sender = { mapped: true; ctx: Ctx; userId: string } | { mapped: false; principalId: string };

  async function resolveSender(tenantId: string, provider: string, externalUserId: string, traceId: string): Promise<Sender> {
    const [row] = await db.root
      .select({ user: appUser })
      .from(externalIdentity)
      .innerJoin(appUser, eq(appUser.id, externalIdentity.userId))
      .where(and(eq(externalIdentity.provider, provider), eq(externalIdentity.externalUserId, externalUserId), eq(externalIdentity.tenantId, tenantId)));
    if (row && row.user.status === "active") {
      const ctx: Ctx = { tenantId, traceId, actor: await d.identity.actorForUser(row.user) };
      return { mapped: true, ctx, userId: row.user.id };
    }
    return { mapped: false, principalId: await externalPrincipal(tenantId, provider, externalUserId) };
  }

  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return [...bytes].map((b) => BIND_CODE_ALPHABET[b % BIND_CODE_ALPHABET.length]).join("");
  }

  /** IM-补1: one-time code shown in the Web; the user DMs it to the bot. Older unused codes die. */
  async function createBindCode(ctx: Ctx, provider: string) {
    if (ctx.actor.kind !== "human" || !ctx.actor.userId) throw forbidden("登录用户");
    adapterFor(provider);
    const code = newCode();
    const expiresAt = new Date(Date.now() + BIND_CODE_TTL_MS);
    await db.tx(async (q) => {
      await q
        .update(bindCode)
        .set({ usedAt: new Date() })
        .where(and(eq(bindCode.userId, ctx.actor.userId!), eq(bindCode.provider, provider), isNull(bindCode.usedAt)));
      await q.insert(bindCode).values({ id: newId("bcd"), tenantId: ctx.tenantId, userId: ctx.actor.userId!, provider, codeHash: sha256Hex(`${provider}:${code}`), expiresAt });
      await d.audit.write(ctx, { action: "identity.bind_code", resourceType: "user", resourceId: ctx.actor.userId! });
    });
    return { code, expiresAt: expiresAt.toISOString(), provider, hint: `在${label(provider)}里私聊机器人，发送：${code}` };
  }

  async function redeemCode(provider: string, externalUserId: string, code: string): Promise<string> {
    await d.rateLimiter.hit("im_bind", `${provider}:${externalUserId}`);
    const [bc] = await db.root
      .select()
      .from(bindCode)
      .where(and(eq(bindCode.codeHash, sha256Hex(`${provider}:${code.toUpperCase()}`)), isNull(bindCode.usedAt), gt(bindCode.expiresAt, new Date())));
    if (!bc) return "绑定码无效或已过期，请在 Web 重新生成。";
    const [u] = await db.root.select().from(appUser).where(eq(appUser.id, bc.userId));
    if (!u || u.status !== "active") return "绑定码对应的账号已停用。";
    const [taken] = await db.root
      .select()
      .from(externalIdentity)
      .where(and(eq(externalIdentity.provider, provider), eq(externalIdentity.externalUserId, externalUserId)));
    if (taken && taken.userId !== u.id) return "这个账号已绑定到另一个平台账号。如需更换，请先在 Web 解除绑定或联系管理员。";
    const sys = await d.identity.systemCtx(bc.tenantId);
    const ctx: Ctx = { ...sys, actor: await d.identity.actorForUser(u) };
    await db.tx(async (q) => {
      const [used] = await q
        .update(bindCode)
        .set({ usedAt: new Date() })
        .where(and(eq(bindCode.id, bc.id), isNull(bindCode.usedAt)))
        .returning({ id: bindCode.id });
      if (!used) throw conflict("绑定码已被使用");
      // One IM account per user per provider: binding again replaces the old one.
      await q.delete(externalIdentity).where(and(eq(externalIdentity.userId, u.id), eq(externalIdentity.provider, provider), ne(externalIdentity.externalUserId, externalUserId)));
      if (!taken) await q.insert(externalIdentity).values({ id: newId("xid"), tenantId: bc.tenantId, provider, externalUserId, userId: u.id });
      await d.audit.write(ctx, { action: "identity.map", resourceType: "user", resourceId: u.id, after: { provider, externalUserId, via: "bind_code" } });
    });
    return `绑定成功：你在${label(provider)}里的消息将以「${u.name}」的身份进入平台。`;
  }

  /** Admin bulk mapping (IM-补1). */
  async function mapIdentities(ctx: Ctx, provider: string, rows: Array<{ externalUserId: string; userId: string }>) {
    await d.identity.require(ctx, "identity.map_any");
    if (rows.length > 500) throw invalid("一次最多 500 条", [{ path: "/items", message: "≤ 500" }]);
    const users = rows.length
      ? await db.root
          .select({ id: appUser.id })
          .from(appUser)
          .where(and(eq(appUser.tenantId, ctx.tenantId), inArray(appUser.id, [...new Set(rows.map((r) => r.userId))])))
      : [];
    const known = new Set(users.map((u) => u.id));
    const result = { mapped: 0, skipped: [] as Array<{ externalUserId: string; reason: string }> };
    for (const r of rows) {
      const ext = r.externalUserId.trim();
      if (!ext || !known.has(r.userId)) {
        result.skipped.push({ externalUserId: ext, reason: "用户不存在" });
        continue;
      }
      await db.tx(async (q) => {
        const [taken] = await q
          .select()
          .from(externalIdentity)
          .where(and(eq(externalIdentity.provider, provider), eq(externalIdentity.externalUserId, ext)));
        if (taken && taken.tenantId !== ctx.tenantId) {
          result.skipped.push({ externalUserId: ext, reason: "已被其他租户使用" });
          return;
        }
        await q.delete(externalIdentity).where(and(eq(externalIdentity.provider, provider), eq(externalIdentity.userId, r.userId)));
        await q.delete(externalIdentity).where(and(eq(externalIdentity.provider, provider), eq(externalIdentity.externalUserId, ext)));
        await q.insert(externalIdentity).values({ id: newId("xid"), tenantId: ctx.tenantId, provider, externalUserId: ext, userId: r.userId });
        await d.audit.write(ctx, { action: "identity.map", resourceType: "user", resourceId: r.userId, after: { provider, externalUserId: ext, via: "admin", previous: taken?.userId ?? null } });
        result.mapped++;
      });
    }
    return result;
  }

  async function myIdentities(ctx: Ctx) {
    if (!ctx.actor.userId) return [];
    const rows = await db.root.select().from(externalIdentity).where(eq(externalIdentity.userId, ctx.actor.userId));
    return rows.map((r) => ({ id: r.id, provider: r.provider, providerLabel: label(r.provider), externalUserId: r.externalUserId, createdAt: r.createdAt.toISOString() }));
  }

  async function listIdentities(ctx: Ctx, provider?: string) {
    await d.identity.require(ctx, "identity.map_any");
    const rows = await db.root
      .select({ x: externalIdentity, name: appUser.name, email: appUser.email })
      .from(externalIdentity)
      .innerJoin(appUser, eq(appUser.id, externalIdentity.userId))
      .where(and(eq(externalIdentity.tenantId, ctx.tenantId), provider ? eq(externalIdentity.provider, provider) : undefined));
    return rows.map((r) => ({ id: r.x.id, provider: r.x.provider, externalUserId: r.x.externalUserId, userId: r.x.userId, userName: r.name, email: r.email, createdAt: r.x.createdAt.toISOString() }));
  }

  async function unmapIdentity(ctx: Ctx, id: string) {
    const [x] = await db.root
      .select()
      .from(externalIdentity)
      .where(and(eq(externalIdentity.id, id), eq(externalIdentity.tenantId, ctx.tenantId)));
    if (!x) throw notFound("IM 身份");
    if (x.userId !== ctx.actor.userId) await d.identity.require(ctx, "identity.map_any");
    await db.tx(async (q) => {
      await q.delete(externalIdentity).where(eq(externalIdentity.id, id));
      await d.audit.write(ctx, { action: "identity.unmap", resourceType: "user", resourceId: x.userId, before: { provider: x.provider, externalUserId: x.externalUserId } });
    });
    return { ok: true as const };
  }

  /* ───────────── bindings (FR-IM-02, IM-补3) ───────────── */

  async function groupInTenant(ctx: Ctx, groupId: string) {
    const [g] = await db.root
      .select()
      .from(chatGroup)
      .where(and(eq(chatGroup.id, groupId), eq(chatGroup.tenantId, ctx.tenantId)));
    if (!g) throw notFound("群");
    return g;
  }

  const presentBinding = (b: BindingRow, g?: { name: string; projectId: string }) => ({
    id: b.id,
    provider: b.provider,
    providerLabel: label(b.provider),
    externalChatId: b.externalChatId,
    chatTitle: b.chatTitle,
    groupId: b.groupId,
    groupName: g?.name ?? null,
    projectId: g?.projectId ?? null,
    mode: b.mode,
    status: b.status,
    settings: b.settings,
    invalidReason: b.invalidReason,
    invalidatedAt: b.invalidatedAt?.toISOString() ?? null,
    createdAt: b.createdAt.toISOString(),
  });

  async function createBinding(ctx: Ctx, input: { groupId: string; provider: string; externalChatId: string; mode?: "at_only" | "passive"; chatTitle?: string; settings?: BindingSettings }) {
    const g = await groupInTenant(ctx, input.groupId);
    await d.projects.assertWritable(ctx, g.projectId);
    await d.identity.require(ctx, "im.bind", { projectId: g.projectId });
    adapterFor(input.provider);
    const chatId = input.externalChatId.trim();
    if (!chatId) throw invalid("缺少外部群标识", [{ path: "/externalChatId", message: "必填" }]);
    if (g.status === "archived") throw conflict("群已归档");
    const settings = validateSettings(input.settings ?? {});
    const row = await db.tx(async (q) => {
      const [byChat] = await q
        .select()
        .from(binding)
        .where(and(eq(binding.provider, input.provider), eq(binding.externalChatId, chatId)));
      if (byChat?.status === "active") throw conflict(byChat.groupId === g.id ? "这个群已经绑定了" : `这个${label(input.provider)}群已绑定到另一个平台群，一对一绑定不能重复`);
      const [byGroup] = await q
        .select({ id: binding.id })
        .from(binding)
        .where(and(eq(binding.provider, input.provider), eq(binding.groupId, g.id), eq(binding.status, "active")));
      if (byGroup) throw conflict(`这个平台群已经绑定了另一个${label(input.provider)}群`);
      if (byChat && byChat.tenantId !== ctx.tenantId) throw conflict("这个外部群属于另一个租户");
      let b: BindingRow;
      if (byChat) {
        // A chat bound before and invalidated can be bound again (to any group).
        [b] = (await q
          .update(binding)
          .set({
            groupId: g.id,
            mode: input.mode ?? "at_only",
            status: "active",
            chatTitle: input.chatTitle ?? byChat.chatTitle,
            settings,
            invalidReason: null,
            invalidatedAt: null,
            createdBy: ctx.actor.principalId,
            updatedAt: new Date(),
          })
          .where(eq(binding.id, byChat.id))
          .returning()) as [BindingRow];
      } else {
        [b] = (await q
          .insert(binding)
          .values({
            id: newId("bnd"),
            tenantId: ctx.tenantId,
            provider: input.provider,
            externalChatId: chatId,
            groupId: g.id,
            mode: input.mode ?? "at_only",
            chatTitle: input.chatTitle ?? null,
            settings,
            createdBy: ctx.actor.principalId,
          })
          .returning()) as [BindingRow];
      }
      await d.events.emit(ctx, { type: "binding.created", aggregateType: "binding", aggregateId: b.id, payload: { projectId: g.projectId, groupId: g.id, bindingId: b.id, provider: b.provider } });
      await d.audit.write(ctx, {
        action: "binding.create",
        resourceType: "binding",
        resourceId: b.id,
        projectId: g.projectId,
        after: { provider: b.provider, externalChatId: chatId, groupId: g.id, mode: b.mode },
      });
      return b;
    });
    return presentBinding(row, g);
  }

  async function listBindings(ctx: Ctx, projectId: string) {
    await d.identity.projectInTenant(ctx, projectId);
    await d.identity.require(ctx, "project.view", { projectId });
    const rows = await db.root
      .select({ b: binding, name: chatGroup.name, projectId: chatGroup.projectId })
      .from(binding)
      .innerJoin(chatGroup, eq(chatGroup.id, binding.groupId))
      .where(and(eq(chatGroup.projectId, projectId), eq(binding.tenantId, ctx.tenantId)))
      .orderBy(desc(binding.createdAt));
    const stats = rows.length
      ? await db.root
          .select({ bindingId: outboundDelivery.bindingId, status: outboundDelivery.status, n: count() })
          .from(outboundDelivery)
          .where(
            inArray(
              outboundDelivery.bindingId,
              rows.map((r) => r.b.id),
            ),
          )
          .groupBy(outboundDelivery.bindingId, outboundDelivery.status)
      : [];
    return rows.map((r) => ({
      ...presentBinding(r.b, { name: r.name, projectId: r.projectId }),
      deliveries: Object.fromEntries(stats.filter((s) => s.bindingId === r.b.id).map((s) => [s.status, Number(s.n)])),
      configured: registry.has(r.b.provider),
    }));
  }

  async function bindingFor(ctx: Ctx, id: string) {
    const [b] = await db.root
      .select()
      .from(binding)
      .where(and(eq(binding.id, id), eq(binding.tenantId, ctx.tenantId)));
    if (!b) throw notFound("IM 绑定");
    const g = await groupInTenant(ctx, b.groupId);
    return { b, g };
  }

  async function updateBinding(ctx: Ctx, id: string, input: { mode?: "at_only" | "passive"; settings?: BindingSettings }) {
    const { b, g } = await bindingFor(ctx, id);
    await d.identity.require(ctx, "im.bind", { projectId: g.projectId });
    const settings = input.settings ? validateSettings(input.settings) : b.settings;
    const [row] = await db.tx(async (q) => {
      const r = await q
        .update(binding)
        .set({ mode: input.mode ?? b.mode, settings, updatedAt: new Date() })
        .where(eq(binding.id, id))
        .returning();
      await d.audit.write(ctx, {
        action: "binding.update",
        resourceType: "binding",
        resourceId: id,
        projectId: g.projectId,
        before: { mode: b.mode, settings: b.settings },
        after: { mode: input.mode ?? b.mode, settings },
      });
      return r;
    });
    return presentBinding(row!, g);
  }

  /**
   * IM-补3: the binding stops (unbound by a person, bot removed, chat disbanded, app revoked).
   * Pending deliveries stop instead of retrying; Maintainers are told in the group and the inbox.
   */
  async function invalidate(ctx: Ctx, b: BindingRow, reason: Lifecycle | "unbound") {
    if (b.status !== "active") return false;
    const [g] = await db.root.select().from(chatGroup).where(eq(chatGroup.id, b.groupId));
    const done = await db.tx(async (q) => {
      const [u] = await q
        .update(binding)
        .set({ status: "invalid", invalidReason: reason, invalidatedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(binding.id, b.id), eq(binding.status, "active")))
        .returning({ id: binding.id });
      if (!u) return false;
      await q
        .update(outboundDelivery)
        .set({ status: "stopped", lastError: `绑定失效：${LIFECYCLE_TEXT[reason]}` })
        .where(and(eq(outboundDelivery.bindingId, b.id), inArray(outboundDelivery.status, ["pending", "failed"])));
      await d.events.emit(ctx, { type: "binding.invalidated", aggregateType: "binding", aggregateId: b.id, payload: { projectId: g?.projectId ?? null, groupId: b.groupId, bindingId: b.id, reason } });
      await d.audit.write(ctx, { action: "binding.invalidate", resourceType: "binding", resourceId: b.id, projectId: g?.projectId ?? null, after: { reason } });
      return true;
    });
    if (!done || !g) return done;
    const text = `${label(b.provider)}群「${b.chatTitle ?? b.externalChatId}」的绑定已失效：${LIFECYCLE_TEXT[reason]}。消息不再同步${reason === "unbound" ? "" : "，可在「项目设置 → IM 绑定」重新绑定"}。`;
    const sys = await d.identity.systemCtx(b.tenantId, ctx.traceId);
    await d.chat
      .send(sys, { groupId: g.id, kind: "system", source: "system", body: text, blocks: { notice: "binding_invalidated", bindingId: b.id, reason } })
      .catch((e) => log.warn("im.notice_failed", { err: (e as Error).message }));
    if (reason !== "unbound") {
      const maint = await d.inbox.maintainers(g.projectId);
      await d.inbox.notify(
        sys,
        maint.map((principalId) => ({ principalId, kind: "escalation" as const, refType: "binding", refId: b.id, groupKey: `binding:${b.id}`, title: text, projectId: g.projectId })),
      );
    }
    return true;
  }

  async function removeBinding(ctx: Ctx, id: string) {
    const { b, g } = await bindingFor(ctx, id);
    await d.identity.require(ctx, "im.bind", { projectId: g.projectId });
    await invalidate(ctx, b, "unbound");
    return { ok: true as const };
  }

  /* ───────────── inbound (FR-IM-03, -06, -07; IM-补4, -5, -7) ───────────── */

  /**
   * Adapter entry point: persist and acknowledge quickly; the work runs as a job (retries, dead
   * letters — FR-IM-08). The job's dedupe key drops a redelivery while the first is in flight;
   * the idempotency record and the message's (source, external_id) key drop it afterwards.
   */
  async function receive(ev: ImInbound) {
    // An edit is keyed by its text too: two successive edits of one message are two events.
    const key =
      ev.kind === "lifecycle"
        ? `im:${ev.provider}:life:${ev.chatId ?? "*"}:${ev.event}`
        : ev.kind === "edit"
          ? `im:${ev.provider}:edit:${ev.msgId}:${sha256Hex(`${ev.senderId}\n${ev.text}`).slice(0, 16)}`
          : `im:${ev.provider}:${ev.kind}:${ev.msgId}`;
    await d.jobs.enqueue("im.inbound", ev as unknown as Record<string, unknown>, {
      dedupeKey: key,
      concurrencyKey: `im:in:${ev.provider}:${"chatId" in ev ? (ev.chatId ?? "*") : "*"}`,
      maxAttempts: 5,
    });
  }

  async function activeBinding(provider: string, chatId: string) {
    const [b] = await db.root
      .select()
      .from(binding)
      .where(and(eq(binding.provider, provider), eq(binding.externalChatId, chatId), eq(binding.status, "active")));
    return b ?? null;
  }

  /** Processes one inbound event; returns a short outcome (tests, logs). */
  async function handleInbound(ev: ImInbound, traceId = newId("trc")): Promise<string> {
    if (ev.kind === "lifecycle") return onLifecycle(ev, traceId);
    if (ev.kind === "edit" || ev.kind === "recall") return onEditOrRecall(ev, traceId);
    if (ev.chatType === "private") {
      const r = await d.idempotency.run(`im:${ev.provider}`, `in:${ev.msgId}`, { chat: ev.chatId }, async () => ({ status: 200, body: await onDirect(ev) }));
      return r.replayed ? "duplicate" : r.body;
    }
    const b = await activeBinding(ev.provider, ev.chatId);
    const cmd = parseCommand(ev.text.trim());
    if (!b) {
      const r = await d.idempotency.run(`im:${ev.provider}`, `in:${ev.msgId}`, { chat: ev.chatId }, async () => {
        if (cmd?.name === "bind") return { status: 200, body: await cmdBind(ev, cmd.args, traceId) };
        if (cmd?.name === "help") {
          await reply(ev.reply, ev.provider, HELP);
          return { status: 200, body: "help" };
        }
        if (ev.atBot) await reply(ev.reply, ev.provider, "本群还没有绑定项目。项目 Maintainer 可以发送 `/bind 项目标识`，或在 Web「项目设置 → IM 绑定」中绑定。");
        return { status: 200, body: "unbound" };
      });
      return r.replayed ? "duplicate" : r.body;
    }
    // Redelivery after the first was processed: the message row already exists.
    const [dup] = await db.root
      .select({ id: message.id })
      .from(message)
      .where(and(eq(message.source, ev.provider), eq(message.externalId, ev.msgId)));
    if (dup) return "duplicate";
    const sender = await resolveSender(b.tenantId, ev.provider, ev.senderId, traceId);
    if (cmd && ["help", "status", "bind", "task", "summary"].includes(cmd.name)) {
      const r = await d.idempotency.run(`im:${ev.provider}`, `in:${ev.msgId}`, { chat: ev.chatId }, async () => ({ status: 200, body: await runCommand(ev, b, sender, cmd, traceId) }));
      return r.replayed ? "duplicate" : r.body;
    }
    return post(ev, b, sender, traceId);
  }

  async function captainPrincipal(groupId: string) {
    const [g] = await db.root.select().from(chatGroup).where(eq(chatGroup.id, groupId));
    if (!g) return null;
    const [a] = g.captainAgentId
      ? await db.root.select({ principalId: agent.principalId, status: agent.status, name: agent.name }).from(agent).where(eq(agent.id, g.captainAgentId))
      : await db.root
          .select({ principalId: agent.principalId, status: agent.status, name: agent.name })
          .from(agent)
          .where(and(eq(agent.projectId, g.projectId), eq(agent.role, "sub_captain")))
          .limit(1);
    return a?.status === "active" ? a : null;
  }

  /** Writes an IM group message into the platform timeline as its real author (or 外部成员). */
  async function post(ev: Extract<ImInbound, { kind: "message" }>, b: BindingRow, sender: Sender, traceId: string, bodyOverride?: string) {
    const sys = await d.identity.systemCtx(b.tenantId, traceId);
    let body = (bodyOverride ?? ev.text).replace(/^\s+/, "").slice(0, 19_000);
    // at_only: the IM only delivers messages addressed to the bot, which stands for the captain.
    // The address uses the Web composer's form (`@名字` / `@"名 字"`), so it renders the same.
    let lead = "";
    if (sender.mapped && (b.mode === "at_only" || ev.atBot)) {
      const cap = await captainPrincipal(b.groupId);
      const token = cap ? (/\s/.test(cap.name) ? `@"${cap.name}"` : `@${cap.name}`) : "";
      if (cap && !body.includes(token) && !body.includes(`@[${cap.principalId}]`)) {
        lead = `${token} `;
        body = lead + body;
      }
    }
    const authorPrincipal = sender.mapped ? sender.ctx.actor.principalId : sender.principalId;
    // IM-补7: attachments are fetched on demand and go through the same checks as Web uploads.
    const attachmentIds: string[] = [];
    const notes: string[] = [];
    const a = registry.get(ev.provider);
    for (const ref of ev.attachments ?? []) {
      try {
        if (!a?.fetchAttachment) throw new Error("不支持下载附件");
        const f = await a.fetchAttachment(ref);
        const file = new File([new Uint8Array(f.data)], f.name || ref.name, { type: f.mime || ref.mime || "application/octet-stream" });
        const up = await d.chat.upload(sys, b.groupId, file, { uploadedBy: authorPrincipal });
        attachmentIds.push(up.id);
      } catch (e) {
        notes.push(`[附件「${ref.name}」未导入：${(e as Error).message.slice(0, 80)}]`);
      }
    }
    if (notes.length) body = `${body}${body ? "\n" : ""}${notes.join("\n")}`;
    if (!body.trim() && !attachmentIds.length) return "empty";
    const input = {
      groupId: b.groupId,
      body,
      source: ev.provider,
      externalId: ev.msgId,
      attachmentIds,
      lenientMentions: true,
      blocks: { im: { provider: ev.provider, senderNick: ev.senderNick.slice(0, 64), ...(lead ? { lead } : {}) } },
    };
    try {
      if (sender.mapped) {
        try {
          await d.chat.send(sender.ctx, input);
          return "posted";
        } catch (e) {
          // A mapped user without access to this project is still not anyone else (INV-20).
          if (!(e instanceof DomainError && (e.code === "forbidden" || e.code === "not_found"))) throw e;
        }
        await d.chat.send(sys, { ...input, external: { principalId: await externalPrincipal(b.tenantId, ev.provider, ev.senderId), label: EXTERNAL_LABEL } });
        return "posted_external";
      }
      await d.chat.send(sys, { ...input, external: { principalId: sender.principalId, label: EXTERNAL_LABEL } });
      return "posted_external";
    } catch (e) {
      if (e instanceof DomainError && e.code === "rate_limited") {
        await reply(ev.reply, ev.provider, "消息太频繁，这条没有同步到平台，请稍后再发。");
        return "rate_limited";
      }
      throw e;
    }
  }

  async function onDirect(ev: Extract<ImInbound, { kind: "message" }>) {
    const m = /^\s*(?:\/bind\s+|绑定\s*)?([A-Za-z0-9]{8})\s*$/.exec(ev.text);
    if (m) {
      let text: string;
      try {
        text = await redeemCode(ev.provider, ev.senderId, m[1]!);
      } catch (e) {
        text = e instanceof DomainError && e.code === "rate_limited" ? "尝试次数过多，请 15 分钟后再试。" : `绑定失败：${(e as Error).message.slice(0, 100)}`;
      }
      await reply(ev.reply, ev.provider, text);
      return text.startsWith("绑定成功") ? "bound" : "bind_failed";
    }
    await reply(ev.reply, ev.provider, `私聊我只用于身份绑定：在 Web「个人设置 → IM 身份」生成绑定码，然后把 8 位绑定码发给我。\n\n${HELP}`);
    return "dm_help";
  }

  async function cmdBind(ev: Extract<ImInbound, { kind: "message" }>, args: string, traceId: string) {
    const key = args.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
    if (!key) {
      await reply(ev.reply, ev.provider, "用法：`/bind 项目标识`，例如 `/bind PAY`。");
      return "bind_usage";
    }
    const [x] = await db.root
      .select({ tenantId: externalIdentity.tenantId })
      .from(externalIdentity)
      .where(and(eq(externalIdentity.provider, ev.provider), eq(externalIdentity.externalUserId, ev.senderId)));
    if (!x) {
      await reply(ev.reply, ev.provider, "只有已绑定身份的成员才能绑定群。请先在 Web 生成绑定码并私聊我。");
      return "bind_unmapped";
    }
    const sender = await resolveSender(x.tenantId, ev.provider, ev.senderId, traceId);
    if (!sender.mapped) {
      await reply(ev.reply, ev.provider, "你的平台账号已停用。");
      return "bind_unmapped";
    }
    const [p] = await db.root
      .select()
      .from(project)
      .where(and(eq(project.tenantId, x.tenantId), eq(project.key, key)));
    const [main] = p
      ? await db.root
          .select()
          .from(chatGroup)
          .where(and(eq(chatGroup.projectId, p.id), eq(chatGroup.kind, "main")))
          .limit(1)
      : [];
    if (!p || !main) {
      await reply(ev.reply, ev.provider, `没有找到项目 ${key}。`);
      return "bind_not_found";
    }
    try {
      await createBinding(sender.ctx, { groupId: main.id, provider: ev.provider, externalChatId: ev.chatId, chatTitle: ev.chatTitle, mode: "at_only" });
    } catch (e) {
      await reply(ev.reply, ev.provider, `绑定失败：${(e as Error).message.slice(0, 120)}`);
      return "bind_denied";
    }
    await reply(ev.reply, ev.provider, `已绑定到项目「${p.name}」主群。群里 @我 的消息会进入平台，船长的回复、任务卡片和摘要会同步到这里。\n\n[在 Web 打开](${chatLink(p.id, main.id)})`);
    return "bound_group";
  }

  async function runCommand(ev: Extract<ImInbound, { kind: "message" }>, b: BindingRow, sender: Sender, cmd: { name: string; args: string }, traceId: string): Promise<string> {
    const [g] = await db.root.select().from(chatGroup).where(eq(chatGroup.id, b.groupId));
    if (!g) return "no_group";
    if (cmd.name === "help") {
      await reply(ev.reply, ev.provider, HELP);
      return "help";
    }
    if (cmd.name === "status") {
      await reply(ev.reply, ev.provider, await statusText(g.projectId, g.id));
      return "status";
    }
    // IM-补5: everything else needs a mapped identity and the same permission as in the Web.
    if (!sender.mapped) {
      await reply(ev.reply, ev.provider, "未绑定身份的外部成员只能使用 /help 和 /status。绑定方法：在 Web「个人设置 → IM 身份」生成绑定码，私聊我发送。");
      return "denied_unmapped";
    }
    try {
      if (cmd.name === "bind") {
        await reply(ev.reply, ev.provider, "本群已经绑定了项目。如需改绑，请先在 Web 解除绑定。");
        return "already_bound";
      }
      if (cmd.name === "summary") {
        await d.identity.require(sender.ctx, "message.send", { projectId: g.projectId });
        // The captain consumer reacts to "/summary" from a human, as it does from the Web.
        await post(ev, b, sender, traceId, "/summary");
        await reply(ev.reply, ev.provider, "已请船长更新群摘要，完成后会同步到本群。");
        return "summary";
      }
      if (cmd.name === "task") {
        const title = cmd.args.split("\n")[0]!.trim().slice(0, 200);
        if (!title) {
          await reply(ev.reply, ev.provider, "用法：`/task 标题`。验收标准、负责人等在 Web 补充。");
          return "task_usage";
        }
        const t = await d.tasks.create(sender.ctx, { projectId: g.projectId, groupId: g.id, title, description: cmd.args.split("\n").slice(1).join("\n").trim() });
        await reply(ev.reply, ev.provider, `已创建任务 ${t.ref}：${t.title}\n\n验收标准与负责人请在 Web 补充：[打开任务](${taskLink(g.projectId, t.id)})`);
        return "task_created";
      }
    } catch (e) {
      const msg = e instanceof DomainError ? e.message : "处理失败，请稍后再试";
      await reply(ev.reply, ev.provider, `无法执行 /${cmd.name}：${msg}`);
      if (e instanceof DomainError) return `denied_${cmd.name}`;
      throw e;
    }
    return "ignored";
  }

  async function statusText(projectId: string, groupId: string) {
    const [p] = await db.root.select().from(project).where(eq(project.id, projectId));
    const rows = await db.root
      .select({ status: task.status, n: count() })
      .from(task)
      .where(and(eq(task.projectId, projectId), inArray(task.status, ["backlog", "ready", "in_progress", "blocked", "in_review", "testing"])))
      .groupBy(task.status);
    const [pp] = await db.root
      .select({ n: count() })
      .from(proposal)
      .where(and(eq(proposal.projectId, projectId), eq(proposal.status, "pending")));
    const n = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
    return [
      `**${p?.name ?? "项目"}（${p?.key ?? ""}）进展**`,
      `- 进行中 ${n("in_progress")} · 评审 ${n("in_review")} · 测试 ${n("testing")}`,
      `- 待开始 ${n("backlog") + n("ready")} · 阻塞 ${n("blocked")}`,
      `- 待确认提议 ${Number(pp?.n ?? 0)}`,
      "",
      `[在 Web 查看](${chatLink(projectId, groupId)})`,
    ].join("\n");
  }

  async function onEditOrRecall(ev: Extract<ImInbound, { kind: "edit" | "recall" }>, traceId: string) {
    const [m] = await db.root
      .select({ id: message.id, author: message.authorPrincipalId, tenantId: message.tenantId, blocks: message.blocks })
      .from(message)
      .where(and(eq(message.source, ev.provider), eq(message.externalId, ev.msgId)));
    if (!m) return "unknown_message";
    let by = m.author;
    if (!(ev.kind === "recall" && ev.byAuthor)) {
      const sender = await resolveSender(m.tenantId, ev.provider, ev.senderId, traceId);
      by = sender.mapped ? sender.ctx.actor.principalId : sender.principalId;
      // Only the IM author's own message: an edit can't re-attribute or touch someone else's.
      if (by !== m.author && m.author !== (await externalPrincipal(m.tenantId, ev.provider, ev.senderId))) return "not_author";
    }
    const sys = await d.identity.systemCtx(m.tenantId, traceId);
    // Keep the captain address the gateway added on the way in (at_only).
    const rawLead = (m.blocks as { im?: { lead?: unknown } } | null)?.im?.lead;
    const lead = typeof rawLead === "string" ? rawLead : "";
    const text = ev.kind === "edit" ? ev.text.replace(/^\s+/, "") : undefined;
    const r = await d.chat.syncExternal(sys, {
      source: ev.provider,
      externalId: ev.msgId,
      op: ev.kind,
      body: text !== undefined && lead && !text.startsWith(lead) ? lead + text : text,
      editorPrincipalId: by,
    });
    return r.changed ? (ev.kind === "edit" ? "edited" : "recalled") : "unchanged";
  }

  async function onLifecycle(ev: Extract<ImInbound, { kind: "lifecycle" }>, traceId: string) {
    const rows = await db.root
      .select()
      .from(binding)
      .where(and(eq(binding.provider, ev.provider), eq(binding.status, "active"), ev.chatId ? eq(binding.externalChatId, ev.chatId) : undefined));
    let n = 0;
    for (const b of rows) if (await invalidate(await d.identity.systemCtx(b.tenantId, traceId), b, ev.event)) n++;
    return `invalidated:${n}`;
  }

  /* ───────────── outbound (FR-IM-04, -08; IM-补2, -6, -8) ───────────── */

  async function bindingForGroup(groupId: string) {
    const rows = await db.root
      .select()
      .from(binding)
      .where(and(eq(binding.groupId, groupId), eq(binding.status, "active")));
    return rows.filter((b) => registry.has(b.provider));
  }

  /**
   * The delivery row and its job are written in one transaction (#16), so a crash between them
   * cannot leave a pending row without a job. A replayed event that finds the row still pending
   * re-enqueues it (deduped while queued/running), which also heals rows left by older versions.
   */
  async function enqueueDelivery(tenantId: string, b: BindingRow, refId: string, traceId: string, status: "pending" | "skipped" = "pending", note?: string) {
    return db.tx(async (q) => {
      const [row] = await q
        .insert(outboundDelivery)
        .values({ id: newId("obd"), tenantId, bindingId: b.id, messageId: refId, status, lastError: note ?? null })
        .onConflictDoNothing()
        .returning({ id: outboundDelivery.id, status: outboundDelivery.status });
      const target =
        row ??
        (
          await q
            .select({ id: outboundDelivery.id, status: outboundDelivery.status })
            .from(outboundDelivery)
            .where(and(eq(outboundDelivery.bindingId, b.id), eq(outboundDelivery.messageId, refId)))
        )[0];
      if (target?.status === "pending")
        await d.jobs.enqueue("im.deliver", { deliveryId: target.id }, { tenantId, dedupeKey: `im.deliver:${target.id}`, concurrencyKey: `im:out:${b.id}`, maxAttempts: DELIVER_ATTEMPTS, traceId });
      return row?.id ?? null;
    });
  }

  /** Which platform messages are mirrored: Agent replies, cards, notices; not what came from IM. */
  function shouldMirror(m: typeof message.$inferSelect, authorKind: string, b: BindingRow) {
    if (m.deletedAt || m.threadId) return false;
    if (m.source === b.provider || authorKind === "external") return false;
    if (m.kind === "system" && (m.blocks as { notice?: string } | null)?.notice === "binding_invalidated") return false;
    if (authorKind === "agent" || m.kind !== "text") return true;
    return authorKind === "human" && Boolean(b.settings.mirrorHumans);
  }

  const consumer: Consumer = {
    name: "im-outbound",
    types: ["message.created", "approval.requested"],
    async handle(e: DomainEvent) {
      if (registry.size === 0) return;
      if (e.type === "approval.requested") {
        // IM-补6: approvals are pushed as a link; the decision happens in the Web.
        const [a] = await db.root.select({ id: approval.id, groupId: task.groupId }).from(approval).innerJoin(task, eq(task.id, approval.taskId)).where(eq(approval.id, e.aggregateId));
        if (!a?.groupId) return;
        for (const b of await bindingForGroup(a.groupId)) await enqueueDelivery(e.tenantId, b, `approval:${a.id}`, e.traceId);
        return;
      }
      const p = e.payload as { groupId?: string; messageId?: string };
      if (!p.groupId || !p.messageId) return;
      const bs = await bindingForGroup(p.groupId);
      if (!bs.length) return;
      const [row] = await db.root.select({ m: message, kind: principal.kind }).from(message).innerJoin(principal, eq(principal.id, message.authorPrincipalId)).where(eq(message.id, p.messageId));
      if (!row) return;
      for (const b of bs) {
        if (!shouldMirror(row.m, row.kind, b)) continue;
        if (row.m.kind === "summary_card") {
          // IM-补8: at most one summary card per interval; the rest stay in the Web.
          const every = (b.settings.summaryMinIntervalMin ?? DEFAULT_SUMMARY_INTERVAL_MIN) * 60_000;
          const [recent] = every
            ? await db.root
                .select({ id: outboundDelivery.id })
                .from(outboundDelivery)
                .innerJoin(message, eq(message.id, outboundDelivery.messageId))
                .where(
                  and(
                    eq(outboundDelivery.bindingId, b.id),
                    eq(message.kind, "summary_card"),
                    inArray(outboundDelivery.status, ["pending", "sent"]),
                    gt(outboundDelivery.createdAt, new Date(Date.now() - every)),
                  ),
                )
                .limit(1)
            : [];
          if (recent) {
            await enqueueDelivery(e.tenantId, b, row.m.id, e.traceId, "skipped", "摘要频率上限");
            continue;
          }
        }
        await enqueueDelivery(e.tenantId, b, row.m.id, e.traceId);
      }
    },
  };

  async function renderDelivery(b: BindingRow, refId: string, maxChars: number) {
    const [g] = await db.root.select().from(chatGroup).where(eq(chatGroup.id, b.groupId));
    if (!g) return null;
    if (refId.startsWith("approval:")) {
      const [a] = await db.root
        .select({ a: approval, t: task, key: project.key })
        .from(approval)
        .innerJoin(task, eq(task.id, approval.taskId))
        .innerJoin(project, eq(project.id, task.projectId))
        .where(eq(approval.id, refId.slice(9)));
      if (!a || a.a.status !== "pending") return null; // decided meanwhile: nothing to ask for
      return renderForIm(
        {
          kind: "approval_notice",
          body: "",
          blocks: null,
          authorLabel: "系统",
          authorKind: "system",
          link: taskLink(a.t.projectId, a.t.id),
          extra: { approvalKind: a.a.kind, taskRef: `${a.key}-${a.t.number}`, taskTitle: a.t.title },
        },
        maxChars,
      );
    }
    const [m] = await db.root.select({ m: message, kind: principal.kind }).from(message).innerJoin(principal, eq(principal.id, message.authorPrincipalId)).where(eq(message.id, refId));
    if (!m || m.m.deletedAt) return null;
    const blocks = (m.m.blocks ?? {}) as Record<string, unknown>;
    const extra: Record<string, unknown> = {};
    if (m.m.kind === "summary_card" && typeof blocks.summaryId === "string") {
      const [s] = await db.root.select({ content: summary.content }).from(summary).where(eq(summary.id, blocks.summaryId));
      extra.summary = s?.content ?? {};
    }
    if (m.m.kind === "task_card" && typeof blocks.taskId === "string") extra.taskLink = taskLink(g.projectId, blocks.taskId);
    const mentionIds = [...(m.m.body.matchAll(/@\[([a-z]+_[A-Za-z0-9]+)\]/g) ?? [])].map((x) => x[1]!);
    const names = mentionIds.length
      ? Object.fromEntries((await db.root.select({ id: principal.id, name: principal.displayName }).from(principal).where(inArray(principal.id, mentionIds))).map((r) => [r.id, r.name]))
      : {};
    return renderForIm({ kind: m.m.kind, body: m.m.body, blocks, authorLabel: m.m.authorLabel, authorKind: m.kind, link: chatLink(g.projectId, g.id, m.m.seq), names, extra }, maxChars);
  }

  /** True when someone spoke in the IM chat a moment ago: a reply then is not "unsolicited". */
  async function conversationActive(b: BindingRow) {
    const [r] = await db.root
      .select({ id: message.id })
      .from(message)
      .where(and(eq(message.groupId, b.groupId), eq(message.source, b.provider), gt(message.createdAt, new Date(Date.now() - ACTIVE_CONVERSATION_MS))))
      .limit(1);
    return Boolean(r);
  }

  /** Job: send one delivery. Throttle → later; lifecycle error → binding invalid; else retry → dead letter. */
  async function deliver(deliveryId: string, job: JobRow) {
    const [o] = await db.root.select().from(outboundDelivery).where(eq(outboundDelivery.id, deliveryId));
    if (!o || o.status === "sent" || o.status === "skipped") return;
    const [b] = await db.root.select().from(binding).where(eq(binding.id, o.bindingId));
    if (!b || b.status !== "active") {
      await db.root.update(outboundDelivery).set({ status: "stopped", lastError: "绑定已失效" }).where(eq(outboundDelivery.id, o.id));
      return;
    }
    const a = adapterFor(b.provider);
    const until = quietUntil(b.settings);
    if (until && !(await conversationActive(b))) {
      await db.root.update(outboundDelivery).set({ status: "pending", nextAttemptAt: until }).where(eq(outboundDelivery.id, o.id));
      throw new RetryLater(until.getTime() - Date.now() + 1_000, "免打扰时段");
    }
    // Provider rate limit per chat (FR-IM-08): wait instead of being rejected.
    const [recent] = await db.root
      .select({ n: count(), first: sql<string>`min(${outboundDelivery.sentAt})` })
      .from(outboundDelivery)
      .where(and(eq(outboundDelivery.bindingId, b.id), eq(outboundDelivery.status, "sent"), gt(outboundDelivery.sentAt, new Date(Date.now() - 60_000))));
    if (Number(recent?.n ?? 0) >= a.limits.perChatPerMinute) {
      const wait = recent?.first ? new Date(recent.first).getTime() + 60_000 - Date.now() : 5_000;
      throw new RetryLater(Math.max(wait, 1_000), "频率上限");
    }
    const msg = await renderDelivery(b, o.messageId, a.limits.maxChars);
    if (!msg) {
      await db.root.update(outboundDelivery).set({ status: "skipped", lastError: "原消息已删除或已处理" }).where(eq(outboundDelivery.id, o.id));
      return;
    }
    try {
      const r = await a.sendGroup(b.externalChatId, msg);
      await db.root
        .update(outboundDelivery)
        .set({ status: "sent", attempts: o.attempts + 1, sentAt: new Date(), externalMessageId: r.externalMessageId ?? null, lastError: null, nextAttemptAt: null })
        .where(eq(outboundDelivery.id, o.id));
    } catch (e) {
      if (e instanceof ImThrottled) throw new RetryLater(e.retryAfterMs, "IM 限流");
      if (e instanceof ImLifecycleError) {
        await db.root
          .update(outboundDelivery)
          .set({ status: "stopped", attempts: o.attempts + 1, lastError: e.message.slice(0, 500) })
          .where(eq(outboundDelivery.id, o.id));
        await invalidate(await d.identity.systemCtx(b.tenantId, job.traceId ?? undefined), b, e.event);
        return;
      }
      const dead = job.attempts >= job.maxAttempts;
      await db.root
        .update(outboundDelivery)
        .set({ status: dead ? "dead" : "failed", attempts: o.attempts + 1, lastError: (e as Error).message.slice(0, 500) })
        .where(eq(outboundDelivery.id, o.id));
      throw e;
    }
  }

  return {
    adapters: registry,
    /** Set by the worker that runs the Stream holder; null elsewhere. */
    streamStatus: (() => null) as () => import("./stream").StreamStatus | null,
    receive,
    handleInbound,
    deliver,
    consumer,
    createBindCode,
    mapIdentities,
    myIdentities,
    listIdentities,
    unmapIdentity,
    createBinding,
    listBindings,
    updateBinding,
    removeBinding,
    invalidate,
    providers: () => [...registry.keys()].map((p) => ({ provider: p, label: label(p) })),
  };
}
export type Im = ReturnType<typeof createIm>;
