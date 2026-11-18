import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agent, appUser, attachment, binding, deadLetter, event, externalIdentity, inboxItem, job, message, outboundDelivery, principal, proposal, question, task } from "../src/db/schema";
import { createMockImAdapter } from "../src/modules/im/mock";
import { degradeMarkdown, renderForIm, truncateWithLink } from "../src/modules/im/render";
import { quietUntil } from "../src/modules/im/service";
import type { ImInbound } from "../src/modules/im/types";
import { createTestApp, type TestApp } from "./helpers";

process.env.LLM_BACKOFF_MS = "2";
const PW = "Correct-Horse-42";
const CHAT = "cid-pay-group";
let t: TestApp;
const im = createMockImAdapter({ provider: "dingtalk", maxChars: 1200 });
let owner = "";
let member = "";
let memberUser = "";
let memberPrincipal = "";
let projectId = "";
let groupId = "";
let cap = { id: "", principalId: "" };
let n = 0;

async function join(email: string, name: string) {
  const inv = await t.req("POST", "/api/v1/invitations", { token: owner, body: { tenantRole: "member" } });
  const acc = await t.req("POST", `/api/v1/invitations/${inv.body.token}/accept`, { body: { email, name, password: PW } });
  const me = (await t.req("GET", "/api/v1/me", { token: acc.body.token })).body;
  return { token: acc.body.token as string, principalId: me.principalId as string, userId: me.userId as string };
}

/** One scheduling cycle: events → consumers → jobs (inbound, captain turns, deliveries). */
async function cycle(times = 2) {
  for (let i = 0; i < times; i++) {
    await t.s.consumers.drain();
    await t.s.jobs.drain();
  }
  await t.s.consumers.drain();
}

type Msg = Extract<ImInbound, { kind: "message" }>;
function groupMsg(senderId: string, text: string, extra: Partial<Msg> = {}): Msg {
  const msgId = extra.msgId ?? `dt-msg-${++n}`;
  return {
    kind: "message",
    provider: "dingtalk",
    msgId,
    chatId: CHAT,
    chatType: "group",
    chatTitle: "支付服务群",
    senderId,
    senderNick: `昵称-${senderId}`,
    text,
    atBot: true,
    reply: { chatId: CHAT, chatType: "group", senderId },
    ...extra,
  };
}
const dm = (senderId: string, text: string): Msg => ({
  ...groupMsg(senderId, text),
  chatId: `dm-${senderId}`,
  chatType: "private",
  reply: { chatId: `dm-${senderId}`, chatType: "private", senderId },
});
const lastReply = () => im.replies.at(-1)?.msg.markdown ?? "";
const timeline = async () => (await t.s.db.root.select().from(message).where(eq(message.groupId, groupId)).orderBy(message.seq)) as Array<typeof message.$inferSelect>;
async function bindIdentity(token: string, staffId: string) {
  const code = await t.req("POST", "/api/v1/external-identities", { token, body: { provider: "dingtalk" } });
  expect(code.status).toBe(200);
  await t.s.im.receive(dm(staffId, code.body.code));
  await cycle(1);
  return code.body.code as string;
}

beforeAll(async () => {
  t = await createTestApp("s9im", { PUBLIC_URL: "https://agents.example.com" }, { imAdapters: [im] });
  const setup = await t.req("POST", "/api/v1/setup", { body: { tenantName: "S9", email: "o@s9.test", name: "王负责人", password: PW } });
  owner = setup.body.token;
  const m = await join("m@s9.test", "李成员");
  member = m.token;
  memberPrincipal = m.principalId;
  memberUser = m.userId;
  const p = await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "PAY", name: "支付服务", description: "支付网关、回调与对账" } });
  projectId = p.body.id;
  groupId = p.body.mainGroupId;
  await t.req("PUT", `/api/v1/projects/${projectId}/members/${m.principalId}`, { token: owner, body: { role: "member" } });
  await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name: "开发 A", role: "dev" } });
  const agents = (await t.req("GET", `/api/v1/projects/${projectId}/agents`, { token: owner })).body as Array<{ id: string; principalId: string; role: string }>;
  cap = agents.find((a) => a.role === "sub_captain")!;
  await t.s.db.root
    .update(agent)
    .set({ modelPolicy: { primary: "scripted:demo" } })
    .where(eq(agent.id, cap.id));
  const { registerHandlers } = await import("../src/modules/registry");
  await registerHandlers(t.s);
  await t.s.consumers.init();
  await t.s.db.root.delete(job).where(eq(job.type, "flow.sweep"));
});
afterAll(async () => t?.close());

