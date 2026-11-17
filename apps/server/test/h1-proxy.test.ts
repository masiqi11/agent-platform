import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { agent, llmCall, session, tenant } from "../src/db/schema";
import { createTestApp, type TestApp } from "./helpers";

/**
 * ADR-0010 H1: the model proxy harnesses call instead of a provider. A fake upstream records what
 * reaches it, so the tests can check what the harness can and cannot see.
 */
let t: TestApp;
let owner = "";
let tenantId = "";
let projectId = "";
let devId = "";
let token = "";
let sessionId = "";
const UPSTREAM_KEY = "sk-upstream-real-key-000042";
const seen: Array<{ path: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
let server: ReturnType<typeof Bun.serve>;

const sse = (events: unknown[]) => events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = (await req.json()) as Record<string, unknown>;
      seen.push({ path, body, headers: Object.fromEntries(req.headers.entries()) });
      const stream = body.stream === true;
      if (path === "/v1/chat/completions") {
        if (!stream) return Response.json({ id: "c1", choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 120, completion_tokens: 8 } });
        return new Response(sse([{ choices: [{ delta: { content: "o" } }] }, { choices: [{ delta: { content: "k" } }] }, { choices: [], usage: { prompt_tokens: 90, completion_tokens: 2 } }]), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (path === "/v1/responses")
        return new Response(
          sse([
            { type: "response.output_text.delta", delta: "ok" },
            { type: "response.completed", response: { usage: { input_tokens: 300, output_tokens: 12 } } },
          ]),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      if (path === "/v1/messages")
        return new Response(
          sse([
            { type: "message_start", message: { usage: { input_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 } } },
            { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
            { type: "message_delta", usage: { output_tokens: 15 } },
            { type: "message_stop" },
          ]),
          { headers: { "content-type": "text/event-stream" } },
        );
      return new Response("not found", { status: 404 });
    },
  });
  t = await createTestApp("h1proxy");
  owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "H1", email: "o@h1.test", name: "O", password: "Correct-Horse-42" } })).body.token;
  tenantId = (await t.s.db.root.select().from(tenant))[0]!.id;
  projectId = (await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "HP", name: "代理" } })).body.id;
  const prov = await t.req("POST", "/api/v1/admin/models/providers", {
    token: owner,
    body: {
      name: "中转",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      dialect: "openai",
      isExternal: true,
      apiKey: UPSTREAM_KEY,
      apis: ["chat", "responses", "messages"],
      models: [{ name: "real-model" }],
    },
  });
  expect(prov.status).toBe(200);
  devId = (await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name: "开发 · 小码", role: "dev" } })).body.id;
  await t.s.db.root
    .update(agent)
    .set({ modelPolicy: { primary: "real-model" } })
    .where(eq(agent.id, devId));
  const a = (await t.s.db.root.select().from(agent).where(eq(agent.id, devId)))[0]!;
  const ses = await t.s.runtime.getOrCreateSession(tenantId, a, "task", "tsk_fake_for_proxy", null);
  sessionId = ses.id;
  await t.s.db.root.update(session).set({ status: "running" }).where(eq(session.id, sessionId));
  token = t.s.runtime.harnessToken(a, sessionId, 600);
});
afterAll(async () => {
  void server.stop(true);
  await t?.close();
});

