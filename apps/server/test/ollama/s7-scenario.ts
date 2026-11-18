/**
 * S7 knowledge-base Q&A on a REAL model (manual; NOT CI): both demo repos indexed, then the
 * project captain (SAG2 judge + cited answer) and the global captain's cross-project routing.
 *
 *   TEST_DATABASE_URL=… LLM_BASE_URL=… LLM_MODEL=… LLM_API_KEY=… RESULT=s7-<name> bun test/ollama/s7-scenario.ts
 *
 * Each answer is checked for: citations present and resolvable to retrieved chunks, the expected
 * file cited, and "未检索到依据" when nothing relevant exists. Writes docs/results/$RESULT.json.
 */
import { writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NO_EVIDENCE_TEXT } from "@ap/shared";
import { sql } from "drizzle-orm";
import { BILLING_REPO, PAYMENTS_REPO } from "../../src/cli/demo-repos";
import { llmCall } from "../../src/db/schema";

const BASE = process.env.LLM_BASE_URL;
const MODEL = process.env.LLM_MODEL;
if (!BASE || !MODEL) throw new Error("LLM_BASE_URL and LLM_MODEL are required");
const dataDir = mkdtempSync(join(tmpdir(), "ap-s7real-"));
const { createTestApp } = await import("../helpers");
const t = await createTestApp("s7real", {
  DATA_DIR: dataDir,
  SANDBOX: "process",
  LLM_BASE_URL: BASE,
  LLM_MODEL: MODEL,
  ...(process.env.LLM_API_KEY ? { LLM_API_KEY: process.env.LLM_API_KEY } : {}),
  LLM_TIMEOUT_MS: "240000",
});
const rows: Array<Record<string, unknown>> = [];
try {
  const owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "R", email: "o@r7.test", name: "王负责人", password: "Correct-Horse-42" } })).body.token as string;
  const ctx = await t.s.identity.authenticate(new Headers({ authorization: `Bearer ${owner}` }), "trc_s7real");
  const P: Record<string, string> = {};
  for (const [key, name, repo, files] of [
    ["PAY", "支付服务", "payments", PAYMENTS_REPO],
    ["BILL", "计费服务", "billing", BILLING_REPO],
  ] as const) {
    const p = await t.req("POST", "/api/v1/projects", { token: owner, body: { key, name } });
    await t.s.repos.bind(ctx, p.body.id, { provider: "local", name: repo, files });
    P[key] = p.body.id;
  }
  const { registerHandlers } = await import("../../src/modules/registry");
  await registerHandlers(t.s);
  await t.s.consumers.init();
  await t.s.db.root.execute(sql`delete from job where cron is not null`);
  for (let i = 0; i < 30; i++) if (!(await t.s.consumers.drain()) && !(await t.s.jobs.drain())) break;

  const project = [
    { key: "PAY", q: "支付回调是怎么验签的？", expect: "src/callback.ts" },
    { key: "PAY", q: "退款金额有什么校验规则？", expect: "src/refund.ts" },
    { key: "BILL", q: "金额取整用的是什么规则，为什么？", expect: "src/rounding.ts" },
    { key: "PAY", q: "量子纠缠的哈密顿量怎么写", expect: null },
  ];
  for (const c of project) {
    const t0 = Date.now();
    const r = (await t.req("POST", `/api/v1/projects/${P[c.key]}/knowledge/ask`, { token: owner, body: { question: c.q } })).body;
    const cited = (r.citations ?? []).map((x: { path: string }) => x.path);
    const ok = c.expect ? cited.includes(c.expect) && r.answer !== NO_EVIDENCE_TEXT : r.answer === NO_EVIDENCE_TEXT && cited.length === 0;
    rows.push({ kind: "project", question: c.q, ok, by: r.model, confidence: r.confidence, cited, answer: String(r.answer).slice(0, 240), ms: Date.now() - t0 });
    console.log(
      `${ok ? "PASS" : "FAIL"}  [${c.key}] ${c.q} (${r.model}, ${r.confidence}, ${((Date.now() - t0) / 1000).toFixed(1)}s)\n      ${String(r.answer).slice(0, 160)}\n      引用：${cited.join("、") || "无"}`,
    );
  }
  const t0 = Date.now();
  const g = (await t.req("POST", "/api/v1/captain/ask", { token: owner, body: { question: "超时相关的计费逻辑在哪个仓库哪个文件" } })).body;
  const gc = (g.sources ?? []).flatMap((s: { key: string; citations?: Array<{ path: string }> }) => (s.citations ?? []).map((c) => `${s.key}:${c.path}`));
  const gok = gc.includes("BILL:src/payments-client.ts");
  rows.push({ kind: "global", question: "超时相关的计费逻辑在哪个仓库哪个文件", ok: gok, consulted: g.consulted, cited: gc, answer: String(g.answer).slice(0, 300), ms: Date.now() - t0 });
  console.log(`${gok ? "PASS" : "FAIL"}  [全局] 超时相关的计费逻辑在哪个仓库哪个文件 (询问 ${(g.consulted ?? []).join("、")})\n      ${String(g.answer).slice(0, 200)}\n      引用：${gc.join("、")}`);
} finally {
  const calls = await t.s.db.root.select().from(llmCall);
  const out = {
    at: new Date().toISOString(),
    model: MODEL,
    endpoint: new URL(BASE).host,
    rows,
    calls: { total: calls.length, ok: calls.filter((c) => c.status === "ok").length, repaired: calls.filter((c) => c.repaired).length, purposes: [...new Set(calls.map((c) => c.purpose))] },
    failures: calls.filter((c) => c.status !== "ok").map((c) => ({ purpose: c.purpose, error: (c.error ?? "").slice(0, 200) })),
  };
  writeFileSync(resolve(import.meta.dir, `../../../../docs/results/${process.env.RESULT ?? "s7-real-model"}.json`), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out.calls), out.failures.length ? JSON.stringify(out.failures) : "");
  await t.close();
  rmSync(dataDir, { recursive: true, force: true });
}
// #8: any failed question fails the run.
const failedRows = rows.filter((r) => !r.ok);
if (failedRows.length) console.log(`失败：${failedRows.map((r) => String(r.question)).join("、")}`);
process.exit(failedRows.length ? 1 : 0);