describe("S9 IM — rendering (IM-补2)", () => {
  test("code fences, tables, inline code and HTML degrade to the DingTalk subset", () => {
    const md = degradeMarkdown("看这里：\n```ts\nconst a = 1;\n```\n| 列 | 值 |\n|---|---|\n| p99 | 30s |\n用 `retry` ~~不~~ <b>重要</b> @[prn_x]", { prn_x: "李成员" });
    expect(md).toContain("> const a = 1;");
    expect(md).toContain("p99 · 30s");
    expect(md).not.toContain("|---");
    expect(md).toContain("「retry」");
    expect(md).not.toContain("~~");
    expect(md).not.toContain("<b>");
    expect(md).toContain("@李成员");
  });
  test("overlong content is cut at a line and linked to the Web", () => {
    const long = Array.from({ length: 200 }, (_, i) => `第 ${i} 行：一些很长的排查记录`).join("\n");
    const out = truncateWithLink(long, 500, "https://x/chat?g=1&seq=9");
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain("[在 Web 查看完整内容](https://x/chat?g=1&seq=9)");
  });
  test("proposal and approval renders link to the Web and never offer a decision in IM (IM-补6)", () => {
    const p = renderForIm(
      { kind: "proposal_card", body: "", blocks: { payload: { title: "排查超时", acceptanceCriteria: ["p99 < 5s"] } }, authorLabel: "船长", authorKind: "agent", link: "https://x/p" },
      2000,
    );
    expect(p.markdown).toContain("p99 < 5s");
    expect(p.markdown).toContain("确认或驳回请到 Web");
    const a = renderForIm(
      { kind: "approval_notice", body: "", blocks: null, authorLabel: "系统", authorKind: "system", link: "https://x/t", extra: { approvalKind: "merge", taskRef: "PAY-1", taskTitle: "修复" } },
      2000,
    );
    expect(a.markdown).toContain("审批只能在 Web 完成");
  });
  test("quiet hours: inside the window → until its end; outside → null", () => {
    const s = { quietHours: { start: "22:00", end: "08:00", tz: "UTC" } };
    expect(quietUntil(s, new Date("2026-11-17T23:30:00Z"))?.toISOString()).toBe("2026-11-18T08:00:00.000Z");
    expect(quietUntil(s, new Date("2026-11-17T07:00:00Z"))?.toISOString()).toBe("2026-11-17T08:00:00.000Z");
    expect(quietUntil(s, new Date("2026-11-17T12:00:00Z"))).toBeNull();
  });
});

