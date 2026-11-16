import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { message } from "../src/db/schema";
import { createTestApp, type TestApp } from "./helpers";

let t: TestApp;
const PW = "Correct-Horse-42";
let owner = "";
let dev = "";
let viewer = "";
let projectId = "";
let groupId = "";
let devPrincipal = "";

async function join(email: string, name: string, tenantRole = "member") {
  const inv = await t.req("POST", "/api/v1/invitations", { token: owner, body: { tenantRole } });
  const acc = await t.req("POST", `/api/v1/invitations/${inv.body.token}/accept`, { body: { email, name, password: PW } });
  const me = (await t.req("GET", "/api/v1/me", { token: acc.body.token })).body;
  return { token: acc.body.token as string, principalId: me.principalId as string };
}

beforeAll(async () => {
  t = await createTestApp("s2chat");
  owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "S2", email: "o@s2.test", name: "王负责人", password: PW } })).body.token;
  const d = await join("dev@s2.test", "李 开发");
  dev = d.token;
  devPrincipal = d.principalId;
  const v = await join("v@s2.test", "赵只读");
  viewer = v.token;
  const p = await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "PAY", name: "支付服务", description: "支付网关" } });
  expect(p.status).toBe(200);
  projectId = p.body.id;
  groupId = p.body.mainGroupId;
  await t.req("PUT", `/api/v1/projects/${projectId}/members/${devPrincipal}`, { token: owner, body: { role: "member" } });
  await t.req("PUT", `/api/v1/projects/${projectId}/members/${v.principalId}`, { token: owner, body: { role: "viewer" } });
});
afterAll(async () => t?.close());

describe("S2 projects", () => {
  test("project creation: key rules, main group, maintainer, sub-captain in one tx", async () => {
    const bad = await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "pay-1", name: "x" } });
    expect(bad.status).toBe(400);
    const dup = await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "PAY", name: "dup" } });
    expect(dup.status).toBe(409);
    const proj = await t.req("GET", `/api/v1/projects/${projectId}`, { token: owner });
    expect(proj.body.mainGroupId).toBe(groupId);
    expect(proj.body.myRole).toBe("maintainer");
    const agents = await t.req("GET", `/api/v1/projects/${projectId}/agents`, { token: owner });
    expect(agents.body.map((a: { role: string }) => a.role)).toContain("sub_captain");
    const members = await t.req("GET", `/api/v1/projects/${projectId}/members`, { token: dev });
    expect(members.body.length).toBe(4);
  });

  test("member cannot create projects (Tenant Owner only)", async () => {
    const r = await t.req("POST", "/api/v1/projects", { token: dev, body: { key: "DEVX", name: "x" } });
    expect(r.status).toBe(403);
  });

  test("project list shows counts and agents", async () => {
    const r = await t.req("GET", "/api/v1/projects", { token: dev });
    expect(r.body[0].key).toBe("PAY");
    expect(r.body[0].agents.length).toBe(1);
  });

  test("main group cannot be archived; topic group can", async () => {
    expect((await t.req("POST", `/api/v1/groups/${groupId}/archive`, { token: owner })).status).toBe(409);
    const g = await t.req("POST", `/api/v1/projects/${projectId}/groups`, { token: owner, body: { name: "超时排查" } });
    expect((await t.req("POST", `/api/v1/groups/${g.body.id}/archive`, { token: owner })).status).toBe(200);
  });

  test("agents: create, rename keeps history label, disable needs reason, captain can't be disabled", async () => {
    const a = await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name: "开发小P", role: "dev" } });
    expect(a.status).toBe(200);
    expect(a.body.toolAllowlist).toContain("git_push");
    expect((await t.req("POST", `/api/v1/agents/${a.body.id}/status`, { token: owner, body: { status: "disabled" } })).status).toBe(400);
    expect((await t.req("POST", `/api/v1/agents/${a.body.id}/status`, { token: dev, body: { status: "paused" } })).status).toBe(403);
    const list = await t.req("GET", `/api/v1/projects/${projectId}/agents`, { token: owner });
    const captain = list.body.find((x: { role: string }) => x.role === "sub_captain");
    expect((await t.req("POST", `/api/v1/agents/${captain.id}/status`, { token: owner, body: { status: "disabled", reason: "x" } })).status).toBe(409);
  });
});

