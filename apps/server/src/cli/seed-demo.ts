/**
 * 演示数据种子（仅用于界面体验与截图，不是业务数据）。
 *
 *   DATABASE_URL=... SEED_PASSWORD=... bun src/cli/seed-demo.ts [--owner owner@xinghe.test]
 *
 * Drives the public HTTP API in-process (same validation/permissions as the web app); only the
 * decision card — whose API arrives with the captain in S4 — is written through services. Every
 * artifact is labelled 「演示」. Idempotent per project key DEMO: re-running is a no-op.
 */
import { and, eq } from "drizzle-orm";
import { createApp } from "../app";
import { signupGrant } from "../auth";
import { createConfig } from "../config";
import type { Ctx } from "../core/context";
import { newId } from "../core/ids";
import { agent, appUser, decision, tenant } from "../db/schema";
import { loadEnv } from "../env";
import { createServices } from "../services";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const PASSWORD = process.env.SEED_PASSWORD;
if (!PASSWORD) throw new Error("SEED_PASSWORD is required (demo users get this password)");
const ownerEmail = arg("owner") ?? "owner@xinghe.test";

const config = createConfig(loadEnv({ ...process.env, LOG_LEVEL: "error" }));
const s = createServices(config, { owner: "seed-demo" });
const app = createApp(s);

