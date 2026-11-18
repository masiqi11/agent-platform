import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { log } from "../../core/logger";
import { ImLifecycleError, ImThrottled, type ImAdapter, type ImAttachmentRef, type ImInbound, type ImOutMessage, type ImReplyHandle } from "./types";

/**
 * Feishu (Lark) enterprise self-built app (FR-IM-09): event subscription over HTTPS callback to
 * POST /api/v1/webhooks/feishu, sharing the IM gateway's bindings, identities, commands and
 * mirroring with DingTalk. Sending uses the OpenAPI with a tenant_access_token; messages go out as
 * interactive cards whose markdown element renders the gateway's IM-补2 degraded markdown.
 */

export interface FeishuOptions {
  appId: string;
  appSecret: string;
  /** Event subscription「Verification Token」: checked on every callback. */
  verificationToken?: string;
  /** Event subscription「Encrypt Key」: payloads arrive AES-encrypted and requests are signed. */
  encryptKey?: string;
  /** https://open.feishu.cn (default) or https://open.larksuite.com. */
  domain?: string;
  fetch?: typeof fetch;
  maxDownloadBytes?: number;
}

const asText = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** AES-256-CBC, key = sha256(encryptKey), IV = first 16 bytes of the base64 payload (Feishu spec). */
export function decryptFeishu(encrypt: string, encryptKey: string): string {
  const buf = Buffer.from(encrypt, "base64");
  const key = createHash("sha256").update(encryptKey).digest();
  const d = createDecipheriv("aes-256-cbc", key, buf.subarray(0, 16));
  return Buffer.concat([d.update(buf.subarray(16)), d.final()]).toString("utf8");
}

/** X-Lark-Signature = sha256hex(timestamp + nonce + encryptKey + rawBody). */
export function feishuSignature(timestamp: string, nonce: string, encryptKey: string, body: string) {
  return createHash("sha256")
    .update(timestamp + nonce + encryptKey + body)
    .digest("hex");
}

/** Text of a message's content JSON (text / post), with @-placeholders resolved. */
function messageText(type: string, content: Record<string, unknown>, mentions: Array<Record<string, unknown>>, botOpenId: string | null) {
  const names = new Map<string, { name: string; bot: boolean }>();
  for (const m of mentions) names.set(asText(m.key), { name: asText(m.name), bot: Boolean(botOpenId && asText(obj(m.id).open_id) === botOpenId) });
  const resolve = (s: string) => s.replace(/@_user_\d+/g, (k) => (names.get(k)?.bot ? "" : `@${names.get(k)?.name ?? "成员"}`));
  const attachments: ImAttachmentRef[] = [];
  let text = "";
  if (type === "text") text = resolve(asText(content.text));
  else if (type === "post") {
    // { title, content: [[{tag,...}]] } or wrapped by locale { zh_cn: {...} }
    const body = Array.isArray(content.content) ? content : (Object.values(content).find((v) => Array.isArray(obj(v).content)) as Record<string, unknown> | undefined);
    const title = asText(body?.title);
    const lines = ((body?.content as unknown[]) ?? []).map((line) =>
      (Array.isArray(line) ? line : [])
        .map((el) => {
          const e = obj(el);
          if (e.tag === "text" || e.tag === "a") return asText(e.text);
          if (e.tag === "at") return botOpenId && asText(e.user_id) === botOpenId ? "" : `@${asText(e.user_name) || "成员"}`;
          if (e.tag === "img" && asText(e.image_key)) attachments.push({ ref: `image:${asText(e.image_key)}`, name: `image-${attachments.length + 1}.png`, mime: "image/png" });
          return "";
        })
        .join(""),
    );
    text = [title, ...lines].filter((x) => x.trim()).join("\n");
  } else if (type === "image") {
    if (asText(content.image_key)) attachments.push({ ref: `image:${asText(content.image_key)}`, name: "image.png", mime: "image/png" });
  } else if (type === "file") {
    if (asText(content.file_key)) attachments.push({ ref: `file:${asText(content.file_key)}`, name: asText(content.file_name) || "file" });
  } else text = `[${type} 消息，平台暂不支持，请在飞书查看]`;
  return { text: text.replace(/[ \t]+/g, " ").trim(), attachments };
}