describe("S2 messages", () => {
  test("INV-21: concurrent sends get strictly increasing, gapless seq", async () => {
    const N = 30;
    const results = await Promise.all(Array.from({ length: N }, (_, i) => t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: i % 2 ? owner : dev, body: { body: `并发消息 ${i}` } })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const seqs = results.map((r) => r.body.message.seq).sort((a: number, b: number) => a - b);
    expect(new Set(seqs).size).toBe(N);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
    const tl = await t.req("GET", `/api/v1/groups/${groupId}/messages?limit=200`, { token: dev });
    const all = tl.body.items.map((m: { seq: number }) => m.seq);
    expect(all).toEqual([...all].sort((a: number, b: number) => a - b));
    expect(all[0]).toBe(1);
    expect(all[all.length - 1]).toBe(all.length);
  });

  test("INV-01: every message records its own author principal", async () => {
    const tl = await t.req("GET", `/api/v1/groups/${groupId}/messages?limit=200`, { token: dev });
    const authors = new Set(tl.body.items.map((m: { author: { principalId: string } }) => m.author.principalId));
    expect(authors.size).toBe(2);
    const nullAuthors = await t.s.db.root
      .select({ n: sql<number>`count(*)::int` })
      .from(message)
      .where(sql`author_principal_id is null`);
    expect(nullAuthors[0]!.n).toBe(0);
  });

  test("mentions parsed server-side incl. quoted names with spaces; @所有人 is maintainer-only", async () => {
    const r = await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: owner, body: { body: '@"李 开发" 看一下 @"PAY 船长"' } });
    expect(r.body.message.mentions).toContain(devPrincipal);
    expect(r.body.message.mentions.length).toBe(2);
    expect((await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: dev, body: { body: "@所有人 注意" } })).status).toBe(403);
    expect((await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: owner, body: { body: "@所有人 注意" } })).status).toBe(200);
  });

  test("viewer cannot post; empty / oversized messages rejected", async () => {
    expect((await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: viewer, body: { body: "hi" } })).status).toBe(403);
    expect((await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: dev, body: { body: "   " } })).status).toBe(400);
    expect((await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: dev, body: { body: "x".repeat(20_001) } })).status).toBe(400);
  });

  test("idempotency key returns the first result", async () => {
    const h = { "idempotency-key": "send-once-1" };
    const a = await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: dev, body: { body: "只发一次" }, headers: h });
    const b = await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: dev, body: { body: "只发一次" }, headers: h });
    expect(b.body.message.id).toBe(a.body.message.id);
  });

  test("edit keeps versions; other users can't edit; delete leaves placeholder and seq", async () => {
    const m = (await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: dev, body: { body: "初稿：超时 30 秒" } })).body.message;
    expect((await t.req("PATCH", `/api/v1/messages/${m.id}`, { token: viewer, body: { body: "hack" } })).status).toBe(403);
    expect((await t.req("PATCH", `/api/v1/messages/${m.id}`, { token: dev, body: { body: "修订：超时 3 秒" } })).status).toBe(200);
    const v = await t.req("GET", `/api/v1/messages/${m.id}/versions`, { token: dev });
    expect(v.body[0].body).toBe("初稿：超时 30 秒");
    const reply = (await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: owner, body: { body: "收到", replyToId: m.id } })).body.message;
    expect(reply.replyTo.excerpt).toBe("修订：超时 3 秒");
    expect((await t.req("DELETE", `/api/v1/messages/${m.id}`, { token: dev, body: { reason: "写错了" } })).status).toBe(200);
    const around = await t.req("GET", `/api/v1/groups/${groupId}/messages?aroundSeq=${m.seq}&limit=5`, { token: dev });
    const placeholder = around.body.items.find((x: { id: string }) => x.id === m.id);
    expect(placeholder.deleted).toBe(true);
    expect(placeholder.body).toBe("原消息已删除");
    expect(placeholder.seq).toBe(m.seq);
    const replyNow = around.body.items.find((x: { id: string }) => x.id === reply.id);
    expect(replyNow.replyTo.excerpt).toBe("原消息已删除");
  });

  test("search finds CJK text, respects deletion, and jumps via aroundSeq", async () => {
    const m = (await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: dev, body: { body: "银行网关高峰期 p99 到了 8 秒" } })).body.message;
    const r = await t.req("GET", `/api/v1/projects/${projectId}/search?q=${encodeURIComponent("网关 超时")}`, { token: dev });
    expect(r.status).toBe(200);
    const hit = r.body.find((x: { messageId: string }) => x.messageId === m.id);
    expect(hit).toBeTruthy();
    expect(hit.snippet).toContain("网关");
    const jump = await t.req("GET", `/api/v1/groups/${groupId}/messages?aroundSeq=${hit.seq}&limit=10`, { token: dev });
    expect(jump.body.items.some((x: { id: string }) => x.id === m.id)).toBe(true);
    const gone = await t.req("GET", `/api/v1/projects/${projectId}/search?q=${encodeURIComponent("初稿")}`, { token: dev });
    expect(gone.body.length).toBe(0);
  });

  test("unread counts and mention flag; markRead", async () => {
    const before = await t.req("GET", `/api/v1/projects/${projectId}/groups`, { token: viewer });
    const g = before.body.find((x: { id: string }) => x.id === groupId);
    expect(g.unread).toBeGreaterThan(0);
    await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: owner, body: { body: '@"李 开发" 请确认' } });
    const devView = (await t.req("GET", `/api/v1/projects/${projectId}/groups`, { token: dev })).body.find((x: { id: string }) => x.id === groupId);
    expect(devView.mentioned).toBe(true);
    const latest = (await t.req("GET", `/api/v1/projects/${projectId}/groups`, { token: viewer })).body.find((x: { id: string }) => x.id === groupId).latestSeq;
    await t.req("POST", `/api/v1/groups/${groupId}/read`, { token: viewer, body: { seq: latest } });
    const after = (await t.req("GET", `/api/v1/projects/${projectId}/groups`, { token: viewer })).body.find((x: { id: string }) => x.id === groupId);
    expect(after.unread).toBe(0);
  });

  test("threads and attachments (signed short-lived link)", async () => {
    const root = (await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: dev, body: { body: "超时根因讨论" } })).body.message;
    const th = await t.req("POST", `/api/v1/groups/${groupId}/threads`, { token: dev, body: { title: "超时根因", rootMessageId: root.id } });
    await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: owner, body: { body: "线程内回复", threadId: th.body.id } });
    const list = await t.req("GET", `/api/v1/groups/${groupId}/threads`, { token: dev });
    expect(list.body[0].messageCount).toBe(2);
    const fd = new FormData();
    fd.append("file", new File(["timeout=30s\n"], "config.txt", { type: "text/plain" }));
    const up = await t.app.handle(new Request(`http://localhost/api/v1/groups/${groupId}/attachments`, { method: "POST", headers: { authorization: `Bearer ${dev}` }, body: fd }));
    if (up.status !== 200) console.log(await up.clone().text());
    expect(up.status).toBe(200);
    const att = (await up.json()) as { id: string; sha256: string };
    expect(att.sha256).toMatch(/^[0-9a-f]{64}$/);
    const m = await t.req("POST", `/api/v1/groups/${groupId}/messages`, { token: dev, body: { body: "配置见附件", attachmentIds: [att.id] } });
    expect(m.body.message.attachments[0].scanStatus).toBe("unscanned");
    const link = await t.req("GET", `/api/v1/attachments/${att.id}/link`, { token: viewer });
    const raw = await t.app.handle(new Request(`http://localhost${link.body.url}`));
    expect(await raw.text()).toBe("timeout=30s\n");
    const tampered = await t.app.handle(new Request(`http://localhost${link.body.url.replace(/sig=./, "sig=0")}`));
    expect(tampered.status).toBe(404);
    const exe = new FormData();
    exe.append("file", new File(["MZ"], "x.exe", { type: "application/x-msdownload" }));
    expect((await t.app.handle(new Request(`http://localhost/api/v1/groups/${groupId}/attachments`, { method: "POST", headers: { authorization: `Bearer ${dev}` }, body: exe }))).status).toBe(400);
  });

  test("archived project is read-only", async () => {
    const p = await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "OLD", name: "旧项目" } });
    expect((await t.req("POST", `/api/v1/projects/${p.body.id}/archive`, { token: owner, body: { reason: "迁移完成" } })).status).toBe(200);
    expect((await t.req("POST", `/api/v1/groups/${p.body.mainGroupId}/messages`, { token: owner, body: { body: "还能发吗" } })).status).toBe(409);
    expect((await t.req("GET", `/api/v1/groups/${p.body.mainGroupId}/messages`, { token: owner })).status).toBe(200);
  });

  test("timeline first screen (50) is fast", async () => {
    const t0 = performance.now();
    const r = await t.req("GET", `/api/v1/groups/${groupId}/messages?limit=50`, { token: dev });
    expect(r.status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
