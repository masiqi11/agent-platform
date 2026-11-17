/**
 * S4 exit scenario against a REAL model (default: local Ollama gemma4:e2b, think:false).
 * Not part of CI. Run: bun test/ollama/s4-scenario.ts  (needs TEST_DATABASE_URL and Ollama on :11434)
 * Any OpenAI-compatible endpoint: LLM_BASE_URL=https://…/v1 LLM_MODEL=… LLM_API_KEY=… RESULT=s4-<name>.
 * Writes docs/results/$RESULT.json (default s4-ollama) and prints a table. Each step records whether the model
 * itself produced the result or the deterministic fallback did.
 */
import { and, desc, eq } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { llmCall, message, proposal, question, sessionTurn, summary, task } from "../../src/db/schema";
import { registerHandlers } from "../../src/modules/registry";
import { createTestApp } from "../helpers";

const MODEL = process.env.LLM_MODEL ?? process.env.OLLAMA_MODEL ?? "gemma4:e2b";
const BASE = process.env.LLM_BASE_URL ?? "http://127.0.0.1:11434";
const RESULT = process.env.RESULT ?? "s4-ollama";
process.env.LLM_TIMEOUT_MS = "240000";
process.env.LLM_FIRST_BYTE_MS = "200000";
process.env.LLM_BACKOFF_MS = "1000";
const t = await createTestApp("s4ollama", {
  LLM_BASE_URL: BASE,
  LLM_MODEL: MODEL,
  ...(process.env.LLM_API_KEY ? { LLM_API_KEY: process.env.LLM_API_KEY } : {}),
  LLM_TIMEOUT_MS: "240000",
  LLM_FIRST_BYTE_MS: "200000",
});
const PW = "Correct-Horse-42";
const owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "Ollama", email: "o@o.test", name: "王负责人", password: PW } })).body.token as string;
const p = (await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "PAY", name: "支付服务", description: "支付网关、回调与对账" } })).body;
await t.req("POST", `/api/v1/projects/${p.id}/agents`, { token: owner, body: { name: "小码", role: "dev" } });
const cap = ((await t.req("GET", `/api/v1/projects/${p.id}/agents`, { token: owner })).body as Array<{ role: string; principalId: string }>).find((a) => a.role === "sub_captain")!;
await registerHandlers(t.s);
await t.s.consumers.init();
await t.s.llm.ensureDefaults((await t.req("GET", "/api/v1/me", { token: owner })).body.tenant.id);

const cycle = async () => {
  await t.s.consumers.drain();
  await t.s.jobs.drain(50, 1);
  await t.s.consumers.drain();
};
const say = async (body: string) => (await t.req("POST", `/api/v1/groups/${p.mainGroupId}/messages`, { token: owner, body: { body } })).body.message as { id: string; seq: number };
const after = async (seq: number) => (await t.s.db.root.select().from(message).where(eq(message.groupId, p.mainGroupId)).orderBy(message.seq)).filter((m) => m.seq > seq);

interface Step {
  step: string;
  pass: boolean;
  by: "model" | "fallback" | "n/a";
  ms: number;
  detail: string;
}
const steps: Step[] = [];
const run = async (name: string, fn: () => Promise<Omit<Step, "step" | "ms">>) => {
  const t0 = Date.now();
  try {
    const r = await fn();
    steps.push({ step: name, ms: Date.now() - t0, ...r });
  } catch (e) {
    steps.push({ step: name, ms: Date.now() - t0, pass: false, by: "n/a", detail: `异常：${(e as Error).message}` });
  }
  const s = steps.at(-1)!;
  process.stdout.write(`${s.pass ? "PASS" : "FAIL"}  ${name}  (${(s.ms / 1000).toFixed(1)}s, ${s.by})  ${s.detail}\n`);
};

let proposalId = "";
await run("1 @船长 支付服务最近超时，帮我查一下 → 回复 + 追问", async () => {
  const m = await say(`@[${cap.principalId}] 支付服务最近超时，帮我查一下`);
  await cycle();
  const r = await after(m.seq);
  const reply = r.find((x) => x.authorPrincipalId === cap.principalId && x.kind === "text");
  const q = r.find((x) => x.kind === "question");
  const prp = r.find((x) => x.kind === "proposal_card");
  if (prp) proposalId = (prp.blocks as { proposalId: string }).proposalId;
  const fb = prp ? (await t.s.db.root.select().from(proposal).where(eq(proposal.id, proposalId)))[0]?.payload.fallback === true : false;
  return {
    pass: Boolean(reply && (q || prp)),
    by: q ? ((q.blocks as { fallback?: boolean } | null)?.fallback ? "fallback" : "model") : prp ? (fb ? "fallback" : "model") : "n/a",
    detail: `回复=${reply ? JSON.stringify(reply.body.slice(0, 80)) : "无"}；追问卡=${q ? JSON.stringify(q.body.slice(0, 60)) : "无"}${prp ? "；（直接给出提议卡）" : ""}`,
  };
});