describe("S9 IM — identity and binding (FR-IM-02, -05, IM-补1, -5)", () => {
  test("an unbound group answers @ with how to bind; /bind from an unmapped account is refused", async () => {
    await t.s.im.receive(groupMsg("staff-owner", "你好"));
    await cycle(1);
    expect(lastReply()).toContain("还没有绑定项目");
    await t.s.im.receive(groupMsg("staff-owner", "/bind PAY"));
    await cycle(1);
    expect(lastReply()).toContain("只有已绑定身份的成员");
    expect(await t.s.db.root.select().from(binding)).toHaveLength(0);
  });

  test("bind code by DM maps the IM account; a used or wrong code does nothing", async () => {
    const code = await bindIdentity(owner, "staff-owner");
    expect(lastReply()).toContain("绑定成功");
    await bindIdentity(member, "staff-member");
    const ids = await t.s.db.root.select().from(externalIdentity);
    expect(ids.map((x) => x.externalUserId).sort()).toEqual(["staff-member", "staff-owner"]);
    // replay the same code from another account: already used
    await t.s.im.receive(dm("staff-thief", code));
    await cycle(1);
    expect(lastReply()).toContain("无效或已过期");
    expect((await t.s.db.root.select().from(externalIdentity).where(eq(externalIdentity.externalUserId, "staff-thief"))).length).toBe(0);
    const mine = await t.req("GET", "/api/v1/me/external-identities", { token: member });
    expect(mine.body[0].externalUserId).toBe("staff-member");
  });

  test("/bind by a Member is refused (needs Maintainer); by the owner binds this chat to the main group, once", async () => {
    await t.s.im.receive(groupMsg("staff-member", "/bind PAY"));
    await cycle(1);
    expect(lastReply()).toContain("绑定失败");
    await t.s.im.receive(groupMsg("staff-owner", "/bind PAY"));
    await cycle(1);
    expect(lastReply()).toContain("已绑定到项目「支付服务」主群");
    const [b] = await t.s.db.root.select().from(binding);
    expect(b).toMatchObject({ groupId, externalChatId: CHAT, mode: "at_only", status: "active", chatTitle: "支付服务群" });
    // FR-IM-02: one-to-one — the same chat again, or the same group with another chat
    const again = await t.req("POST", "/api/v1/bindings", { token: owner, body: { groupId, provider: "dingtalk", externalChatId: CHAT } });
    expect(again.status).toBe(409);
    const other = await t.req("POST", "/api/v1/bindings", { token: owner, body: { groupId, provider: "dingtalk", externalChatId: "another-chat" } });
    expect(other.status).toBe(409);
    const list = await t.req("GET", `/api/v1/projects/${projectId}/bindings`, { token: member });
    expect(list.body).toHaveLength(1);
  });
});

