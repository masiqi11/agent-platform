import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Ctx } from "../../core/context";
import { DomainError } from "../../core/errors";
import { log } from "../../core/logger";
import type { Config } from "../../config";
import type { Database } from "../../db";
import { agent, session, workspace } from "../../db/schema";
import type { Llm } from "../llm/service";
import type { Runtime, TurnState } from "../runtime/service";
import type { Sandbox } from "../sandbox/service";
import { finalText, parseLine, prepare, type Engine, type HarnessEvent, type HarnessRole } from "./adapters";

type AgentRow = typeof agent.$inferSelect;

/**
 * Platform tools a harness may call over MCP, per role (ADR-0010). Git, MR and review requests are
 * not here: the platform drives them around the harness. Intersected with the agent's effective tools.
 */
export const HARNESS_MCP_TOOLS: Record<HarnessRole, readonly string[]> = {
  dev: ["get_task", "add_task_comment", "block_task", "search_knowledge", "ask_project_captain"],
  reviewer: ["get_task", "get_diff", "submit_review", "add_task_comment", "search_knowledge"],
  tester: ["get_task", "run_tests", "submit_test_result", "add_task_comment", "search_knowledge"],
};

/** Run context kept on the session (not in memory): an MCP call may reach another process. */
export interface HarnessRunContext {
  engine: Engine;
  role: HarnessRole;
  taskId: string;
  workspaceId?: string;
  cwd: string;
  scratch?: Record<string, unknown>;
}

export interface HarnessResult {
  ok: boolean;
  exitCode: number | null;
  killed: boolean;
  events: HarnessEvent[];
  summary: string;
  /** Engine session to continue on the next run (rework). */
  sessionRef: string | null;
  durationMs: number;
  stderrTail: string;
}

const MCP_PROTOCOL = "2025-03-26";

