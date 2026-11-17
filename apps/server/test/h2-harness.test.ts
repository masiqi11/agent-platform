import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { PAYMENTS_REPO } from "../src/cli/demo-repos";
import type { Ctx } from "../src/core/context";
import { agent, job, llmCall, review, session, sessionTurn, task, testRun, workspace } from "../src/db/schema";
import { git } from "../src/modules/scm/git";
import { createTestApp, type TestApp } from "./helpers";

/**
 * ADR-0010 H2: a dev agent bound to an external engine. The engine here is a fake `pi` that uses
 * the platform exactly like the real one (model via the proxy, platform tools over HTTP MCP, the
 * session token from its environment), so the whole path runs in CI without a real harness.
 */
let t: TestApp;
let platform: ReturnType<typeof Bun.serve>;
let upstream: ReturnType<typeof Bun.serve>;
const dataDir = mkdtempSync(join(tmpdir(), "ap-h2-"));
const UPSTREAM_KEY = "sk-upstream-h2-real-key-0007";
const upstreamSeen: Array<{ auth: string; model: unknown }> = [];
let owner = "";
let ownerCtx: Ctx;
let projectId = "";
let devId = "";
let repoUrl = "";

async function settle(max = 14) {
  for (let i = 0; i < max; i++) {
    const a = await t.s.consumers.drain();
    const b = await t.s.jobs.drain();
    if (!a && !b) return;
  }
}
async function newTask(title: string, extra = "") {
  const r = await t.req("POST", "/api/v1/tasks", {
    token: owner,
    body: { projectId, title, description: `支付服务下单接口偶发超时。${extra}`, acceptanceCriteria: ["调用网关的超时小于上游网关超时", "仓库测试全部通过"], assigneeAgentId: devId },
  });
  expect(r.status).toBe(200);
  expect((await t.req("POST", `/api/v1/tasks/${r.body.id}/transition`, { token: owner, body: { to: "ready" } })).status).toBe(200);
  return r.body.id as string;
}
const turnsOf = async (taskId: string) => {
  const [ses] = await t.s.db.root
    .select()
    .from(session)
    .where(and(eq(session.scopeType, "task"), eq(session.scopeId, taskId), eq(session.agentId, devId)));
  return { ses: ses!, turns: await t.s.db.root.select().from(sessionTurn).where(eq(sessionTurn.sessionId, ses!.id)).orderBy(sessionTurn.idx) };
};

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model?: unknown };
      upstreamSeen.push({ auth: req.headers.get("authorization") ?? "", model: body.model });
      return Response.json({ id: "c", choices: [{ message: { role: "assistant", content: "先看 src/gateway.ts 的超时常量。" } }], usage: { prompt_tokens: 50, completion_tokens: 9 } });
    },
  });
  t = await createTestApp("h2harness", { DATA_DIR: dataDir, SANDBOX: "process", HARNESS_PI_BIN: `${process.execPath} ${join(import.meta.dir, "fixtures/harness/fake-pi.ts")}` });
  platform = Bun.serve({ port: 0, fetch: (r) => t.app.handle(r) });
  t.s.config.harness.platformUrl = `http://127.0.0.1:${platform.port}`;
  owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "H2", email: "o@h2.test", name: "王负责人", password: "Correct-Horse-42" } })).body.token;
  ownerCtx = await t.s.identity.authenticate(new Headers({ authorization: `Bearer ${owner}` }), "trc_h2");
  projectId = (await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "PAY", name: "支付服务" } })).body.id;
  const prov = await t.req("POST", "/api/v1/admin/models/providers", {
    token: owner,
    body: { name: "中转", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, dialect: "openai", isExternal: true, apiKey: UPSTREAM_KEY, apis: ["chat"], models: [{ name: "relay-model" }] },
  });
  expect(prov.status).toBe(200);
  const dev = await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name: "开发 · 小码", role: "dev", engine: "pi", modelPolicy: { primary: "relay-model" } } });
  expect(dev.status).toBe(200);
  expect(dev.body.engine).toBe("pi");
  devId = dev.body.id;
  for (const [name, role] of [
    ["评审 · 严审", "reviewer"],
    ["测试 · 测测", "tester"],
  ] as const) {
    const r = await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name, role, engine: "pi", modelPolicy: { primary: "relay-model" } } });
    expect(r.status).toBe(200);
  }
  const bound = await t.s.repos.bind(ownerCtx, projectId, { provider: "local", name: "payments", files: PAYMENTS_REPO, testCommand: "bun test" });
  repoUrl = bound.repo.url;
  const { registerHandlers } = await import("../src/modules/registry");
  await registerHandlers(t.s);
  await t.s.consumers.init();
  await t.s.db.root.delete(job).where(sql`${job.cron} is not null`);
});
afterAll(async () => {
  void platform?.stop(true);
  void upstream?.stop(true);
  await t?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("H2 dev agent on an external engine (fake pi)", () => {
  test("captains cannot bind an external engine", async () => {
    const r = await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name: "船长 X", role: "sub_captain", engine: "codex" } });
    expect(r.status).toBe(400);
  });

  test("assignment → harness edits → platform commits, pushes, opens MR → CI → review requested", async () => {
    const id = await newTask("排查支付服务超时");
    await settle();
    const [row] = await t.s.db.root.select().from(task).where(eq(task.id, id));
    // Dev, reviewer and tester all on the fake engine: the task waits for the human merge approval (S6 step 8).
    expect(row!.status).toBe("testing");
    // The harness's closing summary becomes the change description / draft test plan.
    expect(row!.testPlan).toMatchObject({ draftBy: devId });
    expect(String((row!.testPlan as { summary?: string }).summary)).toContain("3_000");

    const [ws] = await t.s.db.root.select().from(workspace).where(eq(workspace.taskId, id));
    expect(ws!.mrRef).toBe("!1");
    expect(ws!.ci).toMatchObject({ status: "success", sha: ws!.headCommit });
    expect((await git(["show", `${ws!.branch}:src/gateway.ts`], { cwd: repoUrl })).out).toContain("GATEWAY_CALL_TIMEOUT_MS = 3_000");
    // Only the code change was committed: the harness HOME (configs, caches) never reaches git.
    const tree = (await git(["ls-tree", "-r", "--name-only", ws!.branch], { cwd: repoUrl })).out;
    expect(tree).not.toContain(".sandbox-home");
    const log = (await git(["log", "-1", "--format=%an|%B", ws!.branch], { cwd: repoUrl })).out;
    expect(log).toContain("开发 · 小码");
    expect(log).toContain("Task: PAY-1");

    const { ses, turns } = await turnsOf(id);
    expect(ses.checkpoint).toMatchObject({ harnessSession: "fake-pi-ses-1", harness: null });
    const text = turns.map((x) => `${x.role}:${x.content}`).join("\n");
    // Platform tools over MCP: only the role's set is listed; get_task works; commit is refused.
    const listed = /可用平台工具：([^\n]*)/.exec(text)![1]!.split(",");
    expect(listed.sort()).toEqual(["add_task_comment", "block_task", "get_task", "search_knowledge"]);
    expect(text).toContain("调用网关的超时小于上游网关超时"); // get_task answered over MCP
    expect(text).toMatch(/工具 commit 不可用/);
    // The model went through the proxy: the upstream saw the real key and the agent's model, never the session token.
    expect(upstreamSeen.at(-1)).toEqual({ auth: `Bearer ${UPSTREAM_KEY}`, model: "relay-model" });
    const calls = await t.s.db.root.select().from(llmCall).where(eq(llmCall.taskId, id));
    expect(calls.some((c) => c.purpose === "harness.dev" && c.tokensIn === 50)).toBe(true);

    // Reviewer and tester concluded only through the platform tools, bound to the head commit (INV-08).
    const [rv] = await t.s.db.root.select().from(review).where(eq(review.taskId, id));
    expect(rv).toMatchObject({ verdict: "approved", headSha: ws!.headCommit, reviewerKind: "agent" });
    expect(Object.values(rv!.criteriaVerdicts)).toEqual(["met", "met"]);
    const [tr] = await t.s.db.root.select().from(testRun).where(eq(testRun.taskId, id));
    expect(tr).toMatchObject({ status: "passed", headSha: ws!.headCommit });
    expect(tr!.logArtifactId).toBeTruthy(); // the run_tests log over MCP is the evidence
    const qa = await t.s.db.root
      .select()
      .from(session)
      .where(and(eq(session.scopeType, "task"), eq(session.scopeId, id)));
    expect(qa.map((x) => x.stopReason ?? "").sort((x, y) => x.localeCompare(y))).toEqual(["review_requested", "review_submitted", "test_submitted"]);
  });

  test("the harness changes nothing → the task is blocked with its explanation", async () => {
    const id = await newTask("确认超时配置", "[fake:noop]");
    await settle();
    const [row] = await t.s.db.root.select().from(task).where(eq(task.id, id));
    expect(row!.status).toBe("blocked");
    expect(row!.blockedReason).toContain("没有改动");
    expect((await turnsOf(id)).ses.stopReason).toBe("no_changes");
  });

  test("the harness blocks the task itself over MCP → the platform stops without committing", async () => {
    const id = await newTask("调整超时上限", "[fake:block]");
    await settle();
    const [row] = await t.s.db.root.select().from(task).where(eq(task.id, id));
    expect(row!.status).toBe("blocked");
    expect(row!.blockedReason).toContain("矛盾");
    const [ws] = await t.s.db.root.select().from(workspace).where(eq(workspace.taskId, id));
    expect(ws!.mrRef).toBeNull();
    expect((await turnsOf(id)).ses.stopReason).toBe("task_blocked");
  });

  test("MCP refuses anything but a live harness session token", async () => {
    const rpc = (headers: Record<string, string>) =>
      t.app.handle(
        new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }),
      );
    expect(((await (await rpc({ authorization: `Bearer ${owner}` })).json()) as { error?: unknown }).error).toBeDefined();
    const [ses] = await t.s.db.root.select().from(session).where(eq(session.agentId, devId)).limit(1);
    const dev = (await t.s.db.root.select().from(agent).where(eq(agent.id, devId)))[0]!;
    const tok = t.s.runtime.harnessToken(dev, ses!.id, 60);
    // The session exists but no harness is running in it now.
    const r = (await (await rpc({ authorization: `Bearer ${tok}` })).json()) as { error?: { message: string } };
    expect(r.error?.message).toContain("没有正在运行的执行引擎");
    expect((await t.app.handle(new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).status).toBe(401);
  });
});
