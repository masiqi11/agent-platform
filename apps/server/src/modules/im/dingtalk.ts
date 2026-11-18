import { log } from "../../core/logger";
import { ImLifecycleError, ImThrottled, type ImAdapter, type ImAttachmentRef, type ImInbound, type ImOutMessage, type ImReplyHandle } from "./types";

/**
 * DingTalk enterprise internal app, Stream mode (FR-IM-01): the platform opens the connection,
 * so no public callback URL is needed. Receiving: the bot-message callback topic (group messages
 * that @ the bot, or all group messages when the app has that permission — see docs/im.md).
 * Sending: the robot OpenAPI with an app access token.
 */

const API = "https://api.dingtalk.com";
/** Payload fields are untyped JSON: only strings count. */
const asText = (v: unknown) => (typeof v === "string" ? v : "");

export const BOT_TOPIC = "/v1.0/im/bot/messages/get";

export interface DingTalkOptions {
  clientId: string;
  clientSecret: string;
  /** Robot code; DingTalk uses the app key when the robot is the app's own. */
  robotCode?: string;
  fetch?: typeof fetch;
  /** Max attachment size to download (bytes). */
  maxDownloadBytes?: number;
}

/** A Stream frame (see the open-source dingtalk-stream SDKs for the wire format). */
export interface StreamFrame {
  specVersion?: string;
  type: "SYSTEM" | "EVENT" | "CALLBACK";
  headers: Record<string, string>;
  data: string;
}

/** Bot callback payload → gateway event. Returns null for messages the gateway ignores. */
export function parseBotMessage(raw: Record<string, unknown>): Extract<ImInbound, { kind: "message" }> | null {
  const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  const msgId = s("msgId");
  const chatId = s("conversationId");
  // staffId is the enterprise user id; without it (e.g. a guest from another org) we use the
  // per-app senderId, which can never match a mapping made from a staffId.
  const senderId = s("senderStaffId") || (s("senderId") ? `ext:${s("senderId")}` : "");
  if (!msgId || !chatId || !senderId) return null;
  const type = s("msgtype") || "text";
  const content = (raw.content ?? {}) as Record<string, unknown>;
  let text = "";
  const attachments: ImAttachmentRef[] = [];
  if (type === "text") text = asText((raw.text as { content?: unknown } | undefined)?.content);
  else if (type === "richText") {
    for (const part of (content.richText as Array<Record<string, unknown>> | undefined) ?? []) {
      if (typeof part.text === "string") text += part.text;
      if (typeof part.downloadCode === "string") attachments.push({ ref: part.downloadCode, name: `image-${attachments.length + 1}.png`, mime: "image/png" });
    }
  } else if (type === "picture") {
    if (typeof content.downloadCode === "string") attachments.push({ ref: content.downloadCode, name: "image.png", mime: "image/png" });
  } else if (type === "file") {
    if (typeof content.downloadCode === "string") attachments.push({ ref: content.downloadCode, name: asText(content.fileName) || "file" });
  } else text = `[${type} 消息，平台暂不支持，请在钉钉查看]`;
  const group = s("conversationType") !== "1";
  const expires = Number(raw.sessionWebhookExpiredTime ?? 0);
  const reply: ImReplyHandle = { chatId, chatType: group ? "group" : "private", senderId, ...(s("sessionWebhook") ? { webhook: s("sessionWebhook"), expiresAt: expires || undefined } : {}) };
  return {
    kind: "message",
    provider: "dingtalk",
    msgId,
    chatId,
    chatType: group ? "group" : "private",
    chatTitle: s("conversationTitle") || undefined,
    senderId,
    senderNick: s("senderNick") || "钉钉用户",
    text: text.trim(),
    // The callback only carries messages that @ the bot unless the app may read all group messages.
    atBot: raw.isInAtList === undefined ? true : Boolean(raw.isInAtList),
    attachments: attachments.length ? attachments : undefined,
    reply,
    at: raw.createAt ? new Date(Number(raw.createAt)).toISOString() : undefined,
  };
}

