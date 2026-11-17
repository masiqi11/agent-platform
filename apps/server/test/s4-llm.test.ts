import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Ctx } from "../src/core/context";
import { budget, llmCall, modelProvider, project, tenant } from "../src/db/schema";
import { createLlm } from "../src/modules/llm/service";
import { createTestApp, type TestApp } from "./helpers";

process.env.LLM_BACKOFF_MS = "2";
let t: TestApp;
let ctx: Ctx;
let projectId = "";
let owner = "";
const PW = "Correct-Horse-42";

type Handler = (body: any, req: Request) => Response | Promise<Response>;
let handler: Handler = () => new Response("no", { status: 500 });
const seen: any[] = [];
let server: ReturnType<typeof Bun.serve>;
const base = () => `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json().catch(() => null);
      seen.push({ url: new URL(req.url).pathname, body, auth: req.headers.get("authorization") });
      return handler(body, req);
    },
  });
  t = await createTestApp("s4llm");
  const setup = await t.req("POST", "/api/v1/setup", { body: { tenantName: "L", email: "o@l.test", name: "O", password: PW } });
  owner = setup.body.token;
  const p = await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "LLM", name: "模型层" } });
  projectId = p.body.id;
  const [tn] = await t.s.db.root.select().from(tenant);
  ctx = await t.s.identity.systemCtx(tn!.id);
});
afterAll(async () => {
  void server.stop(true);
  await t?.close();
});

async function provider(name: string, dialect: "openai" | "ollama", models: Array<Record<string, unknown>>, opts: { isExternal?: boolean; apiKey?: string } = {}) {
  const r = await t.req("POST", "/api/v1/admin/models/providers", {
    token: owner,
    body: { name, baseUrl: dialect === "ollama" ? base() : `${base()}/v1`, dialect, isExternal: opts.isExternal ?? false, apiKey: opts.apiKey, models },
  });
  expect(r.status).toBe(200);
  return r.body.id as string;
}
const ollamaReply = (content: string, tool?: { name: string; arguments: Record<string, unknown> }) =>
  Response.json({ message: { role: "assistant", content, ...(tool ? { tool_calls: [{ function: tool }] } : {}) }, prompt_eval_count: 50, eval_count: 7, done: true });

describe("S4 model gateway", () => {
  test("Ollama native dialect: think:false, tools, num_ctx; metered with promptVersion", async () => {
    await provider("本地 Ollama", "ollama", [{ name: "gemma4:e2b", supportsTools: true, supportsJson: true, thinkOff: true, contextWindow: 8192 }]);
    handler = () => ollamaReply("", { name: "ask_question", arguments: { question: "哪个接口？" } });
    const r = await t.s.llm.complete(ctx, {
      purpose: "test.tools",
      promptVersion: "p.v9",
      scope: { projectId },
      modelPolicy: { primary: "gemma4:e2b" },
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "ask_question", description: "q", parameters: { type: "object", properties: {} } }],
    });
    const last = seen.at(-1);
    expect(last.url).toBe("/api/chat");
    expect(last.body.think).toBe(false);
    expect(last.body.tools[0].function.name).toBe("ask_question");
    expect(last.body.options.num_ctx).toBe(8192);
    expect(r.toolMode).toBe("native");
    expect(r.toolCalls[0]!.arguments.question).toBe("哪个接口？");
    const [row] = await t.s.db.root.select().from(llmCall).where(eq(llmCall.purpose, "test.tools"));
    expect(row).toMatchObject({ model: "gemma4:e2b", promptVersion: "p.v9", tokensIn: 50, tokensOut: 7, status: "ok", toolMode: "native", dataClasses: [] });
  });

  test("Ollama streaming NDJSON deltas", async () => {
    handler = () =>
      new Response(['{"message":{"content":"你"}}', '{"message":{"content":"好"}}', '{"message":{"content":""},"done":true,"prompt_eval_count":3,"eval_count":2}'].join("\n") + "\n", {
        headers: { "content-type": "application/x-ndjson" },
      });
    const deltas: string[] = [];
    const r = await t.s.llm.complete(ctx, {
      purpose: "test.stream",
      promptVersion: "v",
      scope: {},
      modelPolicy: { primary: "gemma4:e2b" },
      messages: [{ role: "user", content: "x" }],
      onDelta: (x) => deltas.push(x),
    });
    expect(seen.at(-1).body.stream).toBe(true);
    expect(deltas).toEqual(["你", "好"]);
    expect(r.content).toBe("你好");
    expect(r.tokensOut).toBe(2);
  });

  test("OpenAI SSE with streamed tool_call fragments, keep-alive comments and event lines; key sent but never stored in plaintext", async () => {
    await provider("远端", "openai", [{ name: "remote-small", supportsTools: true }], { isExternal: true, apiKey: "test-key-not-real-0042" });
    handler = () => {
      const chunks = [
        { choices: [{ delta: { content: "好的" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "propose_task", arguments: '{"title":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"修复"}' } }] } }] },
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 4 } },
      ];
      // Real gateways interleave `: ping` keep-alives and `event:` lines (found on a relay in front of Claude).
      const body = chunks.map((c, i) => `${i === 1 ? ": ping\n\n" : ""}event: message\ndata: ${JSON.stringify(c)}\n\n`).join("") + ": ping\n\ndata: [DONE]\n\n";
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    const r = await t.s.llm.complete(ctx, {
      purpose: "test.sse",
      promptVersion: "v",
      scope: {},
      modelPolicy: { primary: "remote-small" },
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "propose_task", description: "p", parameters: {} }],
      onDelta: () => {},
    });
    expect(seen.at(-1).url).toBe("/v1/chat/completions");
    expect(seen.at(-1).auth).toBe("Bearer test-key-not-real-0042");
    expect(r.toolCalls).toEqual([{ name: "propose_task", arguments: { title: "修复" } }]);
    expect(r.tokensIn).toBe(11);
    const list = (await t.req("GET", "/api/v1/admin/models", { token: owner })).body;
    expect(JSON.stringify(list)).not.toContain("test-key-not-real-0042");
    expect(list.providers.find((p: { name: string }) => p.name === "远端").keyLast4).toBe("0042");
    const [row] = await t.s.db.root.select().from(llmCall).where(eq(llmCall.purpose, "test.sse"));
    expect(row!.dataClasses).toEqual(["chat"]);
  });

  test("parallel tool calls streamed with the same index but different ids stay separate", async () => {
    handler = () => {
      const tc = (x: Record<string, unknown>) => ({ choices: [{ delta: { tool_calls: [x] } }] });
      const chunks = [
        tc({ index: 0, id: "toolu_a", type: "function", function: { name: "search_knowledge", arguments: "" } }),
        tc({ index: 0, function: { arguments: '{"query": "支付' } }),
        tc({ index: 0, function: { arguments: ' 超时"}' } }),
        tc({ index: 0, id: "toolu_b", type: "function", function: { name: "ask_question", arguments: "" } }),
        tc({ index: 0, function: { arguments: '{"question": "从什么时候开始？"}' } }),
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ];
      return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    };
    const r = await t.s.llm.complete(ctx, {
      purpose: "test.sse.parallel",
      promptVersion: "v",
      scope: {},
      modelPolicy: { primary: "remote-small" },
      messages: [{ role: "user", content: "x" }],
      tools: [
        { name: "search_knowledge", description: "s", parameters: {} },
        { name: "ask_question", description: "q", parameters: {} },
      ],
      onDelta: () => {},
    });
    expect(r.toolCalls).toEqual([
      { name: "search_knowledge", arguments: { query: "支付 超时" } },
      { name: "ask_question", arguments: { question: "从什么时候开始？" } },
    ]);
  });

  test("streamed tool arguments that cannot be reassembled → the same request is retried once without streaming", async () => {
    // Pattern seen on a Claude relay: two calls opened at index 0 and 1, then every argument fragment under index 1, interleaved.
    handler = (body) => {
      if (!body.stream)
        return Response.json({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  { id: "a", type: "function", function: { name: "search_knowledge", arguments: '{"query":"支付服务 /pay/callback"}' } },
                  { id: "b", type: "function", function: { name: "search_knowledge", arguments: '{"query":"pay service timeout"}' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      const tc = (x: Record<string, unknown>) => ({ choices: [{ delta: { tool_calls: [x] } }] });
      const chunks = [
        tc({ index: 0, id: "a", type: "function", function: { name: "search_knowledge", arguments: "" } }),
        tc({ index: 0, function: { arguments: '{"query": "支付服务 /pa' } }),
        tc({ index: 1, id: "b", type: "function", function: { name: "search_knowledge", arguments: "" } }),
        tc({ index: 1, function: { arguments: '{"query": "p' } }),
        tc({ index: 1, function: { arguments: 'y/callback"}' } }),
        tc({ index: 1, function: { arguments: 'ay service timeout"}' } }),
      ];
      return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    };
    const before = seen.length;
    const r = await t.s.llm.complete(ctx, {
      purpose: "test.sse.mislabeled",
      promptVersion: "v",
      scope: {},
      modelPolicy: { primary: "remote-small" },
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "search_knowledge", description: "s", parameters: {} }],
      onDelta: () => {},
    });
    expect(seen.slice(before).map((x) => x.body.stream)).toEqual([true, false]);
    expect(r.toolCalls).toEqual([
      { name: "search_knowledge", arguments: { query: "支付服务 /pay/callback" } },
      { name: "search_knowledge", arguments: { query: "pay service timeout" } },
    ]);
  });

  test("LLM-10: secrets are redacted before leaving", async () => {
    handler = () => Response.json({ choices: [{ message: { content: "ok" } }] });
    await t.s.llm.complete(ctx, {
      purpose: "test.redact",
      promptVersion: "v",
      scope: {},
      modelPolicy: { primary: "remote-small" },
      messages: [{ role: "user", content: "我的 key 是 sk-abcdefghijklmnopqrstuvwxyz123456 请保管" }],
    });
    expect(JSON.stringify(seen.at(-1).body)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  test("LLM-04: invalid JSON → one repair call → valid", async () => {
    let n = 0;
    handler = () => Response.json({ choices: [{ message: { content: n++ === 0 ? "抱歉我不会" : '{"answer":"42"}' } }] });
    const r = await t.s.llm.complete(ctx, {
      purpose: "test.json",
      promptVersion: "v",
      scope: {},
      json: true,
      validate: (v) => (typeof (v as { answer?: unknown }).answer === "string" ? null : "缺 answer"),
      modelPolicy: { primary: "remote-small" },
      messages: [{ role: "user", content: "x" }],
    });
    expect(r.valid).toBe(true);
    expect(r.repaired).toBe(true);
    expect(r.json).toEqual({ answer: "42" });
    expect(String(seen.at(-1).body.messages.at(-1).content)).toContain("不是合法 JSON");
  });

  test("LLM-05/06: retries with backoff (3), then fallback; circuit opens after 5 failures and is skipped", async () => {
    await t.s.db.root.update(modelProvider).set({ circuitState: { state: "closed", failures: 0 } });
    handler = () => new Response("boom", { status: 503 });
    const before = seen.length;
    const r = await t.s.llm.complete(ctx, {
      purpose: "test.fallback",
      promptVersion: "v",
      scope: {},
      modelPolicy: { primary: "remote-small", fallback: "scripted:demo" },
      messages: [{ role: "user", content: "x" }],
    });
    expect(seen.length - before).toBe(4); // 1 + 3 retries
    expect(r.model).toBe("scripted:demo");
    expect(r.usedFallback).toBe(true);
    const rows = await t.s.db.root.select().from(llmCall).where(eq(llmCall.purpose, "test.fallback"));
    expect(rows.filter((x) => x.status === "error").length).toBe(4);
    expect(rows.find((x) => x.status === "ok")!.fallbackFrom).toBe("remote-small");
    for (let i = 0; i < 4; i++)
      await t.s.llm.complete(ctx, {
        purpose: "test.fallback",
        promptVersion: "v",
        scope: {},
        modelPolicy: { primary: "remote-small", fallback: "scripted:demo" },
        messages: [{ role: "user", content: "x" }],
      });
    const [p] = await t.s.db.root.select().from(modelProvider).where(eq(modelProvider.name, "远端"));
    expect(p!.circuitState.state).toBe("open");
    const n = seen.length;
    const r2 = await t.s.llm.complete(ctx, {
      purpose: "test.fallback",
      promptVersion: "v",
      scope: {},
      modelPolicy: { primary: "remote-small", fallback: "scripted:demo" },
      messages: [{ role: "user", content: "x" }],
    });
    expect(seen.length).toBe(n);
    expect(r2.model).toBe("scripted:demo");
    await t.s.db.root.update(modelProvider).set({ circuitState: { state: "closed", failures: 0 } });
  });

  test("4xx is not retried", async () => {
    handler = () => new Response("bad", { status: 400 });
    const before = seen.length;
    await expect(t.s.llm.complete(ctx, { purpose: "test.4xx", promptVersion: "v", scope: {}, modelPolicy: { primary: "remote-small" }, messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
      "模型不可用",
    );
    expect(seen.length - before).toBe(1);
    await t.s.db.root.update(modelProvider).set({ circuitState: { state: "closed", failures: 0 } });
  });

  test("timeouts are enforced", async () => {
    const llm = createLlm({ config: t.s.config, db: t.s.db, audit: t.s.audit, events: t.s.events, identity: t.s.identity, vault: t.s.vault }, { timeoutMs: 80, firstByteMs: 50, maxRetries: 0 });
    handler = async () => {
      await Bun.sleep(300);
      return Response.json({ choices: [{ message: { content: "late" } }] });
    };
    await expect(llm.complete(ctx, { purpose: "test.timeout", promptVersion: "v", scope: {}, modelPolicy: { primary: "remote-small" }, messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
      "超时",
    );
    await t.s.db.root.update(modelProvider).set({ circuitState: { state: "closed", failures: 0 } });
  });

  test("LLM-11: localModelsOnly project never sends data to an external provider", async () => {
    await t.s.db.root
      .update(project)
      .set({ settings: { localModelsOnly: true } })
      .where(eq(project.id, projectId));
    const before = seen.length;
    const r = await t.s.llm.complete(ctx, {
      purpose: "test.egress",
      promptVersion: "v",
      scope: { projectId },
      modelPolicy: { primary: "remote-small", fallback: "gemma4:e2b" },
      messages: [{ role: "user", content: "x" }],
    });
    expect(r.model).toBe("gemma4:e2b"); // local
    expect(seen.slice(before).every((s) => s.url === "/api/chat")).toBe(true);
    await expect(
      t.s.llm.complete(ctx, { purpose: "test.egress", promptVersion: "v", scope: { projectId }, modelPolicy: { primary: "remote-small" }, messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow("只允许本地模型");
    await t.s.db.root.update(project).set({ settings: {} }).where(eq(project.id, projectId));
  });

  test("LLM-08: budget reserve/settle is atomic; exceeding throws and marks exceeded", async () => {
    handler = () => ollamaReply("ok");
    await t.req("PUT", "/api/v1/admin/budgets", { token: owner, body: { scopeType: "project", scopeId: projectId, limitTokens: 5000 } });
    await t.s.llm.complete(ctx, {
      purpose: "test.budget",
      promptVersion: "v",
      scope: { projectId },
      modelPolicy: { primary: "gemma4:e2b", maxTokens: 100 },
      messages: [{ role: "user", content: "x" }],
    });
    let [b] = await t.s.db.root
      .select()
      .from(budget)
      .where(and(eq(budget.scopeType, "project"), eq(budget.scopeId, projectId)));
    expect(b!.usedTokens).toBe(57);
    expect(b!.reservedTokens).toBe(0);
    await expect(
      t.s.llm.complete(ctx, { purpose: "test.budget", promptVersion: "v", scope: { projectId }, modelPolicy: { primary: "gemma4:e2b", maxTokens: 9000 }, messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow("预算");
    [b] = await t.s.db.root.select().from(budget).where(eq(budget.id, b!.id));
    expect(b!.status).toBe("exceeded");
    expect(b!.reservedTokens).toBe(0);
    // concurrent reservations never overshoot
    await t.req("PUT", "/api/v1/admin/budgets", { token: owner, body: { scopeType: "project", scopeId: projectId, limitTokens: 57 + 3 * 120 } });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        t.s.llm.complete(ctx, { purpose: "test.budget", promptVersion: "v", scope: { projectId }, modelPolicy: { primary: "gemma4:e2b", maxTokens: 110 }, messages: [{ role: "user", content: "x" }] }),
      ),
    );
    expect(results.some((r) => r.status === "rejected")).toBe(true);
    [b] = await t.s.db.root.select().from(budget).where(eq(budget.id, b!.id));
    expect(b!.usedTokens).toBeLessThanOrEqual(57 + 3 * 120);
    expect(b!.reservedTokens).toBe(0);
    await t.s.db.root.delete(budget);
  });

  test("connectivity test + usage report (admin only)", async () => {
    handler = () => ollamaReply("OK");
    const list = (await t.req("GET", "/api/v1/admin/models", { token: owner })).body;
    const ol = list.providers.find((p: { dialect: string }) => p.dialect === "ollama");
    const r = await t.req("POST", `/api/v1/admin/models/providers/${ol.id}/test`, { token: owner });
    expect(r.body.ok).toBe(true);
    const u = (await t.req("GET", "/api/v1/admin/usage", { token: owner })).body;
    expect(u.byModel.some((x: { model: string }) => x.model === "gemma4:e2b")).toBe(true);
    expect((await t.req("PUT", "/api/v1/admin/models/default", { token: owner, body: { name: "nope" } })).status).toBe(400);
    expect((await t.req("PUT", "/api/v1/admin/models/default", { token: owner, body: { name: "scripted:demo" } })).status).toBe(200);
  });
});
