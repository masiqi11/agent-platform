import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agent, binding, externalIdentity, job, message } from "../src/db/schema";
import { classifyFeishuError, createFeishuAdapter, decryptFeishu, feishuSignature, parseFeishuEvent } from "../src/modules/im/feishu";
import { ImLifecycleError, ImThrottled } from "../src/modules/im/types";
import { createTestApp, type TestApp } from "./helpers";

const BOT = "ou_bot_0001";
const ENCRYPT_KEY = "test-encrypt-key-feishu";
const VTOKEN = "verif-token-1";

/** The way Feishu encrypts a callback body. */
function encrypt(plain: string, key = ENCRYPT_KEY) {
  const iv = randomBytes(16);
  const c = createCipheriv("aes-256-cbc", createHash("sha256").update(key).digest(), iv);
  return Buffer.concat([iv, c.update(plain, "utf8"), c.final()]).toString("base64");
}

let n = 0;
/** A schema-2.0 im.message.receive_v1 event as Feishu sends it. */
function receive(o: {
  chatId: string;
  chatType?: "group" | "p2p";
  userId?: string;
  openId?: string;
  text?: string;
  atBot?: boolean;
  msgId?: string;
  type?: string;
  content?: Record<string, unknown>;
}) {
  const mentions = o.atBot === false ? [] : [{ key: "@_user_1", id: { open_id: BOT }, name: "船长机器人" }];
  return {
    schema: "2.0",
    header: { event_id: `ev-${++n}`, event_type: "im.message.receive_v1", token: VTOKEN, create_time: String(Date.now()), app_id: "cli_x" },
    event: {
      sender: { sender_id: { user_id: o.userId, open_id: o.openId ?? `ou_${o.userId ?? "x"}` }, sender_type: "user" },
      message: {
        message_id: o.msgId ?? `om_${n}`,
        chat_id: o.chatId,
        chat_type: o.chatType ?? "group",
        message_type: o.type ?? "text",
        create_time: String(Date.now()),
        content: JSON.stringify(o.content ?? { text: `${o.atBot === false ? "" : "@_user_1 "}${o.text ?? ""}` }),
        mentions,
      },
    },
  };
}

