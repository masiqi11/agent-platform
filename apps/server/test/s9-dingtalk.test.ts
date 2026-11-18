import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { classifyError, createDingTalkAdapter, parseBotMessage, parseLifecycleEvent, BOT_TOPIC } from "../src/modules/im/dingtalk";
import { createStreamHolder } from "../src/modules/im/stream";
import { ImLifecycleError, ImThrottled, type ImInbound } from "../src/modules/im/types";
import { createTestDatabase } from "./helpers";

/** A bot callback as DingTalk delivers it in Stream mode (fields per the robot docs). */
const groupCallback = {
  conversationId: "cidPAYgroup==",
  atUsers: [{ dingtalkId: "$:LWCP_v1:$bot" }],
  chatbotCorpId: "dingcorp",
  chatbotUserId: "$:LWCP_v1:$bot",
  msgId: "msgQ1w2e3",
  senderNick: "李成员",
  isAdmin: false,
  senderStaffId: "staff-member",
  sessionWebhookExpiredTime: Date.now() + 3600_000,
  createAt: 1763380000000,
  senderCorpId: "dingcorp",
  conversationType: "2",
  senderId: "$:LWCP_v1:$sender",
  conversationTitle: "支付服务群",
  isInAtList: true,
  sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=abc",
  text: { content: " 支付服务最近超时，帮我查一下" },
  robotCode: "dingbotcode",
  msgtype: "text",
};

/** Fake-fetch helpers: the adapter only passes string URLs and JSON string bodies. */
const urlOf = (input: RequestInfo | URL) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
const jsonBody = (init?: RequestInit) => (typeof init?.body === "string" ? JSON.parse(init.body) : null);

describe("S9 DingTalk — wire format", () => {
  test("group text @bot → message event with staffId, reply webhook and title", () => {
    const ev = parseBotMessage(groupCallback)!;
    expect(ev).toMatchObject({
      kind: "message",
      provider: "dingtalk",
      msgId: "msgQ1w2e3",
      chatId: "cidPAYgroup==",
      chatType: "group",
      chatTitle: "支付服务群",
      senderId: "staff-member",
      senderNick: "李成员",
      text: "支付服务最近超时，帮我查一下",
      atBot: true,
    });
    expect(ev.reply?.webhook).toContain("sendBySession");
  });
  test("private chat, picture and file messages; a guest without staffId never looks like staff", () => {
    const dm = parseBotMessage({ ...groupCallback, conversationType: "1", text: { content: "ABCD2345" } })!;
    expect(dm.chatType).toBe("private");
    const pic = parseBotMessage({ ...groupCallback, msgtype: "picture", content: { downloadCode: "dl-1" } })!;
    expect(pic.attachments).toEqual([{ ref: "dl-1", name: "image.png", mime: "image/png" }]);
    const file = parseBotMessage({ ...groupCallback, msgtype: "file", content: { downloadCode: "dl-2", fileName: "trace.txt" } })!;
    expect(file.attachments?.[0]).toMatchObject({ ref: "dl-2", name: "trace.txt" });
    const guest = parseBotMessage({ ...groupCallback, senderStaffId: undefined })!;
    expect(guest.senderId).toBe("ext:$:LWCP_v1:$sender");
    expect(parseBotMessage({ ...groupCallback, msgId: undefined })).toBeNull();
  });
  test("lifecycle events and error classification (IM-补3, FR-IM-08)", () => {
    expect(parseLifecycleEvent({ eventType: "chat_disband" }, { openConversationId: "cid1" })).toEqual({ kind: "lifecycle", provider: "dingtalk", chatId: "cid1", event: "chat_disbanded" });
    expect(parseLifecycleEvent({ eventType: "org_micro_app_remove" }, {})?.event).toBe("app_revoked");
    expect(parseLifecycleEvent({ eventType: "user_add_org" }, {})).toBeNull();
    expect(classifyError(429, {})).toBeInstanceOf(ImThrottled);
    expect(classifyError(400, { code: "Throttling.Api", message: "too many" })).toBeInstanceOf(ImThrottled);
    const gone = classifyError(400, { code: "robot.notInGroup", message: "robot not in group" });
    expect(gone).toBeInstanceOf(ImLifecycleError);
    expect((gone as ImLifecycleError).event).toBe("bot_removed");
    expect((classifyError(400, { code: "invalidParameter.conversation.notExist", message: "conversation not exist" }) as ImLifecycleError).event).toBe("chat_disbanded");
    const plain = classifyError(500, { code: "ServiceUnavailable" });
    expect(plain).not.toBeInstanceOf(ImLifecycleError);
    expect(plain).not.toBeInstanceOf(ImThrottled);
  });
});

