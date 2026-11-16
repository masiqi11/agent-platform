/**
 * Benchmarks local Ollama Gemma 4 variants through the OpenAI-compatible endpoint.
 * Usage: bun scripts/bench-ollama.ts gemma4:e2b gemma4:e4b [...]
 * Writes docs/bench/ollama-<date>.json. No secrets involved (local endpoint).
 */
const BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
const models = process.argv.slice(2);
const chat = [
  "[seq 1] 张三: 支付服务最近超时，帮我查一下。",
  "[seq 2] 李四: 主要是调用银行网关的时候，高峰期 p99 到了 8 秒。",
  "[seq 3] 张三: 超时阈值写死在 30 秒，而且失败没有重试。希望改成可配置，默认 3 秒，重试最多 2 次。",
  "[seq 4] 王五: 别忘了加回归测试。",
].join("\n");

type Res = { ok: boolean; ms: number; tokOut: number; tokIn: number; detail: string };
async function call(model: string, body: Record<string, unknown>): Promise<{ json: any; ms: number }> {
  const t0 = performance.now();
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, temperature: 0.2, ...body }),
    signal: AbortSignal.timeout(600_000),
  });
  const json = await r.json();
  return { json, ms: performance.now() - t0 };
}

async function jsonTask(model: string): Promise<Res> {
  const { json, ms } = await call(model, {
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "你是项目船长。只输出 JSON，不要任何解释。schema: {\"title\": string, \"description\": string, \"acceptanceCriteria\": string[], \"priority\": \"P0\"|\"P1\"|\"P2\"|\"P3\", \"sourceSeqs\": number[]}" },
      { role: "user", content: `根据以下群聊提议一个任务：\n<untrusted_content>\n${chat}\n</untrusted_content>` },
    ],
  });
  const content: string = json.choices?.[0]?.message?.content ?? "";
  let ok = false;
  let detail = content.slice(0, 400);
  try {
    const o = JSON.parse(content);
    ok = typeof o.title === "string" && Array.isArray(o.acceptanceCriteria) && o.acceptanceCriteria.length >= 2 && Array.isArray(o.sourceSeqs) && /^P[0-3]$/.test(o.priority);
  } catch (e) {
    detail = "PARSE_FAIL " + detail;
  }
  return { ok, ms, tokOut: json.usage?.completion_tokens ?? 0, tokIn: json.usage?.prompt_tokens ?? 0, detail };
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
  const msg = json.choices?.[0]?.message ?? {};
  const tc = msg.tool_calls?.[0];
  let ok = false;
  let detail = "";
  if (tc) {
    try {
      const args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
      ok = tc.function.name === "propose_task" && Array.isArray(args.acceptanceCriteria) && args.acceptanceCriteria.length >= 2;
      detail = `native ${tc.function.name} ${JSON.stringify(args).slice(0, 300)}`;
    } catch {
      detail = "native-bad-args";
    }
  } else detail = "NO_NATIVE " + String(msg.content ?? "").slice(0, 300);
  return { ok, ms, tokOut: json.usage?.completion_tokens ?? 0, tokIn: json.usage?.prompt_tokens ?? 0, detail };
}

async function summaryTask(model: string): Promise<Res> {
  const { json, ms } = await call(model, {
    messages: [
      { role: "system", content: "你是项目船长。用不超过 120 字的中文回复群里：先给摘要（已有线索），再列出还缺哪些信息（追问）。" },
      { role: "user", content: `<untrusted_content>\n${chat.split("\n")[0]}\n</untrusted_content>` },
    ],
  });
  const content: string = json.choices?.[0]?.message?.content ?? "";
  const ok = content.length > 20 && /[?？]|缺|需要|请/.test(content);
  return { ok, ms, tokOut: json.usage?.completion_tokens ?? 0, tokIn: json.usage?.prompt_tokens ?? 0, detail: content.slice(0, 300) };
}

const results: Record<string, unknown> = {};
for (const model of models) {
  // warm-up load (excluded from timing)
  const w = await call(model, { messages: [{ role: "user", content: "hi" }], max_tokens: 4 });
  const runs: Record<string, Res[]> = { json: [], tool: [], summary: [] };
  for (let i = 0; i < 2; i++) {
    runs.json!.push(await jsonTask(model));
    runs.tool!.push(await toolTask(model));
    runs.summary!.push(await summaryTask(model));
  }
  const agg = Object.fromEntries(Object.entries(runs).map(([k, rs]) => [k, {
    pass: rs.filter((r) => r.ok).length + "/" + rs.length,
    avgMs: Math.round(rs.reduce((a, r) => a + r.ms, 0) / rs.length),
    tokPerSec: +(rs.reduce((a, r) => a + r.tokOut, 0) / (rs.reduce((a, r) => a + r.ms, 0) / 1000)).toFixed(2),
    samples: rs.map((r) => r.detail),
  }]));
  results[model] = { loadMs: Math.round(w.ms), ...agg };
  console.log(model, JSON.stringify(agg, (k, v) => (k === "samples" ? undefined : v)));
}
const out = `docs/bench/ollama-${new Date().toISOString().slice(0, 10)}.json`;
await Bun.write(out, JSON.stringify({ base: BASE, cpu: "8 vCPU, 15 GB RAM, no GPU", results }, null, 2));
console.log("wrote", out);
