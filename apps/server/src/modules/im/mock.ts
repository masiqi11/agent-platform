import { ImLifecycleError, ImThrottled, type ImAdapter, type ImAttachmentRef, type ImOutMessage, type ImReplyHandle } from "./types";

/**
 * In-memory adapter for tests and the demo (§12.3: the core is tested against a simulated
 * adapter). It records what would have been sent and can be told to fail.
 */
export function createMockImAdapter(opts: { provider?: string; maxChars?: number; perChatPerMinute?: number } = {}) {
  const sent: Array<{ chatId: string; msg: ImOutMessage; externalMessageId: string; at: number }> = [];
  const replies: Array<{ to: ImReplyHandle; msg: ImOutMessage }> = [];
  const files = new Map<string, { name: string; mime: string; data: Uint8Array }>();
  /** Next sends to these chats fail this way (consumed one per send). */
  const failures = new Map<string, Array<"error" | "throttle" | "removed" | "disbanded" | "revoked">>();
  let n = 0;
  const adapter: ImAdapter & {
    sent: typeof sent;
    replies: typeof replies;
    files: typeof files;
    failNext(chatId: string, ...kinds: Array<"error" | "throttle" | "removed" | "disbanded" | "revoked">): void;
    reset(): void;
  } = {
    provider: opts.provider ?? "mock",
    limits: { maxChars: opts.maxChars ?? 3000, perChatPerMinute: opts.perChatPerMinute ?? 20 },
    async sendGroup(chatId, msg) {
      const f = failures.get(chatId)?.shift();
      if (f === "error") throw new Error("mock: send failed");
      if (f === "throttle") throw new ImThrottled(1_000);
      if (f === "removed") throw new ImLifecycleError("bot_removed", "机器人不在群中");
      if (f === "disbanded") throw new ImLifecycleError("chat_disbanded", "群已解散");
      if (f === "revoked") throw new ImLifecycleError("app_revoked", "应用权限已被回收");
      const externalMessageId = `mock-out-${++n}`;
      sent.push({ chatId, msg, externalMessageId, at: Date.now() });
      return { externalMessageId };
    },
    async reply(to, msg) {
      replies.push({ to, msg });
    },
    async fetchAttachment(ref: ImAttachmentRef) {
      const f = files.get(ref.ref);
      if (!f) throw new Error("mock: attachment not found");
      return f;
    },
    sent,
    replies,
    files,
    failNext(chatId, ...kinds) {
      failures.set(chatId, [...(failures.get(chatId) ?? []), ...kinds]);
    },
    reset() {
      sent.length = 0;
      replies.length = 0;
      failures.clear();
    },
  };
  return adapter;
}
export type MockImAdapter = ReturnType<typeof createMockImAdapter>;