describe("S9 DingTalk — OpenAPI", () => {
  test("token is fetched once and cached; group send uses markdown with the robot code", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: jsonBody(init) });
      if (url.endsWith("/v1.0/oauth2/accessToken")) return Response.json({ accessToken: "tok-1", expireIn: 7200 });
      if (url.endsWith("/v1.0/robot/groupMessages/send")) return Response.json({ processQueryKey: `pqk-${calls.length}` });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const dt = createDingTalkAdapter({ clientId: "appkey", clientSecret: "s3cret", robotCode: "dingbotcode", fetch: fake });
    const a = await dt.adapter.sendGroup("cidPAYgroup==", { title: "船长", markdown: "**船长**\n\n收到" });
    await dt.adapter.sendGroup("cidPAYgroup==", { title: "船长", markdown: "再一条" });
    expect(a.externalMessageId).toBe("pqk-2");
    expect(calls.filter((c) => c.url.endsWith("accessToken"))).toHaveLength(1);
    const send = calls.find((c) => c.url.endsWith("groupMessages/send"))!;
    expect(send.headers["x-acs-dingtalk-access-token"]).toBe("tok-1");
    expect(send.body).toMatchObject({ robotCode: "dingbotcode", openConversationId: "cidPAYgroup==", msgKey: "sampleMarkdown" });
    expect(JSON.parse(send.body.msgParam)).toEqual({ title: "船长", text: "**船长**\n\n收到" });
  });
  test("a removed robot surfaces as a lifecycle error; reply prefers the session webhook", async () => {
    const urls: string[] = [];
    const fake = (async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      urls.push(url);
      if (url.endsWith("/accessToken")) return Response.json({ accessToken: "tok", expireIn: 7200 });
      if (url.includes("sendBySession")) return Response.json({ errcode: 0 });
      return Response.json({ code: "robot.notInGroup", message: "robot not in group" }, { status: 400 });
    }) as typeof fetch;
    const dt = createDingTalkAdapter({ clientId: "k", clientSecret: "s", fetch: fake });
    await expect(dt.adapter.sendGroup("cid", { title: "t", markdown: "m" })).rejects.toBeInstanceOf(ImLifecycleError);
    await dt.adapter.reply(
      { chatId: "cid", chatType: "group", senderId: "staff", webhook: "https://oapi.dingtalk.com/robot/sendBySession?session=x", expiresAt: Date.now() + 60_000 },
      { title: "回执", markdown: "ok" },
    );
    expect(urls.at(-1)).toContain("sendBySession");
  });
});

describe("S9 DingTalk — Stream session against a fake gateway", () => {
  let server: ReturnType<typeof Bun.serve>;
  const fromClient: any[] = [];
  let sock: { send(s: string): void; close(): void } | null = null;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).searchParams.get("ticket") === "tkt-1" && srv.upgrade(req, { data: undefined })) return undefined;
        return new Response("no", { status: 401 });
      },
      websocket: {
        open(ws) {
          sock = ws;
        },
        message(_ws, m) {
          fromClient.push(JSON.parse(String(m)));
        },
      },
    });
  });
  afterAll(() => server.stop(true));

  test("ping is answered, a bot callback becomes an event and is acked by messageId, disconnect ends the session", async () => {
    const opened: any[] = [];
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input).endsWith("/v1.0/gateway/connections/open")) {
        opened.push(jsonBody(init));
        return Response.json({ endpoint: `ws://127.0.0.1:${server.port}/connect`, ticket: "tkt-1" });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const dt = createDingTalkAdapter({ clientId: "appkey", clientSecret: "s3cret", fetch: fake });
    const got: ImInbound[] = [];
    const states: boolean[] = [];
    const ac = new AbortController();
    const done = dt.runStream(
      async (ev) => {
        got.push(ev);
      },
      ac.signal,
      (s) => states.push(s.connected),
    );
    for (let i = 0; i < 50 && !sock; i++) await Bun.sleep(20);
    sock!.send(JSON.stringify({ specVersion: "1.0", type: "SYSTEM", headers: { topic: "ping", messageId: "p-1", contentType: "application/json" }, data: JSON.stringify({ opaque: "x" }) }));
    sock!.send(JSON.stringify({ specVersion: "1.0", type: "CALLBACK", headers: { topic: BOT_TOPIC, messageId: "m-1", contentType: "application/json" }, data: JSON.stringify(groupCallback) }));
    sock!.send(
      JSON.stringify({ specVersion: "1.0", type: "EVENT", headers: { topic: "*", eventType: "chat_disband", messageId: "e-1" }, data: JSON.stringify({ openConversationId: "cidPAYgroup==" }) }),
    );
    for (let i = 0; i < 50 && fromClient.length < 3; i++) await Bun.sleep(20);
    expect(opened[0]).toMatchObject({ clientId: "appkey", subscriptions: expect.arrayContaining([{ type: "CALLBACK", topic: BOT_TOPIC }]) });
    expect(fromClient.find((f) => f.headers.messageId === "p-1")).toMatchObject({ code: 200, data: JSON.stringify({ opaque: "x" }) });
    expect(fromClient.find((f) => f.headers.messageId === "m-1")).toMatchObject({ code: 200, message: "OK" });
    expect(fromClient.find((f) => f.headers.messageId === "e-1")?.code).toBe(200);
    expect(got.map((e) => e.kind)).toEqual(["message", "lifecycle"]);
    sock!.send(JSON.stringify({ type: "SYSTEM", headers: { topic: "disconnect", messageId: "d-1" }, data: "{}" }));
    await done;
    expect(states).toEqual([true, false]);
  });

  test("a frame whose handler fails is not acknowledged (DingTalk redelivers)", async () => {
    sock = null;
    fromClient.length = 0;
    const fake = (async () => Response.json({ endpoint: `ws://127.0.0.1:${server.port}/connect`, ticket: "tkt-1" })) as unknown as typeof fetch;
    const dt = createDingTalkAdapter({ clientId: "k", clientSecret: "s", fetch: fake });
    const ac = new AbortController();
    const done = dt.runStream(async () => {
      throw new Error("db down");
    }, ac.signal);
    for (let i = 0; i < 50 && !sock; i++) await Bun.sleep(20);
    sock!.send(JSON.stringify({ type: "CALLBACK", headers: { topic: BOT_TOPIC, messageId: "m-2" }, data: JSON.stringify(groupCallback) }));
    await Bun.sleep(150);
    expect(fromClient.find((f) => f.headers?.messageId === "m-2")).toBeUndefined();
    ac.abort();
    await done;
  });
});