/** Schema-2.0 event → gateway event; null for events the gateway ignores. */
export function parseFeishuEvent(payload: Record<string, unknown>, botOpenId: string | null): ImInbound | null {
  const header = obj(payload.header);
  const type = asText(header.event_type) || asText(obj(payload.event).type);
  const ev = obj(payload.event);
  if (type === "im.message.receive_v1") {
    const msg = obj(ev.message);
    const sender = obj(ev.sender);
    const sid = obj(sender.sender_id);
    if (asText(sender.sender_type) && asText(sender.sender_type) !== "user") return null; // ignore apps/bots (incl. ourselves)
    // user_id is the enterprise employee id (needs the contact permission); open_id is per app.
    const senderId = asText(sid.user_id) || (asText(sid.open_id) ? `open:${asText(sid.open_id)}` : "");
    const msgId = asText(msg.message_id);
    const chatId = asText(msg.chat_id);
    if (!msgId || !chatId || !senderId) return null;
    let content: Record<string, unknown> = {};
    try {
      content = obj(JSON.parse(asText(msg.content) || "{}"));
    } catch {
      /* not JSON */
    }
    const mentions = (Array.isArray(msg.mentions) ? msg.mentions : []).map(obj);
    const { text, attachments } = messageText(asText(msg.message_type) || "text", content, mentions, botOpenId);
    const group = asText(msg.chat_type) !== "p2p";
    // The app receives only messages that @ it unless it has the "all group messages" permission.
    const atBot = !group || (botOpenId ? mentions.some((m) => asText(obj(m.id).open_id) === botOpenId) : true);
    return {
      kind: "message",
      provider: "feishu",
      msgId,
      chatId,
      chatType: group ? "group" : "private",
      senderId,
      senderNick: "飞书用户",
      text,
      atBot,
      attachments: attachments.length ? attachments.map((a) => ({ ...a, ref: `${msgId}|${a.ref}` })) : undefined,
      reply: { chatId, chatType: group ? "group" : "private", senderId, messageId: msgId },
      at: asText(msg.create_time) ? new Date(Number(msg.create_time)).toISOString() : undefined,
    };
  }
  if (type === "im.message.recalled_v1") {
    const msgId = asText(ev.message_id);
    const chatId = asText(ev.chat_id);
    // Only the author's own recall is synced; Feishu tells the kind of recall, not the operator.
    if (!msgId || !chatId || (asText(ev.recall_type) && asText(ev.recall_type) !== "message_owner")) return null;
    return { kind: "recall", provider: "feishu", msgId, chatId, senderId: "", byAuthor: true };
  }
  const chatId = asText(ev.chat_id) || undefined;
  if (type === "im.chat.disbanded_v1") return chatId ? { kind: "lifecycle", provider: "feishu", chatId, event: "chat_disbanded" } : null;
  if (type === "im.chat.member.bot.deleted_v1") return chatId ? { kind: "lifecycle", provider: "feishu", chatId, event: "bot_removed" } : null;
  if (type === "app_uninstalled" || type === "application.application.app_uninstalled_v6") return { kind: "lifecycle", provider: "feishu", event: "app_revoked" };
  return null;
}

/** OpenAPI failure → gateway error kinds. Feishu returns {code, msg}; HTTP 400 for most errors. */
export function classifyFeishuError(status: number, body: { code?: number; msg?: string }): Error {
  const code = Number(body.code ?? 0);
  const text = `${code} ${body.msg ?? ""}`;
  if (status === 429 || code === 99991400 || /frequency|rate limit|频率/i.test(text)) return new ImThrottled(60_000, `飞书限流：${text.trim()}`);
  if (code === 230002 || /bot (is )?not in (the )?chat|bot.*outside the (group|chat)|机器人不在群/i.test(text)) return new ImLifecycleError("bot_removed", `机器人不在群中（${code}）`);
  if (code === 230001 && /chat/i.test(text)) return new ImLifecycleError("chat_disbanded", `群不存在或已解散（${code}）`);
  if (/chat (has been )?(dissolved|disbanded)|群已解散/i.test(text)) return new ImLifecycleError("chat_disbanded", `群已解散（${code}）`);
  return new Error(`飞书接口错误 ${status}：${text.trim().slice(0, 200)}`);
}

