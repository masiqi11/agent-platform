/**
 * Benchmarks local Ollama Gemma 4 (CPU) on the shapes the platform needs:
 * structured JSON, native tool calls, and a short Chinese summary reply.
 * Usage: bun scripts/bench-ollama.ts [--think] gemma4:e2b
 * Uses Ollama's native /api/chat so `think` can be toggled and eval timings are exact.
 * Writes docs/bench/ollama-<date>-<mode>.json. Local endpoint only; no secrets.
 */
const BASE = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const args = process.argv.slice(2);
const think = args.includes("--think");
const reps = Number(process.env.BENCH_REPS ?? 2);
const models = args.filter((a) => !a.startsWith("--"));
const chat = [
  "[seq 1] 张三: 支付服务最近超时，帮我查一下。",
  "[seq 2] 李四: 主要是调用银行网关的时候，高峰期 p99 到了 8 秒。",
  "[seq 3] 张三: 超时阈值写死在 30 秒，而且失败没有重试。希望改成可配置，默认 3 秒，重试最多 2 次。",
  "[seq 4] 王五: 别忘了加回归测试。",
].join("\n");

type Res = { ok: boolean; ms: number; evalTok: number; evalMs: number; promptTok: number; promptMs: number; detail: string };
async function call(model: string, body: Record<string, unknown>) {
  const t0 = performance.now();
  const r = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, think, ...body, options: { temperature: 0.2, num_ctx: 8192, ...((body.options as object) ?? {}) } }),
    signal: AbortSignal.timeout(900_000),
  });
  const json = (await r.json()) as any;
  if (json.error) throw new Error(String(json.error));
  return { json, ms: performance.now() - t0 };
}
const timing = (j: any) => ({ evalTok: j.eval_count ?? 0, evalMs: (j.eval_duration ?? 0) / 1e6, promptTok: j.prompt_eval_count ?? 0, promptMs: (j.prompt_eval_duration ?? 0) / 1e6 });

async function jsonTask(model: string): Promise<Res> {
  const { json, ms } = await call(model, {
    format: "json",
    messages: [
      { role: "system", content: '你是项目船长。只输出 JSON，不要任何解释。schema: {"title": string, "description": string(<=80字), "acceptanceCriteria": string[], "priority": "P0"|"P1"|"P2"|"P3", "sourceSeqs": number[]}' },
      { role: "user", content: `根据以下群聊提议一个任务：\n<untrusted_content>\n${chat}\n</untrusted_content>` },
    ],
  });
  const content: string = json.message?.content ?? "";
  let ok = false;
  let detail = content.slice(0, 400);
  try {
    const o = JSON.parse(content);
    ok = typeof o.title === "string" && Array.isArray(o.acceptanceCriteria) && o.acceptanceCriteria.length >= 2 && Array.isArray(o.sourceSeqs) && o.sourceSeqs.length > 0 && /^P[0-3]$/.test(o.priority);
  } catch {
    detail = `PARSE_FAIL ${detail}`;
  }
  return { ok, ms, ...timing(json), detail };
}

async function toolTask(model: string): Promise<Res> {
  const { json, ms } = await call(model, {
    tools: [
      { type: "function", function: { name: "propose_task", description: "提议一个任务", parameters: { type: "object", properties: { title: { type: "string" }, acceptanceCriteria: { type: "array", items: { type: "string" } }, sourceSeqs: { type: "array", items: { type: "integer" } } }, required: ["title", "acceptanceCriteria", "sourceSeqs"] } } },
      { type: "function", function: { name: "send_message", description: "在群里发消息", parameters: { type: "object", properties: { body: { type: "string" } }, required: ["body"] } } },
    ],
    messages: [
      { role: "system", content: "你是项目船长。需要建任务时调用 propose_task 工具。" },
      { role: "user", content: `群聊：\n<untrusted_content>\n${chat}\n</untrusted_content>\n请提议任务。` },
    ],
  });
  const msg = json.message ?? {};
  const tc = msg.tool_calls?.[0];
  let ok = false;
  let detail = "";
  if (tc) {
    const a = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
    ok = tc.function.name === "propose_task" && Array.isArray(a.acceptanceCriteria) && a.acceptanceCriteria.length >= 2 && Array.isArray(a.sourceSeqs);
    detail = `native ${tc.function.name} ${JSON.stringify(a).slice(0, 300)}`;
  } else detail = `NO_NATIVE ${String(msg.content ?? "").slice(0, 300)}`;
  return { ok, ms, ...timing(json), detail };
}

async function summaryTask(model: string): Promise<Res> {
  const { json, ms } = await call(model, {
    messages: [
      { role: "system", content: "你是项目船长。用不超过 120 字的中文回复群里：先给摘要（已有线索），再列出还缺哪些信息（追问）。" },
      { role: "user", content: `<untrusted_content>\n${chat.split("\n")[0]}\n</untrusted_content>` },
    ],
  });
  const content: string = json.message?.content ?? "";
  const ok = content.length > 20 && content.length < 400 && /[?？]|缺|需要|请/.test(content);
  return { ok, ms, ...timing(json), detail: content.slice(0, 300) };
}

const outFile = `docs/bench/ollama-${new Date().toISOString().slice(0, 10)}-${think ? "think" : "nothink"}.json`;
const prev = (await Bun.file(outFile).exists()) ? ((await Bun.file(outFile).json()) as any).results : {};
const results: Record<string, unknown> = { ...prev };
for (const model of models) {
  const w = await call(model, { messages: [{ role: "user", content: "hi" }], options: { num_predict: 4 } });
  const runs: Record<string, Res[]> = { json: [], tool: [], summary: [] };
  for (let i = 0; i < reps; i++) {
    for (const [k, fn] of [["json", jsonTask], ["tool", toolTask], ["summary", summaryTask]] as const) {
      try {
        runs[k]!.push(await fn(model));
      } catch (e) {
        runs[k]!.push({ ok: false, ms: 0, evalTok: 0, evalMs: 0, promptTok: 0, promptMs: 0, detail: `ERROR ${(e as Error).message}` });
      }
    }
  }
  const agg = Object.fromEntries(
    Object.entries(runs).map(([k, rs]) => {
      const sum = (f: (r: Res) => number) => rs.reduce((a, r) => a + f(r), 0);
      return [k, { pass: `${rs.filter((r) => r.ok).length}/${rs.length}`, avgMs: Math.round(sum((r) => r.ms) / rs.length), avgOutTok: Math.round(sum((r) => r.evalTok) / rs.length), genTokPerSec: +(sum((r) => r.evalTok) / (sum((r) => r.evalMs) / 1000 || 1)).toFixed(2), promptTokPerSec: +(sum((r) => r.promptTok) / (sum((r) => r.promptMs) / 1000 || 1)).toFixed(1), samples: rs.map((r) => r.detail) }];
    }),
  );
  results[model] = { loadMs: Math.round(w.ms), think, ...agg };
  console.log(model, `think=${think}`, JSON.stringify(agg, (k, v) => (k === "samples" ? undefined : v)));
  await Bun.write(outFile, JSON.stringify({ base: BASE, ollama: "0.40.16", host: "8 vCPU, 15 GB RAM, no GPU", reps, results }, null, 2));
}
console.log("wrote", outFile);