describe("S9 IM — main scenario steps 1–3 from the IM group, the rest in the Web (exit criteria)", () => {
  test("@bot → captain reply + follow-up mirrored; answer → proposal mirrored as a link; accept in Web", async () => {
    im.reset();
    const before = (await timeline()).length;
    // 1 — a mapped member asks in the DingTalk group (@ the bot)
    await t.s.im.receive(groupMsg("staff-member", "支付服务最近超时，帮我查一下", { msgId: "dt-step1" }));
    await cycle(3);
    const tl = await timeline();
    const asked = tl.find((m) => m.externalId === "dt-step1")!;
    // written as the real person (no forged identity), addressed to the captain
    expect(asked.authorPrincipalId).toBe(memberPrincipal);
    expect(asked.authorLabel).toBe("李成员");
    expect(asked.source).toBe("dingtalk");
    expect(asked.mentions).toContain(cap.principalId);
    expect(asked.body).not.toContain("@[");
    // 2 — the captain restates and asks; both are mirrored to the group
    const reply = tl.find((m) => m.seq > asked.seq && m.authorPrincipalId === cap.principalId && m.kind === "text");
    const qcard = tl.find((m) => m.seq > asked.seq && m.kind === "question");
    expect(reply?.body).toContain("支付服务最近超时");
    expect(qcard).toBeTruthy();
    expect(im.sent.some((s) => s.chatId === CHAT && s.msg.markdown.includes("支付服务最近超时"))).toBe(true);
    expect(im.sent.some((s) => s.msg.markdown.includes("追问"))).toBe(true);
    // the IM-originated message itself is not echoed back
    expect(im.sent.some((s) => s.msg.markdown.startsWith("**李成员"))).toBe(false);

    // 3 — details from the group → proposal with acceptance criteria, mirrored with a Web link
    await t.s.im.receive(groupMsg("staff-member", "从昨天下午 3 点开始，/pay/callback 接口 p99 超过 5 秒，错误率 8%", { msgId: "dt-step3" }));
    await cycle(3);
    const [q] = await t.s.db.root.select().from(question).where(eq(question.groupId, groupId));
    expect(q!.status).toBe("answered");
    const [prp] = await t.s.db.root
      .select()
      .from(proposal)
      .where(and(eq(proposal.groupId, groupId), eq(proposal.status, "pending")));
    expect((prp!.payload.acceptanceCriteria as string[]).length).toBeGreaterThan(0);
    const pmsg = im.sent.find((s) => s.msg.title.startsWith("任务提议"));
    expect(pmsg?.msg.markdown).toContain("https://agents.example.com/projects/");
    expect(pmsg?.msg.markdown).toContain("确认或驳回请到 Web");
    expect((await timeline()).length).toBeGreaterThan(before + 3);

    // 4 — the rest happens in the Web (INV-06): accept the proposal there; the task card is mirrored
    const acc = await t.req("POST", `/api/v1/proposals/${prp!.id}/accept`, { token: member });
    expect(acc.status).toBe(200);
    await cycle(2);
    expect(im.sent.some((s) => s.msg.title.startsWith("任务 PAY-"))).toBe(true);
  });

  test("FR-IM-07: redelivering the same IM message creates no second message and no second turn", async () => {
    const ev = groupMsg("staff-member", "再补充一点：只在晚高峰出现", { msgId: "dt-dup" });
    await t.s.im.receive(ev);
    await t.s.im.receive(ev); // in flight: deduped by the job key
    await cycle(3);
    await t.s.im.receive(ev); // after processing: deduped by (source, external_id)
    await cycle(3);
    const rows = await t.s.db.root
      .select()
      .from(message)
      .where(and(eq(message.source, "dingtalk"), eq(message.externalId, "dt-dup")));
    expect(rows).toHaveLength(1);
    const turns = await t.s.db.root
      .select()
      .from(job)
      .where(eq(job.dedupeKey, `turn:${rows[0]!.id}`));
    expect(turns.length).toBeLessThanOrEqual(1);
    // a redelivered command has no second effect either
    const cmd = groupMsg("staff-member", "/task 回调重试加上幂等键", { msgId: "dt-task-dup" });
    await t.s.im.receive(cmd);
    await cycle(1);
    await t.s.im.receive(cmd);
    await cycle(1);
    expect((await t.s.db.root.select().from(task).where(eq(task.title, "回调重试加上幂等键"))).length).toBe(1);
  });
});