describe("S9 Feishu — event parsing", () => {
  test("group text @bot → message; the bot mention is dropped, others become @name; p2p is private", () => {
    const ev = parseFeishuEvent(
      {
        header: { event_type: "im.message.receive_v1" },
        event: {
          ...receive({ chatId: "oc_1", userId: "u1", text: "支付超时 @_user_2 帮看下" }).event,
          message: {
            ...receive({ chatId: "oc_1", userId: "u1" }).event.message,
            content: JSON.stringify({ text: "@_user_1 支付超时 @_user_2 帮看下" }),
            mentions: [
              { key: "@_user_1", id: { open_id: BOT }, name: "bot" },
              { key: "@_user_2", id: { open_id: "ou_2" }, name: "李成员" },
            ],
          },
        },
      },
      BOT,
    );
    expect(ev).toMatchObject({ kind: "message", provider: "feishu", chatId: "oc_1", chatType: "group", senderId: "u1", text: "支付超时 @李成员 帮看下", atBot: true });
    const dm = parseFeishuEvent(receive({ chatId: "oc_dm", chatType: "p2p", openId: "ou_9", atBot: false, text: "ABCD2345" }), BOT);
    expect(dm).toMatchObject({ chatType: "private", senderId: "open:ou_9", atBot: true, text: "ABCD2345" });
    // a group message that doesn't @ the bot (all-messages permission)
    expect(parseFeishuEvent(receive({ chatId: "oc_1", userId: "u1", text: "随便聊", atBot: false }), BOT)).toMatchObject({ atBot: false });
  });
  test("post with an image, image and file messages carry downloadable refs; app senders are ignored", () => {
    const post = parseFeishuEvent(
      receive({
        chatId: "oc_1",
        userId: "u1",
        type: "post",
        content: {
          zh_cn: {
            title: "日志",
            content: [
              [
                { tag: "at", user_id: BOT },
                { tag: "text", text: "见附件" },
              ],
              [{ tag: "img", image_key: "img_1" }],
            ],
          },
        },
      }),
      BOT,
    );
    expect(post).toMatchObject({ text: "日志\n见附件" });
    expect((post as { attachments: Array<{ ref: string }> }).attachments[0]!.ref).toMatch(/\|image:img_1$/);
    const file = parseFeishuEvent(receive({ chatId: "oc_1", userId: "u1", type: "file", content: { file_key: "f_1", file_name: "trace.txt" } }), BOT);
    expect((file as { attachments: Array<{ name: string }> }).attachments[0]!.name).toBe("trace.txt");
    const fromApp = receive({ chatId: "oc_1", userId: "u1", text: "x" });
    (fromApp.event.sender as { sender_type: string }).sender_type = "app";
    expect(parseFeishuEvent(fromApp, BOT)).toBeNull();
  });
  test("recall by the author, chat disbanded, bot removed, app uninstalled", () => {
    expect(parseFeishuEvent({ header: { event_type: "im.message.recalled_v1" }, event: { message_id: "om_1", chat_id: "oc_1", recall_type: "message_owner" } }, BOT)).toMatchObject({
      kind: "recall",
      byAuthor: true,
    });
    expect(parseFeishuEvent({ header: { event_type: "im.message.recalled_v1" }, event: { message_id: "om_1", chat_id: "oc_1", recall_type: "group_owner" } }, BOT)).toBeNull();
    expect(parseFeishuEvent({ header: { event_type: "im.chat.disbanded_v1" }, event: { chat_id: "oc_1" } }, BOT)).toEqual({
      kind: "lifecycle",
      provider: "feishu",
      chatId: "oc_1",
      event: "chat_disbanded",
    });
    expect(parseFeishuEvent({ header: { event_type: "im.chat.member.bot.deleted_v1" }, event: { chat_id: "oc_1" } }, BOT)?.kind).toBe("lifecycle");
    expect(parseFeishuEvent({ header: { event_type: "application.application.app_uninstalled_v6" }, event: {} }, BOT)).toMatchObject({ event: "app_revoked" });
  });
  test("decrypt and sign the way Feishu does; errors map to lifecycle / throttling", () => {
    expect(decryptFeishu(encrypt('{"a":1}'), ENCRYPT_KEY)).toBe('{"a":1}');
    expect(feishuSignature("1", "n", "k", "b")).toBe(createHash("sha256").update("1nkb").digest("hex"));
    expect(classifyFeishuError(400, { code: 230002, msg: "Bot is not in the chat" })).toBeInstanceOf(ImLifecycleError);
    expect(classifyFeishuError(400, { code: 99991400, msg: "request trigger frequency limit" })).toBeInstanceOf(ImThrottled);
    expect(classifyFeishuError(500, { code: 1, msg: "internal" })).not.toBeInstanceOf(ImLifecycleError);
  });
});

/** A fake Feishu OpenAPI: token, bot info, send, reply, resources. */
function fakeFeishu() {
  const calls: Array<{ method: string; path: string; body: any; auth: string | null }> = [];
  let tokens = 0;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method: init?.method ?? "GET", path: u.pathname + u.search, body, auth: new Headers(init?.headers).get("authorization") });
    if (u.pathname === "/open-apis/auth/v3/tenant_access_token/internal") return Response.json({ code: 0, tenant_access_token: `t-${++tokens}`, expire: 7200 });
    if (u.pathname === "/open-apis/bot/v3/info") return Response.json({ code: 0, bot: { open_id: BOT } });
    if (u.pathname.startsWith("/open-apis/im/v1/messages")) return Response.json({ code: 0, data: { message_id: `om_out_${calls.length}` } });
    return Response.json({ code: 404, msg: "not found" }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch: fakeFetch, calls, tokens: () => tokens };
}