/** Org/chat events that end a binding (IM-补3). Unknown events are ignored. */
export function parseLifecycleEvent(headers: Record<string, string>, data: Record<string, unknown>): Extract<ImInbound, { kind: "lifecycle" }> | null {
  const type = headers.eventType ?? "";
  const chatId = asText(data.openConversationId) || asText(data.OpenConversationId) || asText(data.conversationId) || undefined;
  if (type === "chat_disband") return chatId ? { kind: "lifecycle", provider: "dingtalk", chatId, event: "chat_disbanded" } : null;
  if (type === "im_robot_remove" || type === "chat_remove_robot") return chatId ? { kind: "lifecycle", provider: "dingtalk", chatId, event: "bot_removed" } : null;
  if (type === "org_micro_app_remove" || type === "org_micro_app_stop" || type === "app_auth_revoke") return { kind: "lifecycle", provider: "dingtalk", event: "app_revoked" };
  return null;
}

/** Maps an OpenAPI failure to the gateway's error kinds (lifecycle / throttled / plain). */
export function classifyError(status: number, body: { code?: string; message?: string }): Error {
  const code = `${body.code ?? ""}`;
  const text = `${code} ${body.message ?? ""}`;
  if (status === 429 || /throttl|qps|ratelimit|频率/i.test(text)) return new ImThrottled(60_000, `钉钉限流：${text.trim()}`);
  if (/robot.*not.*(in|exist).*(group|conversation)|notInGroup|机器人不在群/i.test(text)) return new ImLifecycleError("bot_removed", `机器人不在群中（${code}）`);
  if (/conversation.*(not.*exist|dismiss)|chat.*(not.*exist|dismiss)|群.*(不存在|解散)/i.test(text)) return new ImLifecycleError("chat_disbanded", `群不存在或已解散（${code}）`);
  return new Error(`钉钉接口错误 ${status}：${text.trim().slice(0, 200)}`);
}

