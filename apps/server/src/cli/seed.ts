/**
 * S5 演示数据（`bun run seed`）：两个演示项目（支付服务 DPAY、计费服务 DBILL），各自一个本地仓库
 * （支付仓库带一个可复现的超时缺陷），以及 dev / reviewer / tester 三个 Agent。全部标注【演示数据】。
 *
 *   DATABASE_URL=... SEED_PASSWORD=... bun run seed [--owner owner@xinghe.test]
 *
 * Goes through the public API in-process (same validation and permissions as the web app), except
 * repo creation from file maps, which only the seed may do. Idempotent per project key.
 * Afterwards: in DPAY's group, @船长「支付服务最近超时，帮我查一下」→ confirm the proposal → the dev
 * agent fixes the bug on its own branch and opens an MR (scripted model; no model key needed).
 */
import { createApp } from "../app";
import { createConfig } from "../config";
import { loadEnv } from "../env";
import { createServices } from "../services";
import { BILLING_REPO, PAYMENTS_REPO } from "./demo-repos";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const PASSWORD = process.env.SEED_PASSWORD;
if (!PASSWORD) throw new Error("SEED_PASSWORD is required (the demo owner gets this password)");
const ownerEmail = arg("owner") ?? "owner@xinghe.test";

const config = createConfig(loadEnv({ ...process.env, LOG_LEVEL: "error" }));
const s = createServices(config, { owner: "seed" });
const app = createApp(s);

async function req<T = any>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const h: Record<string, string> = {};
  if (body !== undefined) h["content-type"] = "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  const r = await app.handle(new Request(`http://localhost${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }));
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : (undefined as T);
}

const PROJECTS = [
  { key: "DPAY", name: "支付服务", description: "【演示数据】支付网关调用、下单与回调。仓库里有一个可复现的超时缺陷。", repo: "payments", files: PAYMENTS_REPO },
  { key: "DBILL", name: "计费服务", description: "【演示数据】按订单生成账单；调用支付服务。", repo: "billing", files: BILLING_REPO },
];

async function main() {
  const { tenant } = await import("../db/schema");
  const [ten] = await s.db.root.select().from(tenant).limit(1);
  const ownerToken = ten
    ? await s.identity.signIn(ownerEmail, PASSWORD!)
    : (await req("POST", "/api/v1/setup", undefined, { tenantName: "星河科技（演示）", email: ownerEmail, name: "王晓明", password: PASSWORD })).token;
  const ownerCtx = await s.identity.authenticate(new Headers({ authorization: `Bearer ${ownerToken}` }), "trc_seed");
  const existing = await req<Array<{ id: string; key: string }>>("GET", "/api/v1/projects", ownerToken);
  for (const p of PROJECTS) {
    if (existing.some((e) => e.key === p.key)) {
      console.log(`${p.key} 已存在，跳过`);
      continue;
    }
    const proj = await req("POST", "/api/v1/projects", ownerToken, { key: p.key, name: p.name, description: p.description });
    for (const [name, role] of [
      ["开发 · 小码", "dev"],
      ["评审 · 审审", "reviewer"],
      ["测试 · 测测", "tester"],
    ] as const)
      await req("POST", `/api/v1/projects/${proj.id}/agents`, ownerToken, { name, role, instructions: "【演示数据】" });
    const bound = await s.repos.bind(ownerCtx, proj.id, { provider: "local", name: p.repo, files: p.files, testCommand: "bun test" });
    console.log(`${p.key}：项目 ${proj.id}，仓库 ${bound.repo.name}（${bound.check.ok ? "检查通过" : bound.check.detail}）`);
  }
  console.log(`完成。用 ${ownerEmail} 登录；在「支付服务」主群 @船长 说“支付服务最近超时，帮我查一下”。`);
}

await main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await s.realtime.stop().catch(() => undefined);
    await s.db.close();
  });