await run("2 补充细节 → 提议卡", async () => {
  const open = await t.s.db.root
    .select()
    .from(question)
    .where(and(eq(question.groupId, p.mainGroupId), eq(question.status, "open")));
  const m = await say(
    open.length
      ? "从昨天下午 3 点开始，/pay/callback 接口 p99 超过 5 秒，错误率 8%，影响微信支付回调"
      : `@[${cap.principalId}] 补充：从昨天下午 3 点开始，/pay/callback 接口 p99 超过 5 秒，错误率 8%，影响微信支付回调`,
  );
  await cycle();
  const r = await after(m.seq);
  const prp = r.find((x) => x.kind === "proposal_card");
  if (prp) proposalId = (prp.blocks as { proposalId: string }).proposalId;
  if (!proposalId) return { pass: false, by: "n/a", detail: "无提议卡" };
  const [row] = await t.s.db.root.select().from(proposal).where(eq(proposal.id, proposalId));
  return {
    pass: true,
    by: row!.payload.fallback ? "fallback" : "model",
    detail: `标题=${JSON.stringify(row!.payload.title)}；验收标准 ${(row!.payload.acceptanceCriteria as string[] | undefined)?.length ?? 0} 条；优先级 ${String(row!.payload.priority)}`,
  };
});

await run("3 确认提议 → 建任务并按策略分配", async () => {
  if (!proposalId) return { pass: false, by: "n/a", detail: "没有提议可确认" };
  const acc = await t.req("POST", `/api/v1/proposals/${proposalId}/accept`, { token: owner });
  if (acc.status !== 200) return { pass: false, by: "n/a", detail: `accept ${acc.status}` };
  const [tk] = await t.s.db.root.select().from(task).where(eq(task.id, acc.body.resultTaskIds[0]));
  const assign = (await t.s.db.root.select().from(proposal).where(eq(proposal.kind, "assign"))).length;
  return { pass: Boolean(tk!.assigneeAgentId) || assign > 0, by: "n/a", detail: `任务 ${tk!.priority} 状态=${tk!.status} 负责=${tk!.assigneeAgentId ? "已自动分配" : assign ? "已发分配提议" : "无"}` };
});

await run("4 滚动摘要（/summary）", async () => {
  await say("决定：回调统一走异步队列，3 秒内先返回 200");
  await say("注意不能改动对账表结构");
  await say("风险：银行侧接口最近也不稳定");
  await say("/summary");
  await cycle();
  const [s] = await t.s.db.root.select().from(summary).where(eq(summary.groupId, p.mainGroupId)).orderBy(desc(summary.version)).limit(1);
  if (!s) return { pass: false, by: "n/a", detail: "无摘要" };
  const c = s.content as Record<string, unknown[]>;
  const n = Object.values(c).reduce((a, b) => a + b.length, 0);
  return { pass: n > 0, by: s.model.includes("heuristic") ? "fallback" : "model", detail: `v${s.version} 条目 ${n}；决策 ${c.decisions?.length ?? 0}；模型=${s.model}` };
});

await run("5 问全局船长（相关）", async () => {
  const r = (await t.req("POST", "/api/v1/captain/ask", { token: owner, body: { question: "支付回调超时现在是怎么处理的？" } })).body;
  return {
    pass: r.sources?.length > 0 && r.answer !== "未检索到依据",
    by: r.model === "fallback" ? "fallback" : "model",
    detail: `${JSON.stringify(String(r.answer).slice(0, 80))} 来源=${(r.sources ?? []).map((x: { key: string }) => x.key).join(",")}`,
  };
});
await run("6 问全局船长（无依据）→ 未检索到依据", async () => {
  const r = (await t.req("POST", "/api/v1/captain/ask", { token: owner, body: { question: "量子计算机的散热方案是什么" } })).body;
  return { pass: r.answer === "未检索到依据", by: "n/a", detail: String(r.answer) };
});

const calls = await t.s.db.root.select().from(llmCall);
const ok = calls.filter((c) => c.status === "ok" && c.model === MODEL);
const stat = {
  model: MODEL,
  endpoint: new URL(BASE).host,
  calls: calls.length,
  ok: ok.length,
  errors: calls.filter((c) => c.status !== "ok").length,
  avgLatencyMs: Math.round(ok.reduce((a, c) => a + c.latencyMs, 0) / Math.max(1, ok.length)),
  tokensPerSec: Number((ok.reduce((a, c) => a + c.tokensOut, 0) / Math.max(1, ok.reduce((a, c) => a + c.latencyMs, 0) / 1000)).toFixed(1)),
  toolModes: ok.reduce<Record<string, number>>((a, c) => ((a[c.toolMode ?? "none"] = (a[c.toolMode ?? "none"] ?? 0) + 1), a), {}),
  repaired: ok.filter((c) => c.repaired).length,
  // Tool calls the platform rejected (validation / permission), so a fallback had to step in.
  rejectedTools: (await t.s.db.root.select().from(sessionTurn).where(eq(sessionTurn.role, "tool")))
    .filter((x) => /"ok":false|error/.test(x.content))
    .map((x) => ({ call: JSON.stringify(x.toolCalls).slice(0, 400), result: x.content.slice(0, 400) })),
  failures: calls.filter((c) => c.status !== "ok").map((c) => ({ purpose: c.purpose, status: c.status, error: (c.error ?? "").slice(0, 300) })),
  byPurpose: Object.fromEntries([...new Set(ok.map((c) => c.purpose))].map((pu) => [pu, ok.filter((c) => c.purpose === pu).map((c) => c.latencyMs)])),
};
const out = { ranAt: new Date().toISOString(), host: process.env.RESULT_HOST ?? "本机 CPU（8 核，无 GPU）", steps, stat };
writeFileSync(join(import.meta.dir, `../../../../docs/results/${RESULT}.json`), `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(JSON.stringify(stat, null, 2) + "\n");
await t.close();
process.exit(0);