export function createDingTalkAdapter(o: DingTalkOptions) {
  const f = o.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const robotCode = o.robotCode ?? o.clientId;
  let token: { value: string; until: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.until > Date.now() + 60_000) return token.value;
    const r = await f(`${API}/v1.0/oauth2/accessToken`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appKey: o.clientId, appSecret: o.clientSecret }) });
    const j = (await r.json().catch(() => ({}))) as { accessToken?: string; expireIn?: number; code?: string; message?: string };
    if (!r.ok || !j.accessToken) throw classifyError(r.status, j);
    token = { value: j.accessToken, until: Date.now() + (j.expireIn ?? 7200) * 1000 };
    return token.value;
  }

  async function api<T>(path: string, body: unknown): Promise<T> {
    const r = await f(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": await accessToken() }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as T & { code?: string; message?: string };
    if (r.status === 401) token = null;
    if (!r.ok) throw classifyError(r.status, j);
    return j;
  }

  const markdownParam = (m: ImOutMessage) => ({ msgKey: "sampleMarkdown", msgParam: JSON.stringify({ title: m.title, text: m.markdown }) });

  const adapter: ImAdapter = {
    provider: "dingtalk",
    // Markdown body: DingTalk accepts ~5000 chars; group robot sends: 20 per minute per group.
    limits: { maxChars: 4000, perChatPerMinute: 18 },
    async sendGroup(chatId, msg) {
      const r = await api<{ processQueryKey?: string }>("/v1.0/robot/groupMessages/send", { robotCode, openConversationId: chatId, ...markdownParam(msg) });
      return { externalMessageId: r.processQueryKey };
    },
    async reply(to, msg) {
      if (to.webhook && (!to.expiresAt || to.expiresAt > Date.now() + 5_000)) {
        const r = await f(to.webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ msgtype: "markdown", markdown: { title: msg.title, text: msg.markdown } }),
        });
        if (r.ok) return;
      }
      if (to.chatType === "group") await adapter.sendGroup(to.chatId, msg);
      else if (!to.senderId.startsWith("ext:")) await api("/v1.0/robot/oToMessages/batchSend", { robotCode, userIds: [to.senderId], ...markdownParam(msg) });
    },
    async fetchAttachment(ref) {
      const { downloadUrl } = await api<{ downloadUrl?: string }>("/v1.0/robot/messageFiles/download", { robotCode, downloadCode: ref.ref });
      if (!downloadUrl) throw new Error("钉钉未返回下载地址");
      const r = await f(downloadUrl, { method: "GET" });
      if (!r.ok) throw new Error(`下载失败 ${r.status}`);
      const max = o.maxDownloadBytes ?? 25 * 1024 * 1024;
      if (Number(r.headers.get("content-length") ?? 0) > max) throw new Error("附件过大");
      const data = new Uint8Array(await r.arrayBuffer());
      if (data.byteLength > max) throw new Error("附件过大");
      return { name: ref.name, mime: (ref.mime ?? r.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim(), data };
    },
  };

  /** Opens a Stream connection endpoint (gateway → ticket). */
  async function openConnection(signal?: AbortSignal): Promise<{ endpoint: string; ticket: string }> {
    const r = await f(`${API}/v1.0/gateway/connections/open`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        clientId: o.clientId,
        clientSecret: o.clientSecret,
        subscriptions: [
          { type: "CALLBACK", topic: BOT_TOPIC },
          { type: "EVENT", topic: "*" },
        ],
        ua: "agent-platform/1",
      }),
    });
    const j = (await r.json().catch(() => ({}))) as { endpoint?: string; ticket?: string; code?: string; message?: string };
    if (!r.ok || !j.endpoint || !j.ticket) throw classifyError(r.status, j);
    return { endpoint: j.endpoint, ticket: j.ticket };
  }

  /**
   * One Stream session: resolves when the socket closes (the caller reconnects). Every frame is
   * acknowledged after `onEvent` has queued it — a frame that isn't acknowledged is redelivered,
   * and redelivery is harmless (FR-IM-07).
   */
  async function runStream(onEvent: (ev: ImInbound) => Promise<void>, signal: AbortSignal, onState?: (s: { connected: boolean; error?: string }) => void): Promise<void> {
    // Stopped while asking for a ticket (#15): the fetch is aborted, and no socket is opened.
    if (signal.aborted) return;
    let conn: { endpoint: string; ticket: string };
    try {
      conn = await openConnection(signal);
    } catch (e) {
      if (signal.aborted) return;
      throw e;
    }
    if (signal.aborted) return;
    const ws = new WebSocket(`${conn.endpoint}?ticket=${encodeURIComponent(conn.ticket)}`);
    await new Promise<void>((resolve) => {
      const close = () => {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      };
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) close();
      ws.onopen = () => onState?.({ connected: true });
      ws.onclose = () => {
        signal.removeEventListener("abort", close);
        onState?.({ connected: false });
        resolve();
      };
      ws.onerror = () => onState?.({ connected: false, error: "websocket error" });
      ws.onmessage = (m) => {
        void (async () => {
          let frame: StreamFrame;
          try {
            frame = JSON.parse(String(m.data)) as StreamFrame;
          } catch {
            return;
          }
          const ack = (data: unknown = { response: null }) =>
            ws.send(JSON.stringify({ code: 200, headers: { contentType: "application/json", messageId: frame.headers.messageId }, message: "OK", data: JSON.stringify(data) }));
          if (frame.type === "SYSTEM") {
            if (frame.headers.topic === "ping") ws.send(JSON.stringify({ code: 200, headers: frame.headers, message: "OK", data: frame.data }));
            else if (frame.headers.topic === "disconnect") close();
            return;
          }
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(frame.data || "{}") as Record<string, unknown>;
          } catch {
            /* not JSON */
          }
          try {
            const ev = frame.type === "CALLBACK" && frame.headers.topic === BOT_TOPIC ? parseBotMessage(data) : frame.type === "EVENT" ? parseLifecycleEvent(frame.headers, data) : null;
            if (ev) await onEvent(ev);
            ack(frame.type === "EVENT" ? { status: "SUCCESS", message: "success" } : undefined);
          } catch (e) {
            // Not acknowledged → DingTalk redelivers later.
            log.warn("im.dingtalk.frame_failed", { topic: frame.headers.topic, err: (e as Error).message.slice(0, 200) });
          }
        })();
      };
    });
  }

  return { adapter, runStream, accessToken };
}
export type DingTalk = ReturnType<typeof createDingTalkAdapter>;
