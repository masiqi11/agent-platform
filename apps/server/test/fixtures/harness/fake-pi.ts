/**
 * Fake `pi` for CI (ADR-0010 H2): speaks pi's `--mode json` event format and uses the platform
 * exactly the way the real harness does — the model through the proxy (models.json), platform tools
 * over HTTP MCP (mcp.json), the session token only from $PLATFORM_LLM_TOKEN. The task text selects
 * a behaviour: default fixes the demo timeout; `[fake:noop]` changes nothing; `[fake:block]` blocks.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] ?? "";
const model = args[args.indexOf("--model") + 1] ?? "";
const home = process.env.HOME!;
const token = process.env.PLATFORM_LLM_TOKEN ?? "";
const emit = (e: unknown) => process.stdout.write(`${JSON.stringify(e)}\n`);
const expand = (s: string) => s.replace(/\$\{?PLATFORM_LLM_TOKEN\}?/g, token);

const models = JSON.parse(readFileSync(join(home, ".pi/agent/models.json"), "utf8")).providers.platform;
const mcpCfg = JSON.parse(readFileSync(join(home, ".pi/agent/mcp.json"), "utf8")).mcpServers.platform;
let rpcId = 0;
async function mcp(method: string, params: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  for (const [k, v] of Object.entries(mcpCfg.headers as Record<string, string>)) headers[k] = expand(v);
  const r = await fetch(mcpCfg.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  return (await r.json()) as { result?: any; error?: { message: string } };
}
async function tool(name: string, input: Record<string, unknown>) {
  emit({ type: "tool_execution_start", toolName: name, args: input });
  const r = await mcp("tools/call", { name, arguments: input });
  const text = r.result?.content?.[0]?.text ?? r.error?.message ?? "";
  emit({ type: "tool_execution_end", toolName: name, isError: Boolean(r.result?.isError || r.error), result: { content: [{ type: "text", text }] } });
  return { text, isError: Boolean(r.result?.isError || r.error) };
}

emit({ type: "session", version: 3, id: args.includes("--continue") ? "fake-pi-ses-1" : "fake-pi-ses-1", cwd: process.cwd() });
await mcp("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake-pi", version: "0" } });
const listed = await mcp("tools/list");
const names: string[] = (listed.result?.tools ?? []).map((t: { name: string }) => t.name);
emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `可用平台工具：${names.join(",")}` }] } });

const task = await tool("get_task", {});
// The harness tries to drive git itself: the platform refuses (not in the role's MCP tool set).
await tool("commit", { message: "sneaky" });

// One model call through the proxy, like a real turn.
const res = await fetch(`${models.baseUrl}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${expand(models.apiKey)}` },
  body: JSON.stringify({ model, messages: [{ role: "user", content: prompt.slice(0, 2000) }] }),
});
const answer = res.ok ? (((await res.json()) as any).choices?.[0]?.message?.content ?? "") : `模型代理返回 ${res.status}`;
emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }], usage: { input: 10, output: 5 } } });

if (prompt.includes("[fake:block]")) {
  await tool("block_task", { reason: "需求里的超时上限和网关文档矛盾，需要确认", needs: "产品负责人" });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "已阻塞，等待确认。" }] } });
  process.exit(0);
}
if (!prompt.includes("[fake:noop]")) {
  const f = join(process.cwd(), "src/gateway.ts");
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "src/gateway.ts" } }] } });
  writeFileSync(f, readFileSync(f, "utf8").replace("30_000", "3_000"));
  emit({ type: "tool_execution_end", toolName: "edit", isError: false, result: { content: [{ type: "text", text: "ok" }] } });
}
emit({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: `已把网关调用超时改为 3_000，小于上游网关超时；bun test 全部通过。（任务信息长度 ${task.text.length}）` }], stopReason: "stop" },
});
