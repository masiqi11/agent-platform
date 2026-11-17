/**
 * IM gateway adapter contract (§12.3). The core logic (bindings, identity, commands, mirroring)
 * is provider-neutral and tested with the mock adapter; each provider (DingTalk first) only
 * translates its wire format to these shapes and sends what it is given.
 */

export interface ImAttachmentRef {
  /** Provider handle used to download on demand (IM-补7), e.g. a DingTalk downloadCode. */
  ref: string;
  name: string;
  mime?: string;
  size?: number;
}

/** How to answer the sender of an inbound message (command receipts, DMs). */
export interface ImReplyHandle {
  chatId: string;
  chatType: "group" | "private";
  senderId: string;
  /** Short-lived reply endpoint some providers include with each message (DingTalk sessionWebhook). */
  webhook?: string;
  expiresAt?: number;
}

export type ImInbound =
  | {
      kind: "message";
      provider: string;
      /** The provider's message id: the idempotency key (FR-IM-07). */
      msgId: string;
      chatId: string;
      chatType: "group" | "private";
      chatTitle?: string;
      /** Enterprise user id (DingTalk staffId); unmapped ids stay "外部成员" (INV-20). */
      senderId: string;
      senderNick: string;
      text: string;
      /** The bot was @-mentioned. In at_only mode every delivered message is. */
      atBot: boolean;
      attachments?: ImAttachmentRef[];
      reply?: ImReplyHandle;
      at?: string;
    }
  | { kind: "edit"; provider: string; msgId: string; chatId: string; senderId: string; text: string }
  | { kind: "recall"; provider: string; msgId: string; chatId: string; senderId: string }
  /** IM-补3: the bot left / was removed, the chat was disbanded, or the app lost its permission. */
  | { kind: "lifecycle"; provider: string; chatId?: string; event: "bot_removed" | "chat_disbanded" | "app_revoked" };

/** Already degraded to what the provider renders (IM-补2). */
export interface ImOutMessage {
  title: string;
  markdown: string;
}

export interface ImLimits {
  /** Longest markdown body the provider accepts; longer content is cut and linked to the Web. */
  maxChars: number;
  /** Messages per chat per minute before the provider starts rejecting (DingTalk: 20). */
  perChatPerMinute: number;
}

export interface ImAdapter {
  readonly provider: string;
  readonly limits: ImLimits;
  sendGroup(chatId: string, msg: ImOutMessage): Promise<{ externalMessageId?: string }>;
  reply(to: ImReplyHandle, msg: ImOutMessage): Promise<void>;
  fetchAttachment?(ref: ImAttachmentRef): Promise<{ name: string; mime: string; data: Uint8Array }>;
}

/** Thrown by an adapter when the chat is gone for good: the binding is invalidated, retries stop. */
export class ImLifecycleError extends Error {
  constructor(
    readonly event: "bot_removed" | "chat_disbanded" | "app_revoked",
    message: string,
  ) {
    super(message);
  }
}

/** Thrown by an adapter when the provider throttles: retried later without spending an attempt. */
export class ImThrottled extends Error {
  constructor(
    readonly retryAfterMs: number,
    message = "throttled",
  ) {
    super(message);
  }
}

export const IM_PROVIDER_LABEL: Record<string, string> = { dingtalk: "钉钉", mock: "模拟 IM" };