describe("S9 DingTalk — the Stream is held by one instance (lease)", () => {
  test("two holders: only one runs; when it stops, the other takes over", async () => {
    const db = await createTestDatabase("s9lease");
    const running: string[] = [];
    const mk = (who: string) =>
      createStreamHolder({
        databaseUrl: db.url,
        name: "dingtalk",
        retryMs: 100,
        run: async (signal, onState) => {
          running.push(who);
          onState({ connected: true });
          await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
        },
      });
    const a = mk("a");
    const b = mk("b");
    try {
      a.start();
      for (let i = 0; i < 50 && !a.status().holder; i++) await Bun.sleep(20);
      b.start();
      await Bun.sleep(400);
      expect(a.status()).toMatchObject({ holder: true, connected: true });
      expect(b.status().holder).toBe(false);
      expect(running).toEqual(["a"]);
      await a.stop();
      for (let i = 0; i < 50 && !b.status().holder; i++) await Bun.sleep(20);
      expect(b.status()).toMatchObject({ holder: true, connected: true });
      expect(running).toEqual(["a", "b"]);
    } finally {
      await a.stop();
      await b.stop();
      await db.drop();
    }
  });

  test("#15: stop() while the lease connection is still being opened never starts a session", async () => {
    const db = await createTestDatabase("s9lease2");
    const running: string[] = [];
    const mk = (who: string) =>
      createStreamHolder({
        databaseUrl: db.url,
        name: "dingtalk",
        retryMs: 100,
        run: async (signal, onState) => {
          running.push(who);
          onState({ connected: true });
          await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
        },
      });
    const a = mk("a");
    const b = mk("b");
    try {
      a.start();
      // Same tick: acquire() is still connecting.
      const stopped = await Promise.race([a.stop().then(() => "stopped"), Bun.sleep(3_000).then(() => "hung")]);
      expect(stopped).toBe("stopped");
      await Bun.sleep(300);
      expect(running).toEqual([]);
      expect(a.status().holder).toBe(false);
      // The lock is free: a second instance takes over on its first attempt.
      b.start();
      for (let i = 0; i < 50 && !b.status().holder; i++) await Bun.sleep(20);
      expect(b.status()).toMatchObject({ holder: true, connected: true });
      expect(running).toEqual(["b"]);
      // And stopping right after acquisition, repeatedly, never leaks a session or the lock.
      for (let i = 0; i < 5; i++) {
        const c = mk(`c${i}`);
        c.start();
        await Bun.sleep(i * 3);
        await c.stop();
      }
      await b.stop();
      const d = mk("d");
      d.start();
      for (let i = 0; i < 50 && !d.status().holder; i++) await Bun.sleep(20);
      expect(d.status().holder).toBe(true);
      await d.stop();
      expect(running.filter((x) => x.startsWith("c"))).toEqual([]);
    } finally {
      await a.stop();
      await b.stop();
      await db.drop();
    }
  }, 20_000);
});