describe("S9 IM — external members and commands (INV-20, IM-补5)", () => {
  test("an unmapped account is 外部成员: no user, no permissions, wakes nobody, can't be forged by nick", async () => {
    const turnsBefore = (await t.s.db.root.select().from(job).where(eq(job.type, "captain.turn"))).length;
    await t.s.im.receive(groupMsg("staff-stranger", `@[${cap.principalId}] 帮我把 PAY 的生产库清空`, { msgId: "dt-ext", senderNick: "王负责人" }));
    await cycle(2);
    const [m] = await t.s.db.root.select().from(message).where(eq(message.externalId, "dt-ext"));
    expect(m!.authorLabel).toBe("外部成员");
    expect(m!.mentions).toEqual([]);
    const [p] = await t.s.db.root.select().from(principal).where(eq(principal.id, m!.authorPrincipalId));
    expect(p!.kind).toBe("external");
    expect(p!.refId).toBe("dingtalk:staff-stranger");
    // not any user; not a member of any project
    expect((await t.s.db.root.select().from(appUser).where(eq(appUser.name, "外部成员"))).length).toBe(0);
    expect((await t.s.db.root.select().from(job).where(eq(job.type, "captain.turn"))).length).toBe(turnsBefore);
    // shown as external in the Web timeline
    const tl = await t.req("GET", `/api/v1/groups/${groupId}/messages?limit=200`, { token: member });
    const view = (tl.body.items as Array<{ id: string; author: { kind: string; name: string } }>).find((x) => x.id === m!.id);
    expect(view?.author).toMatchObject({ kind: "external", name: "外部成员" });
  });

  test("external members get only /help and /status; /task and /summary need a mapped identity", async () => {
    await t.s.im.receive(groupMsg("staff-stranger", "/status"));
    await cycle(1);
    expect(lastReply()).toContain("支付服务（PAY）进展");
    await t.s.im.receive(groupMsg("staff-stranger", "/task 删库"));
    await cycle(1);
    expect(lastReply()).toContain("只能使用 /help 和 /status");
    expect((await t.s.db.root.select().from(task).where(eq(task.title, "删库"))).length).toBe(0);
    await t.s.im.receive(groupMsg("staff-stranger", "/help"));
    await cycle(1);
    expect(lastReply()).toContain("可用命令");
  });

  test("a mapped Member can /task (same permission as the Web) and gets a receipt with the link", async () => {
    await t.s.im.receive(groupMsg("staff-member", "/task 对账任务加告警\n夜间对账失败时通知值班"));
    await cycle(1);
    const [tk] = await t.s.db.root.select().from(task).where(eq(task.title, "对账任务加告警"));
    expect(tk!.description).toContain("夜间对账失败");
    expect(lastReply()).toContain(`/tasks/${tk!.id}`);
  });

  test("a mapped user who is not in the project is still not anyone else (INV-20)", async () => {
    const out = await join("x@s9.test", "赵局外");
    await bindIdentity(out.token, "staff-outsider");
    await t.s.im.receive(groupMsg("staff-outsider", "我也来看看", { msgId: "dt-outsider" }));
    await cycle(1);
    const [m] = await t.s.db.root.select().from(message).where(eq(message.externalId, "dt-outsider"));
    expect(m!.authorLabel).toBe("外部成员");
    expect(m!.authorPrincipalId).not.toBe(out.principalId);
    await t.s.im.receive(groupMsg("staff-outsider", "/task 越权"));
    await cycle(1);
    expect(lastReply()).toContain("无法执行 /task");
  });

  test("IM-补4: edit and recall in the IM sync to the platform message; nobody can edit another's", async () => {
    await t.s.im.receive(groupMsg("staff-member", "回调超时阈值是 3 秒", { msgId: "dt-edit" }));
    await cycle(1);
    await t.s.im.receive({ kind: "edit", provider: "dingtalk", msgId: "dt-edit", chatId: CHAT, senderId: "staff-stranger", text: "被别人改了" });
    await t.s.im.receive({ kind: "edit", provider: "dingtalk", msgId: "dt-edit", chatId: CHAT, senderId: "staff-member", text: "回调超时阈值是 5 秒" });
    await cycle(1);
    let [m] = await t.s.db.root.select().from(message).where(eq(message.externalId, "dt-edit"));
    expect(m!.body).toContain("5 秒");
    expect(m!.editedAt).not.toBeNull();
    await t.s.im.receive({ kind: "recall", provider: "dingtalk", msgId: "dt-edit", chatId: CHAT, senderId: "staff-member" });
    await cycle(1);
    [m] = await t.s.db.root.select().from(message).where(eq(message.externalId, "dt-edit"));
    expect(m!.deletedAt).not.toBeNull();
  });

  test("IM-补7: an attachment goes through the Web upload checks", async () => {
    im.files.set("dl-ok", { name: "trace.txt", mime: "text/plain", data: new TextEncoder().encode("p99=31s") });
    im.files.set("dl-bad", { name: "run.exe", mime: "application/x-msdownload", data: new Uint8Array([77, 90]) });
    await t.s.im.receive(
      groupMsg("staff-member", "日志见附件", {
        msgId: "dt-att",
        attachments: [
          { ref: "dl-ok", name: "trace.txt" },
          { ref: "dl-bad", name: "run.exe" },
        ],
      }),
    );
    await cycle(1);
    const [m] = await t.s.db.root.select().from(message).where(eq(message.externalId, "dt-att"));
    const atts = await t.s.db.root.select().from(attachment).where(eq(attachment.messageId, m!.id));
    expect(atts.map((a) => a.name)).toEqual(["trace.txt"]);
    expect(atts[0]!.uploadedBy).toBe(memberPrincipal);
    expect(m!.body).toContain("run.exe」未导入");
  });
});