describe("S9 Feishu — OpenAPI", () => {
  test("token cached; group send is an interactive card with a markdown element; reply threads to the message; DM by open_id", async () => {
    const fk = fakeFeishu();
    const fs = createFeishuAdapter({ appId: "cli_x", appSecret: "s", fetch: fk.fetch });
    await fs.adapter.sendGroup("oc_1", { title: "船长", markdown: "**船长**\n\n收到" });
    await fs.adapter.reply({ chatId: "oc_1", chatType: "group", senderId: "u1", messageId: "om_9" }, { title: "回执", markdown: "ok" });
    await fs.adapter.reply({ chatId: "oc_dm", chatType: "private", senderId: "open:ou_9" }, { title: "回执", markdown: "绑定成功" });
    expect(fk.tokens()).toBe(1);
    const send = fk.calls.find((c) => c.path.startsWith("/open-apis/im/v1/messages?receive_id_type=chat_id"))!;
    expect(send.auth).toBe("Bearer t-1");
    expect(send.body).toMatchObject({ receive_id: "oc_1", msg_type: "interactive" });
    expect(JSON.parse(send.body.content)).toMatchObject({ header: { title: { content: "船长" } }, elements: [{ tag: "markdown", content: "**船长**\n\n收到" }] });
    expect(fk.calls.some((c) => c.path === "/open-apis/im/v1/messages/om_9/reply")).toBe(true);
    expect(fk.calls.find((c) => c.path.includes("receive_id_type=open_id"))?.body.receive_id).toBe("ou_9");
  });
});

