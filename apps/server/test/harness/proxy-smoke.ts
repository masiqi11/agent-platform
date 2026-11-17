/**
 * ADR-0010 H1 manual check: real harnesses → platform model proxy → a real provider (NOT CI).
 * Serves the app on a local port, creates a dev agent session + harness token, prints the env each
 * harness needs, then waits for `harness-done` on stdin and prints what the proxy metered.
 *
 *   TEST_DATABASE_URL=… LLM_BASE_URL=https://…/v1 LLM_MODEL=… LLM_API_KEY=… LLM_APIS=chat,responses,messages \
 *     bun test/harness/proxy-smoke.ts
 */
import { eq } from "drizzle-orm";
import { agent, llmCall, session, tenant } from "../../src/db/schema";

const { createTestApp } = await import("../helpers");
const t = await createTestApp("h1smoke", { LLM_TIMEOUT_MS: "300000", LLM_FIRST_BYTE_MS: "240000" });
const server = Bun.serve({ port: Number(process.env.PROXY_PORT ?? 0), fetch: (req) => t.app.handle(req), idleTimeout: 0 });
const owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "S", email: "o@smoke.test", name: "O", password: "Correct-Horse-42" } })).body.token as string;
const tenantId = (await t.s.db.root.select().from(tenant))[0]!.id;
await t.s.llm.ensureDefaults(tenantId);
const projectId = (await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "SM", name: "smoke" } })).body.id as string;
const devId = (await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name: "开发", role: "dev" } })).body.id as string;
const a = (await t.s.db.root.select().from(agent).where(eq(agent.id, devId)))[0]!;
const ses = await t.s.runtime.getOrCreateSession(tenantId, a, "task", "tsk_smoke", null);
await t.s.db.root.update(session).set({ status: "running" }).where(eq(session.id, ses.id));
const token = t.s.runtime.harnessToken(a, ses.id, 3600);
await Bun.write(process.env.SMOKE_OUT ?? "/tmp/proxy-smoke.env", `PROXY=http://127.0.0.1:${server.port}\nTOKEN=${token}\n`);
console.log(`READY http://127.0.0.1:${server.port}`);
for await (const line of console) if (line.trim() === "harness-done") break;
const rows = await t.s.db.root.select().from(llmCall).where(eq(llmCall.sessionId, ses.id));
const by: Record<string, { n: number; ok: number; tin: number; tout: number }> = {};
for (const r of rows) {
  const k = `${r.purpose} ${r.model}`;
  const b = (by[k] ??= { n: 0, ok: 0, tin: 0, tout: 0 });
  b.n++;
  if (r.status === "ok") b.ok++;
  b.tin += r.tokensIn ?? 0;
  b.tout += r.tokensOut ?? 0;
}
console.log(JSON.stringify({ calls: rows.length, by, errors: rows.filter((r) => r.status !== "ok").map((r) => r.error?.slice(0, 200)) }, null, 2));
void server.stop(true);
await t.close();
process.exit(0);