const call = (path: string, body: unknown, headers: Record<string, string>) =>
  t.app.handle(new Request(`http://localhost/llm/v1${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const lastCall = async () =>
  (
    await t.s.db.root
      .select()
      .from(llmCall)
      .where(eq(llmCall.sessionId, sessionId))
      .orderBy(sql`${llmCall.createdAt} desc`)
      .limit(1)
  )[0]!;

describe("H1 harness model proxy", () => {
  test("chat: the upstream gets the real key and the agent's model; the harness only ever held its session token", async () => {
    const r = await call("/chat/completions", { model: "whatever-the-harness-asked", messages: [{ role: "user", content: "hi" }] }, { authorization: `Bearer ${token}` });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe("ok");
    const up = seen.at(-1)!;
    expect(up.path).toBe("/v1/chat/completions");
    expect(up.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(up.body.model).toBe("real-model");
    expect(JSON.stringify(up)).not.toContain(token);
    const row = await lastCall();
    expect(row).toMatchObject({ purpose: "harness.dev", model: "real-model", tokensIn: 120, tokensOut: 8, status: "ok", toolMode: "harness", taskId: "tsk_fake_for_proxy", projectId });
  });

  test("chat streaming passes the SSE bytes through and meters the final usage chunk", async () => {
    const r = await call("/chat/completions", { model: "x", stream: true, messages: [{ role: "user", content: "hi" }] }, { authorization: `Bearer ${token}` });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const text = await r.text();
    expect(text).toContain('"content":"o"');
    expect(text).toContain("[DONE]");
    expect(seen.at(-1)!.body.stream_options).toMatchObject({ include_usage: true });
    await Bun.sleep(50);
    expect(await lastCall()).toMatchObject({ tokensIn: 90, tokensOut: 2 });
  });

  test("Anthropic messages via x-api-key (Claude Code): forwarded with the upstream key; cache reads count as input", async () => {
    const r = await call(
      "/messages",
      { model: "claude-x", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] },
      { "x-api-key": token, "anthropic-version": "2023-06-01", "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" },
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("message_stop");
    const up = seen.at(-1)!;
    expect(up.path).toBe("/v1/messages");
    expect(up.headers["x-api-key"]).toBe(UPSTREAM_KEY);
    expect(up.headers["anthropic-beta"]).toBe("fine-grained-tool-streaming-2025-05-14");
    expect(up.headers.authorization).toBeUndefined();
    await Bun.sleep(50);
    expect(await lastCall()).toMatchObject({ tokensIn: 1040, tokensOut: 15 });
  });

  test("Responses API (Codex) streaming: usage from response.completed", async () => {
    const r = await call("/responses", { model: "x", stream: true, input: "hi" }, { authorization: `Bearer ${token}` });
    expect(await r.text()).toContain("response.completed");
    expect(seen.at(-1)!.path).toBe("/v1/responses");
    await Bun.sleep(50);
    expect(await lastCall()).toMatchObject({ tokensIn: 300, tokensOut: 12 });
  });

  test("LLM-10: secrets in the harness's request are redacted before they leave", async () => {
    await call("/chat/completions", { model: "x", messages: [{ role: "user", content: "key is sk-abcdefghijklmnopqrstuvwxyz123456 here" }] }, { authorization: `Bearer ${token}` });
    expect(JSON.stringify(seen.at(-1)!.body)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  test("only live agent session tokens are accepted", async () => {
    const before = seen.length;
    expect((await call("/chat/completions", { messages: [] }, {})).status).toBe(401);
    expect((await call("/chat/completions", { messages: [] }, { authorization: `Bearer ${owner}` })).status).toBe(403); // a human's token
    await t.s.db.root.update(session).set({ status: "idle" }).where(eq(session.id, sessionId));
    expect((await call("/chat/completions", { messages: [] }, { authorization: `Bearer ${token}` })).status).toBe(403); // session ended
    await t.s.db.root.update(session).set({ status: "running" }).where(eq(session.id, sessionId));
    await t.s.db.root
      .update(agent)
      .set({ tokenVersion: sql`${agent.tokenVersion} + 1` })
      .where(eq(agent.id, devId)); // paused / token revoked
    expect((await call("/chat/completions", { messages: [] }, { authorization: `Bearer ${token}` })).status).toBe(401);
    const a = (await t.s.db.root.select().from(agent).where(eq(agent.id, devId)))[0]!;
    token = t.s.runtime.harnessToken(a, sessionId, 600);
    expect(seen.length).toBe(before); // nothing reached the upstream
  });

  test("budget exhausted → 429 before any upstream call (INV-19)", async () => {
    await t.req("PUT", "/api/v1/admin/budgets", { token: owner, body: { scopeType: "project", scopeId: projectId, limitTokens: 10 } });
    const before = seen.length;
    const r = await call("/chat/completions", { model: "x", messages: [{ role: "user", content: "hi" }] }, { authorization: `Bearer ${token}` });
    expect(r.status).toBe(429);
    expect(seen.length).toBe(before);
    await t.s.db.root.execute(sql`delete from budget where scope_id = ${projectId}`);
  });

  test("LLM-11: a localModelsOnly project never reaches an external provider through a harness", async () => {
    await t.s.db.root.execute(sql`update project set settings = settings || '{"localModelsOnly":true}'::jsonb where id = ${projectId}`);
    const before = seen.length;
    const r = await call("/chat/completions", { model: "x", messages: [{ role: "user", content: "hi" }] }, { authorization: `Bearer ${token}` });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain("只允许本地模型");
    expect(seen.length).toBe(before);
    await t.s.db.root.execute(sql`update project set settings = settings - 'localModelsOnly' where id = ${projectId}`);
  });

  test("a provider that doesn't speak the harness's API is never used", async () => {
    await t.s.db.root
      .update(agent)
      .set({ modelPolicy: { primary: "scripted:demo" } })
      .where(and(eq(agent.id, devId)));
    const r = await call("/messages", { model: "x", messages: [] }, { "x-api-key": token });
    expect(r.status).toBe(400);
    await t.s.db.root
      .update(agent)
      .set({ modelPolicy: { primary: "real-model" } })
      .where(eq(agent.id, devId));
  });
});