async function req<T = any>(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  const r = await app.handle(new Request(`http://localhost${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }));
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : (undefined as T);
}

async function main() {
  const [ten] = await s.db.root.select().from(tenant).limit(1);
  let ownerToken: string;
  if (!ten) {
    ownerToken = (await req("POST", "/api/v1/setup", undefined, { tenantName: "星河支付", email: ownerEmail, name: "王晓明", password: PASSWORD })).token;
  } else ownerToken = await s.identity.signIn(ownerEmail, PASSWORD!);
  const me = await req("GET", "/api/v1/me", ownerToken);
  const tenantId: string = me.tenant.id;

  const projects = await req<Array<{ id: string; key: string }>>("GET", "/api/v1/projects", ownerToken);
  if (projects.some((p) => p.key === "DEMO")) {
    console.log("demo project already present; nothing to do");
    return;
  }

  // People (members of the same tenant).
  const people = [
    { email: "zhangyue@xinghe.test", name: "张越" },
    { email: "wanglan@xinghe.test", name: "王岚" },
    { email: "linzhou@xinghe.test", name: "林舟" },
  ];
  const tokens: Record<string, string> = { 王晓明: ownerToken };
  for (const p of people) {
    const [u] = await s.db.root.select().from(appUser).where(eq(appUser.email, p.email));
    if (!u) await signupGrant.run({ tenantId, tenantRole: "member" }, () => s.auth.api.signUpEmail({ body: { email: p.email, name: p.name, password: PASSWORD! } }));
    tokens[p.name] = await s.identity.signIn(p.email, PASSWORD!);
  }

  const proj = await req("POST", "/api/v1/projects", ownerToken, { key: "DEMO", name: "支付服务（演示）", description: "【演示数据】仅用于界面体验与截图" });
  const projectId: string = proj.id;
  const g: string = proj.mainGroupId;
  for (const p of people) {
    const pid = (await req("GET", "/api/v1/me", tokens[p.name])).principalId;
    await req("PUT", `/api/v1/projects/${projectId}/members/${pid}`, ownerToken, { role: p.name === "林舟" ? "maintainer" : "member" });
  }
  const dev = await req("POST", `/api/v1/projects/${projectId}/agents`, ownerToken, { name: "小码", role: "dev" });
  await req("POST", `/api/v1/projects/${projectId}/agents`, ownerToken, { name: "审审", role: "reviewer" });
  await req("POST", `/api/v1/projects/${projectId}/agents`, ownerToken, { name: "测测", role: "tester" });

  const say = async (who: string, body: string, extra: Record<string, unknown> = {}) =>
    (await req("POST", `/api/v1/groups/${g}/messages`, tokens[who], { body, ...extra }, { "idempotency-key": newId("idem") })).message as { id: string; seq: number };

  await say("王晓明", "【演示数据】以下对话为演示样例，用于展示界面效果。");
  const m1 = await say("张越", "退款回调最近也偶发 502，看日志是 billing 网关在 18:00 左右限流。");
  await say("王岚", "先记下来，等超时修复上线后再排查；限流阈值需要和 BILL 组确认。");
  const m3 = await say("林舟", "决定：1.5 版本统一把外部调用超时放进配置中心，不再写死在代码里。");
  await say("张越", "我先拉一下 18:00–18:30 的网关日志，晚点贴到线程里。");
  await say("王晓明", "好的。退款回调 502 这个我建一个任务跟进，@张越 你来当 owner？");
  await say("张越", "可以，验收标准我补两条：**伪造签名返回 401**，重试最多 5 次。");

  // A thread with replies.
  const th = await req("POST", `/api/v1/groups/${g}/threads`, tokens["张越"], { title: "退款回调 502 排查", rootMessageId: m1.id });
  await say("张越", "18:02–18:07 有 37 次 502，全部来自 /refund/notify。", { threadId: th.id });
  await say("王岚", "和 BILL 组确认了：限流阈值 200 QPS，峰值时我们到了 240。", { threadId: th.id });

  // A task card (task created from a message in this group).
  const t1 = await req(
    "POST",
    "/api/v1/tasks",
    tokens["王晓明"],
    {
      projectId,
      title: "排查退款回调偶发 502",
      priority: "P1",
      type: "bug",
      groupId: g,
      sourceMessageIds: [m1.id],
      acceptanceCriteria: ["伪造签名返回 401", "重试最多 5 次，指数退避"],
      assigneeAgentId: dev.id,
    },
    { "idempotency-key": newId("idem") },
  );
  const zhang = (await req("GET", "/api/v1/me", tokens["张越"])).principalId;
  await req("PUT", `/api/v1/tasks/${t1.id}/owners/${zhang}`, ownerToken, { role: "owner" });
  await req("POST", `/api/v1/tasks/${t1.id}/transition`, ownerToken, { to: "ready" });
  await req(
    "POST",
    "/api/v1/tasks",
    ownerToken,
    { projectId, title: "外部调用超时迁移到配置中心", priority: "P2", acceptanceCriteria: ["所有外部调用读取配置中心超时"], sourceMessageIds: [m3.id] },
    { "idempotency-key": newId("idem") },
  );

  // A decision card (decisions API lands with the captain in S4; written via services here).
  const sys: Ctx = await s.identity.systemCtx(tenantId);
  const did = newId("dec");
  const linzhou = (await req("GET", "/api/v1/me", tokens["林舟"])).principalId;
  await s.db.root.insert(decision).values({
    id: did,
    tenantId,
    projectId,
    groupId: g,
    text: "1.5 版本统一把外部调用超时放进配置中心，不再写死在代码里。",
    status: "confirmed",
    sourceMessageIds: [m3.id],
    confirmedBy: linzhou,
    confirmedAt: new Date(),
  });
  await s.chat.send(sys, {
    groupId: g,
    kind: "decision_card",
    source: "system",
    body: "外部调用超时统一走配置中心\n\n1.5 版本统一把外部调用超时放进配置中心，不再写死在代码里。（林舟 已确认 · 演示数据）",
    blocks: { decisionId: did, title: "外部调用超时统一走配置中心", status: "confirmed", sourceSeq: m3.seq },
  });

  // A pending proposal from the project captain (captain proposes; humans decide — INV-07).
  const [cap] = await s.db.root
    .select()
    .from(agent)
    .where(and(eq(agent.projectId, projectId), eq(agent.role, "sub_captain")));
  if (!cap) throw new Error("project captain (sub_captain) not found");
  {
    const capCtx: Ctx = {
      tenantId,
      traceId: newId("trc"),
      actor: { principalId: cap.principalId, kind: "agent", displayName: cap.name, agentId: cap.id, agentRole: "sub_captain", projectScope: [projectId] },
    };
    await s.proposals.create(capCtx, {
      projectId,
      groupId: g,
      kind: "create_task",
      payload: { title: "网关限流阈值与 BILL 组对齐", description: "峰值 240 QPS 超过 BILL 限流 200 QPS（演示）", acceptanceCriteria: ["与 BILL 组确认新阈值", "压测峰值无 502"] },
      sourceMessageIds: [m1.id],
    });
  }
  console.log(`demo seeded: project ${projectId} group ${g}`);
}

try {
  await main();
} finally {
  await s.realtime.stop().catch(() => undefined);
  await s.db.close();
}