describe("S9 IM — outbound delivery (FR-IM-04, -08; IM-补3, -8)", () => {
  const post = (body: string) => t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: owner, body: { body } });
  const sysNotice = async (body: string) => t.s.chat.send(await t.s.identity.systemCtx((await t.s.db.root.select().from(binding))[0]!.tenantId), { groupId, kind: "system", source: "system", body });

  test("human Web chatter is not mirrored unless the binding asks for it", async () => {
    im.reset();
    await post("Web 里的普通讨论");
    await cycle(1);
    expect(im.sent).toHaveLength(0);
    const [b] = await t.s.db.root.select().from(binding);
    await t.req("PATCH", `/api/v1/bindings/${b!.id}`, { token: owner, body: { settings: { mirrorHumans: true } } });
    await post("这条会同步");
    await cycle(1);
    expect(im.sent.at(-1)?.msg.markdown).toContain("**王负责人（Web）**");
    await t.req("PATCH", `/api/v1/bindings/${b!.id}`, { token: owner, body: { settings: { mirrorHumans: false } } });
  });

  test("a failing send retries, then dead-letters; replay sends it", async () => {
    im.reset();
    im.failNext(CHAT, "error", "error", "error", "error", "error", "error");
    await sysNotice("会失败的通知");
    for (let i = 0; i < 8; i++) {
      await cycle(1);
      await t.s.db.root.update(job).set({ runAt: new Date() }).where(eq(job.type, "im.deliver"));
    }
    const [o] = await t.s.db.root.select().from(outboundDelivery).where(eq(outboundDelivery.status, "dead"));
    expect(o).toBeTruthy();
    const [dl] = await t.s.db.root.select().from(deadLetter).where(eq(deadLetter.source, "job"));
    expect((dl!.payload as { type: string }).type).toBe("im.deliver");
    const r = await t.req("POST", `/api/v1/admin/dead-letters/${dl!.id}/replay`, { token: owner });
    expect(r.status).toBe(200);
    await cycle(1);
    const [after] = await t.s.db.root.select().from(outboundDelivery).where(eq(outboundDelivery.id, o!.id));
    expect(after!.status).toBe("sent");
    expect(im.sent.at(-1)?.msg.markdown).toContain("会失败的通知");
  });

  test("#16: delivery row and job are atomic; a replay heals a pending row with no job; concurrent and delivered replays add nothing", async () => {
    im.reset();
    const deliverJobs = async (ids: string[]) =>
      ids.length
        ? (
            await t.s.db.root
              .select()
              .from(job)
              .where(
                inArray(
                  job.dedupeKey,
                  ids.map((id) => `im.deliver:${id}`),
                ),
              )
          ).length
        : 0;
    // Hold the consumer back so the event can be handed to it by hand.
    const { message: m } = await sysNotice("入队中断的通知");
    const [ev] = await t.s.db.root
      .select()
      .from(event)
      .where(and(eq(event.type, "message.created"), sql`${event.payload}->>'messageId' = ${m.id}`));
    const domainEvent = { ...ev!, occurredAt: ev!.occurredAt.toISOString() } as unknown as Parameters<typeof t.s.im.consumer.handle>[0];
    const forMsg = () => t.s.db.root.select().from(outboundDelivery).where(eq(outboundDelivery.messageId, m.id));

    // 1. enqueue fails mid-way: nothing is left behind (no pending row without a job).
    const real = t.s.jobs.enqueue;
    t.s.jobs.enqueue = (async () => {
      throw new Error("simulated crash between row and job");
    }) as typeof real;
    try {
      await expect(t.s.im.consumer.handle(domainEvent)).rejects.toThrow("simulated crash");
    } finally {
      t.s.jobs.enqueue = real;
    }
    expect(await forMsg()).toHaveLength(0);

    // 2. A row left pending without a job (as an older version could leave it) is healed by the replay.
    await t.s.im.consumer.handle(domainEvent);
    const [row] = await forMsg();
    expect(row!.status).toBe("pending");
    await t.s.db.root.delete(job).where(eq(job.dedupeKey, `im.deliver:${row!.id}`));
    expect(await deliverJobs([row!.id])).toBe(0);
    await t.s.im.consumer.handle(domainEvent);
    expect(await deliverJobs([row!.id])).toBe(1);

    // 3. Concurrent replays: still one row and one queued job.
    await Promise.all([t.s.im.consumer.handle(domainEvent), t.s.im.consumer.handle(domainEvent), t.s.im.consumer.handle(domainEvent)]);
    expect(await forMsg()).toHaveLength(1);
    expect(await deliverJobs([row!.id])).toBe(1);

    // 4. Once delivered, a replay enqueues nothing and sends nothing again.
    await cycle(1);
    expect((await forMsg())[0]!.status).toBe("sent");
    expect(im.sent.filter((x) => x.msg.markdown.includes("入队中断的通知"))).toHaveLength(1);
    await t.s.im.consumer.handle(domainEvent);
    await cycle(1);
    expect(im.sent.filter((x) => x.msg.markdown.includes("入队中断的通知"))).toHaveLength(1);
    expect(
      await t.s.db.root
        .select()
        .from(job)
        .where(and(eq(job.dedupeKey, `im.deliver:${row!.id}`), inArray(job.status, ["queued", "running"]))),
    ).toHaveLength(0);
  });

  test("provider throttling waits without spending attempts", async () => {
    im.reset();
    im.failNext(CHAT, "throttle");
    await sysNotice("限流后的通知");
    await cycle(1);
    const [j] = await t.s.db.root
      .select()
      .from(job)
      .where(and(eq(job.type, "im.deliver"), eq(job.status, "queued")));
    expect(j!.lastError).toContain("限流");
    await t.s.db.root.update(job).set({ runAt: new Date() }).where(eq(job.id, j!.id));
    await cycle(1);
    expect(im.sent.at(-1)?.msg.markdown).toContain("限流后的通知");
  });

  test("quiet hours hold unsolicited mirrors until the window ends", async () => {
    im.reset();
    const [b] = await t.s.db.root.select().from(binding);
    await t.s.db.root
      .update(binding)
      .set({ settings: { quietHours: { start: "00:00", end: "23:59", tz: "UTC" } } })
      .where(eq(binding.id, b!.id));
    // no recent IM traffic → it's unsolicited
    await t.s.db.root
      .update(message)
      .set({ createdAt: new Date(Date.now() - 3600_000) })
      .where(eq(message.source, "dingtalk"));
    await sysNotice("夜间不该打扰的通知");
    await cycle(1);
    expect(im.sent).toHaveLength(0);
    const [o] = await t.s.db.root
      .select()
      .from(outboundDelivery)
      .where(and(eq(outboundDelivery.bindingId, b!.id), eq(outboundDelivery.status, "pending")));
    expect(o!.nextAttemptAt).not.toBeNull();
    await t.s.db.root.update(binding).set({ settings: {} }).where(eq(binding.id, b!.id));
    await t.s.db.root.update(job).set({ runAt: new Date() }).where(eq(job.type, "im.deliver"));
    await cycle(1);
    expect(im.sent.at(-1)?.msg.markdown).toContain("夜间不该打扰的通知");
  });

  test("IM-补3: bot removed → binding invalid, deliveries stop, Maintainers told; rebinding works", async () => {
    im.reset();
    const [b] = await t.s.db.root.select().from(binding);
    im.failNext(CHAT, "removed");
    await sysNotice("机器人被移出后的通知");
    await sysNotice("第二条");
    await cycle(2);
    const [after] = await t.s.db.root.select().from(binding).where(eq(binding.id, b!.id));
    expect(after).toMatchObject({ status: "invalid", invalidReason: "bot_removed" });
    const pending = await t.s.db.root
      .select()
      .from(outboundDelivery)
      .where(and(eq(outboundDelivery.bindingId, b!.id), eq(outboundDelivery.status, "pending")));
    expect(pending).toHaveLength(0);
    expect(im.sent).toHaveLength(0);
    const notice = (await timeline()).find((m) => (m.blocks as { notice?: string } | null)?.notice === "binding_invalidated");
    expect(notice?.body).toContain("机器人已被移出群");
    const inbox = await t.s.db.root.select().from(inboxItem).where(eq(inboxItem.refType, "binding"));
    expect(inbox.length).toBeGreaterThan(0);
    // inbound to the invalid binding is treated as an unbound chat
    await t.s.im.receive(groupMsg("staff-member", "还在吗"));
    await cycle(1);
    expect(lastReply()).toContain("还没有绑定项目");
    // re-bind via the Web
    const r = await t.req("POST", "/api/v1/bindings", { token: owner, body: { groupId, provider: "dingtalk", externalChatId: CHAT, mode: "passive" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: b!.id, status: "active", mode: "passive" });
  });

  test("passive mode: messages without @ are recorded but wake nobody", async () => {
    const turns = (await t.s.db.root.select().from(job).where(eq(job.type, "captain.turn"))).length;
    await t.s.im.receive(groupMsg("staff-member", "顺便说一下，对账脚本昨晚又跑挂了", { msgId: "dt-passive", atBot: false }));
    await cycle(2);
    const [m] = await t.s.db.root.select().from(message).where(eq(message.externalId, "dt-passive"));
    expect(m!.authorPrincipalId).toBe(memberPrincipal);
    expect(m!.mentions).toEqual([]);
    expect((await t.s.db.root.select().from(job).where(eq(job.type, "captain.turn"))).length).toBe(turns);
  });

  test("app revoked → every binding of the provider is invalidated; unbinding from the Web stops mirroring", async () => {
    await t.s.im.receive({ kind: "lifecycle", provider: "dingtalk", event: "app_revoked" });
    await cycle(1);
    const [b] = await t.s.db.root.select().from(binding);
    expect(b).toMatchObject({ status: "invalid", invalidReason: "app_revoked" });
    const re = await t.req("POST", "/api/v1/bindings", { token: owner, body: { groupId, provider: "dingtalk", externalChatId: CHAT } });
    expect(re.status).toBe(200);
    const del = await t.req("DELETE", `/api/v1/bindings/${b!.id}`, { token: member });
    expect(del.status).toBe(403);
    expect((await t.req("DELETE", `/api/v1/bindings/${b!.id}`, { token: owner })).status).toBe(200);
    im.reset();
    await sysNotice("解绑后不再同步");
    await cycle(1);
    expect(im.sent).toHaveLength(0);
  });

  test("admin bulk mapping: unknown users skipped; Members cannot", async () => {
    const r = await t.req("POST", "/api/v1/admin/external-identities", {
      token: owner,
      body: {
        provider: "dingtalk",
        items: [
          { externalUserId: "staff-member-2", userId: memberUser },
          { externalUserId: "staff-ghost", userId: "usr_nope" },
        ],
      },
    });
    expect(r.body).toMatchObject({ mapped: 1, skipped: [{ externalUserId: "staff-ghost" }] });
    const [x] = await t.s.db.root.select().from(externalIdentity).where(eq(externalIdentity.userId, memberUser));
    expect(x!.externalUserId).toBe("staff-member-2");
    const denied = await t.req("POST", "/api/v1/admin/external-identities", { token: member, body: { provider: "dingtalk", items: [] } });
    expect(denied.status).toBe(403);
  });
});
