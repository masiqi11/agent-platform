/**
 * ADR-0010 H2 manual check (NOT CI): a dev agent bound to a REAL harness runs the S5 flow —
 * assignment → harness fixes the demo timeout → platform commit / push / MR → local CI → in_review.
 * The model comes from a platform provider (LLM_*), reached only through the platform proxy.
 *
 *   TEST_DATABASE_URL=… LLM_BASE_URL=https://…/v1 LLM_MODEL=… LLM_API_KEY=… LLM_APIS=chat,responses,messages \
 *   HARNESS_ENGINE=pi HARNESS_PI_BIN=… HARNESS_PASS_ENV=HTTPS_PROXY,HTTP_PROXY,NO_PROXY,NODE_EXTRA_CA_CERTS \
 *     bun test/harness/dev-real.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { PAYMENTS_REPO } from "../../src/cli/demo-repos";
import { job, llmCall, session, sessionTurn, task, workspace } from "../../src/db/schema";
import { git } from "../../src/modules/scm/git";

const engine = (process.env.HARNESS_ENGINE ?? "pi") as "pi" | "opencode" | "codex" | "claude-code";
const dataDir = mkdtempSync(join(tmpdir(), `ap-h2real-${engine}-`));
const { createTestApp } = await import("../helpers");
const t = await createTestApp(`h2real${engine}`, { DATA_DIR: dataDir, SANDBOX: "process", LLM_TIMEOUT_MS: "300000", LLM_FIRST_BYTE_MS: "240000" });
const server = Bun.serve({ port: 0, fetch: (req) => t.app.handle(req), idleTimeout: 0 });
t.s.config.harness.platformUrl = `http://127.0.0.1:${server.port}`;
const owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "R", email: "o@real.test", name: "王负责人", password: "Correct-Horse-42" } })).body.token as string;
const ownerCtx = await t.s.identity.authenticate(new Headers({ authorization: `Bearer ${owner}` }), "trc_real");
const projectId = (await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "PAY", name: "支付服务" } })).body.id as string;
const dev = await t.req("POST", `/api/v1/projects/${projectId}/agents`, {
  token: owner,
  body: { name: "开发 · 小码", role: "dev", engine, modelPolicy: { primary: process.env.LLM_MODEL }, budget: { wallClockMs: 15 * 60_000 } },
});
if (dev.status !== 200) throw new Error(JSON.stringify(dev.body));
const bound = await t.s.repos.bind(ownerCtx, projectId, { provider: "local", name: "payments", files: PAYMENTS_REPO, testCommand: "bun test" });
const { registerHandlers } = await import("../../src/modules/registry");
await registerHandlers(t.s);
await t.s.consumers.init();
await t.s.db.root.delete(job).where(sql`${job.cron} is not null`);

const tk = await t.req("POST", "/api/v1/tasks", {
  token: owner,
  body: {
    projectId,
    title: "排查支付服务超时",
    description: "支付服务下单接口最近偶发超时，用户等待很久后失败。",
    acceptanceCriteria: ["调用网关的超时小于上游网关超时", "仓库测试全部通过"],
    assigneeAgentId: dev.body.id,
  },
});
await t.req("POST", `/api/v1/tasks/${tk.body.id}/transition`, { token: owner, body: { to: "ready" } });
const t0 = Date.now();
for (let i = 0; i < 20; i++) {
  const a = await t.s.consumers.drain();
  const b = await t.s.jobs.drain();
  if (!a && !b) break;
}
const [row] = await t.s.db.root.select().from(task).where(eq(task.id, tk.body.id));
const [ws] = await t.s.db.root.select().from(workspace).where(eq(workspace.taskId, tk.body.id));
const [ses] = await t.s.db.root.select().from(session).where(eq(session.scopeId, tk.body.id));
const turns = await t.s.db.root.select().from(sessionTurn).where(eq(sessionTurn.sessionId, ses!.id)).orderBy(sessionTurn.idx);
const calls = await t.s.db.root.select().from(llmCall).where(eq(llmCall.sessionId, ses!.id));
const file = ws?.branch ? (await git(["show", `${ws.branch}:src/gateway.ts`], { cwd: bound.repo.url })).out : "";
const result = {
  engine,
  durationS: Math.round((Date.now() - t0) / 1000),
  status: row!.status,
  blockedReason: row!.blockedReason,
  stopReason: ses!.stopReason,
  mr: ws?.mrRef,
  ci: ws?.ci,
  timeoutLine: /GATEWAY_CALL_TIMEOUT_MS\s*=\s*[\d_]+/.exec(file)?.[0] ?? null,
  summary: (row!.testPlan as { summary?: string }).summary?.slice(0, 400),
  turns: turns.length,
  mcpCalls: turns
    .filter((x) => x.role === "tool" && (x.toolCalls as Array<{ name?: string }>)[0]?.name && !String(x.content).startsWith('{"ok":true,"output"'))
    .map((x) => (x.toolCalls as Array<{ name: string }>)[0]!.name),
  llm: {
    calls: calls.length,
    failed: calls.filter((c) => c.status !== "ok").length,
    tokensIn: calls.reduce((n, c) => n + (c.tokensIn ?? 0), 0),
    tokensOut: calls.reduce((n, c) => n + (c.tokensOut ?? 0), 0),
  },
};
console.log(JSON.stringify(result, null, 2));
if (process.env.RESULT_OUT) await Bun.write(process.env.RESULT_OUT, `${JSON.stringify(result, null, 2)}\n`);
void server.stop(true);
await t.close();
process.exit(0);