export function createFeishuAdapter(o: FeishuOptions) {
  const f = o.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const api = (o.domain ?? "https://open.feishu.cn").replace(/\/$/, "");
  let token: { value: string; until: number } | null = null;
  let botOpenId: string | null = null;

  async function tenantToken(): Promise<string> {
    if (token && token.until > Date.now() + 60_000) return token.value;
    const r = await f(`${api}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: o.appId, app_secret: o.appSecret }),
    });
    const j = (await r.json().catch(() => ({}))) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!r.ok || j.code !== 0 || !j.tenant_access_token) throw classifyFeishuError(r.status, j);
    token = { value: j.tenant_access_token, until: Date.now() + (j.expire ?? 7200) * 1000 };
    return token.value;
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await f(`${api}${path}`, {
      method,
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${await tenantToken()}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const j = (await r.json().catch(() => ({}))) as { code?: number; msg?: string; data?: T };
    if (j.code === 99991663 || j.code === 99991664 || r.status === 401) token = null; // expired / invalid tenant token
    if (!r.ok || j.code !== 0) throw classifyFeishuError(r.status, j);
    return (j.data ?? {}) as T;
  }

  /** The bot's own open_id: tells "@ the bot" apart from other mentions. */
  async function botId(): Promise<string | null> {
    if (botOpenId) return botOpenId;
    try {
      const r = await f(`${api}/open-apis/bot/v3/info`, { method: "GET", headers: { authorization: `Bearer ${await tenantToken()}` } });
      const j = (await r.json()) as { bot?: { open_id?: string } };
      botOpenId = j.bot?.open_id ?? null;
    } catch (e) {
      log.warn("im.feishu.bot_info_failed", { err: (e as Error).message.slice(0, 200) });
    }
    return botOpenId;
  }

  const card = (m: ImOutMessage) =>
    JSON.stringify({ config: { wide_screen_mode: true }, header: { title: { tag: "plain_text", content: m.title } }, elements: [{ tag: "markdown", content: m.markdown }] });

  const adapter: ImAdapter = {
    provider: "feishu",
    // Card markdown accepts long content; Feishu's per-chat rate for bots is 5 messages / second
    // and 100 / minute per app — stay well below it per chat.
    limits: { maxChars: 6000, perChatPerMinute: 20 },
    async sendGroup(chatId, msg) {
      const d = await call<{ message_id?: string }>("POST", "/open-apis/im/v1/messages?receive_id_type=chat_id", { receive_id: chatId, msg_type: "interactive", content: card(msg) });
      return { externalMessageId: d.message_id };
    },
    async reply(to: ImReplyHandle, msg) {
      if (to.messageId) {
        await call("POST", `/open-apis/im/v1/messages/${encodeURIComponent(to.messageId)}/reply`, { msg_type: "interactive", content: card(msg) });
        return;
      }
      if (to.chatType === "group") await adapter.sendGroup(to.chatId, msg);
      else {
        const [kind, id] = to.senderId.startsWith("open:") ? ["open_id", to.senderId.slice(5)] : ["user_id", to.senderId];
        await call("POST", `/open-apis/im/v1/messages?receive_id_type=${kind}`, { receive_id: id, msg_type: "interactive", content: card(msg) });
      }
    },
    async fetchAttachment(ref) {
      // ref = "<message_id>|image:<key>" or "<message_id>|file:<key>"
      const [msgId, res] = ref.ref.split("|");
      const [type, key] = (res ?? "").split(":");
      if (!msgId || !key || (type !== "image" && type !== "file")) throw new Error("附件引用无效");
      const r = await f(`${api}/open-apis/im/v1/messages/${encodeURIComponent(msgId)}/resources/${encodeURIComponent(key)}?type=${type}`, {
        method: "GET",
        headers: { authorization: `Bearer ${await tenantToken()}` },
      });
      if (!r.ok) throw new Error(`下载失败 ${r.status}`);
      const max = o.maxDownloadBytes ?? 25 * 1024 * 1024;
      if (Number(r.headers.get("content-length") ?? 0) > max) throw new Error("附件过大");
      const data = new Uint8Array(await r.arrayBuffer());
      if (data.byteLength > max) throw new Error("附件过大");
      return { name: ref.name, mime: (ref.mime ?? r.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim(), data };
    },
  };

  /**
   * One callback request. Returns the HTTP response to send and, when the request carried an
   * event the gateway handles, that event. Rejects requests whose token or signature is wrong.
   */
  async function handleCallback(rawBody: string, headers: Headers): Promise<{ status: number; body: Record<string, unknown>; event?: ImInbound; eventId?: string }> {
    if (o.encryptKey) {
      const ts = headers.get("x-lark-request-timestamp") ?? "";
      const nonce = headers.get("x-lark-request-nonce") ?? "";
      const sig = headers.get("x-lark-signature") ?? "";
      // url_verification is not signed; everything else must be.
      if (sig) {
        const want = feishuSignature(ts, nonce, o.encryptKey, rawBody);
        if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return { status: 401, body: { error: "bad signature" } };
        if (Math.abs(Date.now() / 1000 - Number(ts)) > 3600) return { status: 401, body: { error: "stale request" } };
      }
    }
    let payload: Record<string, unknown>;
    try {
      payload = obj(JSON.parse(rawBody || "{}"));
      if (typeof payload.encrypt === "string") {
        if (!o.encryptKey) return { status: 400, body: { error: "encrypted payload but no Encrypt Key configured" } };
        payload = obj(JSON.parse(decryptFeishu(payload.encrypt, o.encryptKey)));
      }
    } catch {
      return { status: 400, body: { error: "bad payload" } };
    }
    const tok = asText(payload.token) || asText(obj(payload.header).token);
    if (o.verificationToken && tok !== o.verificationToken) return { status: 401, body: { error: "bad token" } };
    if (payload.type === "url_verification") return { status: 200, body: { challenge: asText(payload.challenge) } };
    const event = parseFeishuEvent(payload, await botId());
    return { status: 200, body: {}, event: event ?? undefined, eventId: asText(obj(payload.header).event_id) || undefined };
  }

  return { adapter, handleCallback, tenantToken };
}
export type Feishu = ReturnType<typeof createFeishuAdapter>;