export function createHarness(d: { config: Config; db: Database; sandbox: Sandbox; runtime: Runtime; llm: Llm }) {
  const { db } = d;

  async function setContext(sessionId: string, c: HarnessRunContext | null) {
    await db.root
      .update(session)
      .set({ checkpoint: sql`${session.checkpoint} || ${JSON.stringify({ harness: c })}::jsonb`, updatedAt: new Date() })
      .where(eq(session.id, sessionId));
  }

  /**
   * Runs a harness in a workspace (process sandbox: HOME is `<cwd>/.sandbox-home`, kept out of git).
   * Its JSON events are parsed live and written to the session transcript.
   */
  async function run(o: {
    agent: AgentRow;
    sessionId: string;
    role: HarnessRole;
    cwd: string;
    taskId: string;
    workspaceId?: string;
    prompt: string;
    resume?: string | null;
    timeoutMs: number;
    maxTurns?: number;
    scratch?: Record<string, unknown>;
  }): Promise<HarnessResult> {
    const engine = o.agent.engine as Engine;
    if (d.sandbox.kind !== "process")
      // The docker sandbox has no network yet (egress allowlist is S8); a harness must reach the platform.
      throw new DomainError("conflict", "外部执行引擎需要能访问平台的沙箱网络：docker 沙箱的出口白名单在 S8 实现，目前请使用 process 沙箱");
    const effective = new Set(d.runtime.effectiveTools(o.agent));
    const mcpTools = HARNESS_MCP_TOOLS[o.role].filter((t) => effective.has(t));
    const model = o.agent.modelPolicy.primary ?? (await d.llm.defaultModelName(o.agent.tenantId));
    const prep = prepare({
      engine,
      role: o.role,
      prompt: o.prompt,
      model,
      platformUrl: d.config.harness.platformUrl,
      mcpTools,
      maxTurns: o.maxTurns ?? 60,
      resume: o.resume,
      bin: d.config.harness.bins[engine],
      reasoning: o.agent.modelPolicy.reasoning,
    });
    const home = join(o.cwd, ".sandbox-home");
    for (const [rel, content] of Object.entries(prep.files)) {
      await mkdir(dirname(join(home, rel)), { recursive: true });
      await Bun.write(join(home, rel), content);
    }
    await mkdir(d.config.harness.cacheDir, { recursive: true });
    const env: Record<string, string> = { ...d.config.harness.passEnv, XDG_CACHE_HOME: d.config.harness.cacheDir };
    for (const [k, v] of Object.entries(prep.env)) env[k] = v.replaceAll("$HOME", home);
    const token = d.runtime.harnessToken(o.agent, o.sessionId, Math.ceil(o.timeoutMs / 1000) + 300);
    const sessionEnv: Record<string, string> = { PLATFORM_LLM_TOKEN: token, ...(engine === "claude-code" ? { ANTHROPIC_API_KEY: token } : {}) };
    await setContext(o.sessionId, { engine, role: o.role, taskId: o.taskId, workspaceId: o.workspaceId, cwd: o.cwd, scratch: o.scratch });

    const events: HarnessEvent[] = [];
    let buf = "";
    let pending = Promise.resolve();
    const record = (e: HarnessEvent) => {
      events.push(e);
      // Transcript: one turn per text / tool call / tool result (session and final are summarized at the end).
      const turn =
        e.kind === "text"
          ? { role: "assistant", content: e.text }
          : e.kind === "tool"
            ? { role: "assistant", content: "", toolCalls: [{ mode: "harness" }, { name: e.name, arguments: (e.input ?? {}) as Record<string, unknown> }] }
            : e.kind === "tool_result"
              ? { role: "tool", content: JSON.stringify({ ok: e.ok, output: e.output ?? "" }).slice(0, 4000), toolCalls: [{ name: e.name ?? "" }] }
              : e.kind === "error"
                ? { role: "error", content: e.message }
                : null;
      if (turn) pending = pending.then(() => d.runtime.recordTurn(o.sessionId, turn)).catch((err) => log.warn("harness.record_failed", { err: (err as Error).message }));
    };
    const onStdout = (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        for (const e of parseLine(engine, line)) record(e);
      }
      void d.runtime.heartbeat(o.sessionId).catch(() => undefined);
    };
    const r = await d.sandbox.exec({ cwd: o.cwd, cmd: prep.cmd, env, sessionEnv, timeoutMs: o.timeoutMs, onStdout });
    for (const e of parseLine(engine, buf.trim())) record(e);
    await pending;
    await setContext(o.sessionId, null);
    const sessionRef = events.findLast((e) => e.kind === "session");
    const failed = r.killed !== null || r.code !== 0 || events.some((e) => e.kind === "error");
    return {
      ok: !failed,
      exitCode: r.code,
      killed: r.killed !== null,
      events,
      summary: finalText(events),
      sessionRef: sessionRef && sessionRef.kind === "session" ? sessionRef.id : null,
      durationMs: r.durationMs,
      stderrTail: r.stderr.slice(-2000),
    };
  }

  /* ───────────── platform MCP endpoint (streamable HTTP, JSON responses) ───────────── */

  async function turnStateFor(ctx: Ctx): Promise<{ st: TurnState; role: HarnessRole; c: HarnessRunContext } | { error: string }> {
    if (ctx.actor.kind !== "agent" || !ctx.actor.sessionId || !ctx.actor.agentId) return { error: "只接受 Agent 会话令牌" };
    const [ses] = await db.root.select().from(session).where(eq(session.id, ctx.actor.sessionId));
    const c = (ses?.checkpoint as { harness?: HarnessRunContext | null } | undefined)?.harness;
    if (!ses || ses.agentId !== ctx.actor.agentId || ses.status !== "running" || !c) return { error: "会话没有正在运行的执行引擎" };
    const [a] = await db.root.select().from(agent).where(eq(agent.id, ses.agentId));
    if (!a || a.status !== "active") return { error: "Agent 未启用" };
    const ws = c.workspaceId ? (await db.root.select().from(workspace).where(eq(workspace.id, c.workspaceId)))[0] : undefined;
    return {
      role: c.role,
      c,
      st: {
        agent: a,
        projectId: a.projectId ?? "",
        sessionId: ses.id,
        windowMessageIds: new Set(),
        windowSeqs: new Set(),
        wakeDepth: 1,
        effects: [],
        taskId: c.taskId,
        workspaceId: ws?.id,
        isTaskAssignee: c.role === "dev",
        cwd: c.cwd,
        scratch: c.scratch ?? {},
      },
    };
  }

  type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
  const reply = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
  const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  async function handleOne(ctx: Ctx, m: Rpc): Promise<object | null> {
    if (m.id === undefined || m.id === null) return null; // notification: no response
    if (m.method === "initialize")
      return reply(m.id, {
        protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : MCP_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "platform", version: "1" },
      });
    if (m.method === "ping") return reply(m.id, {});
    const s = await turnStateFor(ctx);
    if ("error" in s) return fail(m.id, -32001, s.error);
    const allowed = new Set(HARNESS_MCP_TOOLS[s.role]);
    const specs = d.runtime.toolSpecs(s.st.agent).filter((t) => allowed.has(t.name));
    if (m.method === "tools/list") return reply(m.id, { tools: specs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
    if (m.method === "tools/call") {
      const name = typeof m.params?.name === "string" ? m.params.name : "";
      if (!specs.some((t) => t.name === name)) return reply(m.id, { content: [{ type: "text", text: `工具 ${name} 不可用` }], isError: true });
      const before = JSON.stringify(s.st.scratch ?? {});
      const out = await d.runtime.invokeTool(ctx, s.st, { name, arguments: (m.params?.arguments ?? {}) as Record<string, unknown> });
      // Tool state (e.g. the tester's last test log, cited by its conclusion) outlives this one call.
      if (JSON.stringify(s.st.scratch ?? {}) !== before) await setContext(s.st.sessionId, { ...s.c, scratch: s.st.scratch });
      await d.runtime.recordTurn(s.st.sessionId, { role: "tool", content: JSON.stringify(out).slice(0, 4000), toolCalls: [{ name, arguments: m.params?.arguments ?? {} }] });
      return reply(m.id, { content: [{ type: "text", text: JSON.stringify(out.ok ? out.result : { error: out.error }) }], isError: !out.ok });
    }
    return fail(m.id, -32601, `未知方法 ${m.method}`);
  }

  /** One MCP POST (a message or a batch). Returns null when there is nothing to send back (202). */
  async function mcp(ctx: Ctx, body: unknown): Promise<object | null> {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleOne(ctx, m as Rpc)))).filter(Boolean);
      return out.length ? out : null;
    }
    return handleOne(ctx, body as Rpc);
  }

  return { run, mcp, HARNESS_MCP_TOOLS };
}
export type Harness = ReturnType<typeof createHarness>;