describe("S9 Feishu — through /api/v1/webhooks/feishu (encrypted, signed)", () => {
  let t: TestApp;
  const fk = fakeFeishu();
  const fs = createFeishuAdapter({ appId: "cli_x", appSecret: "s", verificationToken: VTOKEN, encryptKey: ENCRYPT_KEY, fetch: fk.fetch });
  let owner = "";
  let projectId = "";
  let groupId = "";
  const CHAT = "oc_pay";
  const post = async (payload: unknown, o: { badSig?: boolean; plain?: boolean } = {}) => {
    const raw = o.plain ? JSON.stringify(payload) : JSON.stringify({ encrypt: encrypt(JSON.stringify(payload)) });
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = "nonce-1";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (!o.plain)
      Object.assign(headers, { "x-lark-request-timestamp": ts, "x-lark-request-nonce": nonce, "x-lark-signature": o.badSig ? "0".repeat(64) : feishuSignature(ts, nonce, ENCRYPT_KEY, raw) });
    const res = await t.app.handle(new Request("http://localhost/api/v1/webhooks/feishu", { method: "POST", headers, body: raw }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const cycle = async () => {
    for (let i = 0; i < 4; i++) {
      await t.s.consumers.drain();
      await t.s.jobs.drain();
    }
  };
  const lastReply = () => {
    const r = fk.calls.filter((c) => c.path.includes("/reply") || c.path.includes("receive_id_type=open_id") || c.path.includes("receive_id_type=user_id")).at(-1);
    return r ? (JSON.parse(r.body.content) as { elements: Array<{ content: string }> }).elements[0]!.content : "";
  };

  beforeAll(async () => {
    t = await createTestApp("s9feishu", { PUBLIC_URL: "https://agents.example.com" }, { imAdapters: [fs.adapter], feishu: fs });
    owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "F", email: "o@f.test", name: "王负责人", password: "Correct-Horse-42" } })).body.token;
    const p = await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "PAY", name: "支付服务" } });
    projectId = p.body.id;
    groupId = p.body.mainGroupId;
    const agents = (await t.req("GET", `/api/v1/projects/${projectId}/agents`, { token: owner })).body as Array<{ id: string; role: string }>;
    await t.s.db.root
      .update(agent)
      .set({ modelPolicy: { primary: "scripted:demo" } })
      .where(eq(agent.id, agents.find((a) => a.role === "sub_captain")!.id));
    const { registerHandlers } = await import("../src/modules/registry");
    await registerHandlers(t.s);
    await t.s.consumers.init();
    await t.s.db.root.delete(job).where(eq(job.type, "flow.sweep"));
  });
  afterAll(async () => t?.close());

  test("url_verification answers the challenge; a bad signature or token is refused", async () => {
    expect(await post({ type: "url_verification", challenge: "abc", token: VTOKEN }, { plain: true })).toEqual({ status: 200, body: { challenge: "abc" } });
    expect((await post({ type: "url_verification", challenge: "abc", token: "wrong" }, { plain: true })).status).toBe(401);
    expect((await post(receive({ chatId: CHAT, userId: "u_owner", text: "x" }), { badSig: true })).status).toBe(401);
  });

  test("DM a bind code → identity mapped; /bind PAY in the group binds it", async () => {
    const code = await t.req("POST", "/api/v1/external-identities", { token: owner, body: { provider: "feishu" } });
    expect(code.status).toBe(200);
    expect((await post(receive({ chatId: "oc_dm_owner", chatType: "p2p", userId: "u_owner", atBot: false, text: code.body.code }))).status).toBe(200);
    await cycle();
    expect(lastReply()).toContain("绑定成功");
    const [x] = await t.s.db.root.select().from(externalIdentity).where(eq(externalIdentity.provider, "feishu"));
    expect(x!.externalUserId).toBe("u_owner");
    await post(receive({ chatId: CHAT, userId: "u_owner", text: "/bind PAY" }));
    await cycle();
    expect(lastReply()).toContain("已绑定到项目「支付服务」主群");
    const [b] = await t.s.db.root.select().from(binding).where(eq(binding.provider, "feishu"));
    expect(b).toMatchObject({ externalChatId: CHAT, groupId, status: "active" });
  });

  test("@bot in the group wakes the captain; its reply is mirrored to the Feishu group as a card; redelivery is ignored", async () => {
    const ev = receive({ chatId: CHAT, userId: "u_owner", text: "支付服务最近超时，帮我查一下", msgId: "om_ask" });
    await post(ev);
    await post(ev); // Feishu retries the same event
    await cycle();
    const rows = await t.s.db.root
      .select()
      .from(message)
      .where(and(eq(message.source, "feishu"), eq(message.externalId, "om_ask")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authorLabel).toBe("王负责人");
    const sent = fk.calls.filter((c) => c.path === "/open-apis/im/v1/messages?receive_id_type=chat_id" && c.body.receive_id === CHAT);
    expect(sent.some((c) => JSON.parse(c.body.content).elements[0].content.includes("支付服务最近超时"))).toBe(true);
  });

  test("an unmapped Feishu user is 外部成员; the author's recall is synced; bot removed invalidates the binding", async () => {
    await post(receive({ chatId: CHAT, openId: "ou_stranger", text: "我是外部的", msgId: "om_ext" }));
    await cycle();
    const [m] = await t.s.db.root.select().from(message).where(eq(message.externalId, "om_ext"));
    expect(m!.authorLabel).toBe("外部成员");
    await post({ header: { event_id: "ev-recall", event_type: "im.message.recalled_v1", token: VTOKEN }, event: { message_id: "om_ext", chat_id: CHAT, recall_type: "message_owner" } });
    await cycle();
    const [after] = await t.s.db.root.select().from(message).where(eq(message.externalId, "om_ext"));
    expect(after!.deletedAt).not.toBeNull();
    await post({ header: { event_id: "ev-bye", event_type: "im.chat.member.bot.deleted_v1", token: VTOKEN }, event: { chat_id: CHAT } });
    await cycle();
    const [b] = await t.s.db.root.select().from(binding).where(eq(binding.provider, "feishu"));
    expect(b).toMatchObject({ status: "invalid", invalidReason: "bot_removed" });
  });
});
