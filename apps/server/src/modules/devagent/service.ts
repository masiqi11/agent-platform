import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { asText, estimateTokens, type ContextPackage, type DomainEvent, type ParsedToolCall } from "@ap/shared";
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { Audit } from "../../core/audit";
import type { Ctx } from "../../core/context";
import { DomainError, forbidden, invalid, notFound } from "../../core/errors";
import type { Consumer, Events } from "../../core/events";
import { JobAborted, RetryLater, type createJobs } from "../../core/jobs";
import { log } from "../../core/logger";
import type { Config } from "../../config";
import type { Database } from "../../db";
import { agent, llmCall, project, review, session, task, testRun, workspace } from "../../db/schema";
import type { Identity } from "../identity/service";
import { BudgetExceeded, LlmUnavailable, dropOldestStep, type ChatMsg, type Llm } from "../llm/service";
import type { Repos } from "../repos/service";
import { LEASE_MS, type Runtime, type TurnState } from "../runtime/service";
import { resolveInWorkspace } from "../sandbox/service";
import { git } from "../scm/service";
import type { Tasks } from "../tasks/service";
import type { Harness } from "../harness/service";
import { SecretDetected, type Workspaces } from "../workspaces/service";
import { DEV_INSTRUCTIONS, DEV_PROMPTS } from "./prompts";

type Jobs = ReturnType<typeof createJobs>;
type AgentRow = typeof agent.$inferSelect;
type TaskRow = typeof task.$inferSelect;
type SessionRow = typeof session.$inferSelect;

export type DevWakeKind = "task_assigned" | "ci_completed" | "changes_requested" | "test_failed" | "handback";

/** AGT-补1 defaults: per-turn step cap, identical-call loop threshold, wall clock. */
export const DEV_MAX_STEPS = 24;
export const LOOP_REPEAT = 3;
export const DEV_WALL_MS = 20 * 60_000;
const READ_CAP = 60_000;
const OUT_TAIL = 6_000;

export interface DevCheckpoint {
  phase?: string;
  head?: string;
  pushedSha?: string | null;
  mr?: string | null;
  next?: string;
  /** External engine (ADR-0010): its session to continue on rework, and its last summary. */
  harnessSession?: string | null;
  harnessSummary?: string;
  /** Short log of side-effect steps across wakes (SES-补3). */
  log?: Array<{ at: string; tool: string; ok: boolean; note?: string }>;
}

/**
 * Dev agent runtime (§12.10 task sessions, FR-AGT, AGT-补1/3/4, SES-补2/3, TRAP-5). Sessions are
 * DB records: a wake = one job; a turn runs tools until the model stops, a tool ends the turn
 * (CI pending, review requested, blocked), or a limit trips. Non-replayable steps are idempotent
 * (push of the same head, MR reuse, status checks), so a crashed turn can be re-run safely.
 */
export function createDevAgent(d: {
  config: Config;
  db: Database;
  audit: Audit;
  events: Events;
  jobs: Jobs;
  identity: Identity;
  tasks: Tasks;
  repos: Repos;
  workspaces: Workspaces;
  llm: Llm;
  runtime: Runtime;
  harness?: Harness;
}) {
  const { db } = d;
  /** Test hook: throw after a tool to simulate a worker crash mid-turn. */
  const hooks: { afterTool?: (name: string) => void } = {};

  const loadTask = async (id: string) => (await db.root.select().from(task).where(eq(task.id, id)))[0] ?? null;
  const loadAgent = async (id: string) => (await db.root.select().from(agent).where(eq(agent.id, id)))[0] ?? null;

  /* ───────────── wakes (TRAP-5) ───────────── */

  async function wake(e: DomainEvent, t: TaskRow, agentId: string, kind: DevWakeKind, dedupeKey: string) {
    const a = await loadAgent(agentId);
    if (!a || a.role !== "dev" || a.status !== "active" || t.takenOverBy) return null;
    const sys = await d.identity.systemCtx(e.tenantId, e.traceId);
    return db.tx(async () => {
      const id = await d.jobs.enqueue(
        "dev.turn",
        { tenantId: e.tenantId, taskId: t.id, agentId, kind },
        { tenantId: e.tenantId, dedupeKey, concurrencyKey: `devtask:${t.id}`, traceId: e.traceId, maxAttempts: 3 },
      );
      // One wake.requested per real enqueue: duplicates of the same wake are absorbed by the dedupe key.
      if (id) await d.events.emit(sys, { type: "wake.requested", aggregateType: "task", aggregateId: t.id, payload: { projectId: t.projectId, taskId: t.id, agentId, kind, jobId: id } });
      return id;
    });
  }

  const consumer: Consumer = {
    name: "devagent",
    types: ["task.assigned", "task.status_changed", "pipeline.completed", "task.takeover"],
    async handle(e) {
      const p = e.payload as { taskId?: string; agentId?: string | null; previousAgentId?: string | null; to?: string; from?: string; status?: string; sha?: string; back?: boolean };
      if (!p.taskId) return;
      const t = await loadTask(p.taskId);
      if (!t || !t.assigneeAgentId) return;
      if (await d.runtime.paused(e.tenantId)) return;
      if (e.type === "task.assigned") {
        // Reassignment mid-flight (TSK-补3): end the previous agent's session; the new one starts from the brief + workspace.
        if (p.previousAgentId && p.previousAgentId !== t.assigneeAgentId) await endSessions(e.tenantId, t.id, "reassigned", p.previousAgentId);
        // Wake only while the task is ready (not yet started) or already running under the new agent.
        // "Created with an assignee" emits created+assigned(+ready): only this rule fires, once (TRAP-5).
        if (t.status === "ready" || (t.status === "in_progress" && p.previousAgentId)) await wake(e, t, t.assigneeAgentId, "task_assigned", `devwake:${t.id}:${t.assigneeAgentId}`);
      } else if (e.type === "task.status_changed") {
        // Only while still ready: a redelivered/late "ready" after the agent started never re-wakes (TRAP-5).
        if (p.to === "ready" && t.status === "ready") await wake(e, t, t.assigneeAgentId, "task_assigned", `devwake:${t.id}:${t.assigneeAgentId}`);
        else if (p.from === "in_review" && p.to === "in_progress") await wake(e, t, t.assigneeAgentId, "changes_requested", `devrework:${t.id}:${e.seq}`);
        else if (p.from === "testing" && p.to === "in_progress") await wake(e, t, t.assigneeAgentId, "test_failed", `devrework:${t.id}:${e.seq}`);
        else if (p.to === "cancelled") await endSessions(e.tenantId, t.id, "task_cancelled");
      } else if (e.type === "pipeline.completed") {
        if (t.status === "in_progress") await wake(e, t, t.assigneeAgentId, "ci_completed", `devci:${t.id}:${p.sha}:${p.status}`);
      } else if (e.type === "task.takeover") {
        if (p.back) await wake(e, t, t.assigneeAgentId, "handback", `devwake:${t.id}:${t.assigneeAgentId}`);
        else await endSessions(e.tenantId, t.id, "taken_over");
      }
    },
  };

  /** Ends live task sessions (cancel / takeover / reassignment). A running loop notices on its next step. */
  async function endSessions(tenantId: string, taskId: string, reason: string, agentId?: string) {
    const rows = await db.root
      .update(session)
      .set({ status: "completed", stopReason: reason, leaseOwner: null, updatedAt: new Date() })
      .where(
        and(
          eq(session.tenantId, tenantId),
          eq(session.scopeType, "task"),
          eq(session.scopeId, taskId),
          inArray(session.status, ["idle", "queued", "running", "suspended", "interrupted"]),
          ...(agentId ? [eq(session.agentId, agentId)] : []),
        ),
      )
      .returning({ id: session.id, projectId: session.projectId });
    if (rows.length) {
      const sys = await d.identity.systemCtx(tenantId);
      for (const r of rows) await d.events.emit(sys, { type: "session.cancelled", aggregateType: "session", aggregateId: r.id, payload: { sessionId: r.id, projectId: r.projectId, taskId, reason } });
    }
    return rows.length;
  }

  /* ───────────── tools ───────────── */

  async function wsOf(st: TurnState) {
    if (!st.workspaceId) throw new DomainError("conflict", "工作区未就绪");
    const ws = await d.workspaces.load(st.workspaceId);
    if (ws.status !== "ready" || !ws.worktreePath) throw new DomainError("conflict", "工作区不可用");
    return ws;
  }
  /** Read-only tools work in the agent's own checkout when it has one (reviewer / tester, §12.7). */
  async function rootOf(st: TurnState) {
    if (st.cwd) return st.cwd;
    return (await wsOf(st)).worktreePath!;
  }
  async function taskOf(st: TurnState) {
    const t = await loadTask(st.taskId!);
    if (!t) throw notFound("任务");
    if (t.assigneeAgentId !== st.agent.id) throw forbidden("负责 Agent", "你不再是该任务的负责 Agent");
    return t;
  }
  const cp = async (st: TurnState, patch: DevCheckpoint) => {
    const [s] = await db.root.select({ c: session.checkpoint }).from(session).where(eq(session.id, st.sessionId));
    const cur = (s?.c ?? {}) as DevCheckpoint;
    const logEntries = [...(cur.log ?? []), ...(patch.log ?? [])].slice(-30);
    await db.root
      .update(session)
      .set({ checkpoint: { ...cur, ...patch, log: logEntries } as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(session.id, st.sessionId));
  };
  const str = (v: unknown, name: string, max = 2000) => {
    if (typeof v !== "string" || !v.trim()) throw invalid(`缺少参数 ${name}`, [{ path: `/${name}`, message: "必填" }]);
    return v.slice(0, max);
  };
  const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
  const S = { type: "string" };

  d.runtime.registerTool("get_task", {
    spec: { name: "get_task", description: "读取当前任务（标题、描述、验收标准、状态）", parameters: obj({}) },
    async run(_ctx, _args, st) {
      const t = await loadTask(st.taskId!);
      return t ? { title: t.title, description: t.description, status: t.status, acceptanceCriteria: t.acceptanceCriteria.map((c) => c.text) } : null;
    },
  });
  d.runtime.registerTool("list_files", {
    spec: { name: "list_files", description: "列出工作区目录下的文件（相对路径）", parameters: obj({ path: S }) },
    async run(_ctx, args, st) {
      const root = await rootOf(st);
      const dir = resolveInWorkspace(root, typeof args.path === "string" && args.path ? args.path : ".");
      const out: string[] = [];
      const walk = async (p: string, depth: number) => {
        for (const e of await readdir(p, { withFileTypes: true })) {
          if (e.name === ".git" || e.name === "node_modules" || e.name === ".sandbox-home") continue;
          const q = join(p, e.name);
          if (e.isDirectory() && depth < 4) await walk(q, depth + 1);
          else if (e.isFile()) out.push(relative(root, q));
          if (out.length >= 500) return;
        }
      };
      await walk(dir, 0);
      return { files: out };
    },
  });
  d.runtime.registerTool("read_file", {
    spec: { name: "read_file", description: "读取工作区内的文件", parameters: obj({ path: S }, ["path"]) },
    async run(_ctx, args, st) {
      const root = await rootOf(st);
      const rel = str(args.path, "path", 500);
      const p = resolveInWorkspace(root, rel);
      const s = await stat(p).catch(() => null);
      if (!s?.isFile()) throw new DomainError("not_found", `文件不存在：${rel}`);
      const content = (await readFile(p, "utf8")).slice(0, READ_CAP);
      return { path: relative(root, p), content, truncated: s.size > READ_CAP };
    },
  });
  d.runtime.registerTool("write_file", {
    action: "task.start",
    spec: { name: "write_file", description: "整文件写入（创建或覆盖）工作区内的文件", parameters: obj({ path: S, content: S }, ["path", "content"]) },
    async run(_ctx, args, st) {
      const ws = await wsOf(st);
      const rel = str(args.path, "path", 500);
      if (typeof args.content !== "string") throw invalid("缺少参数 content", [{ path: "/content", message: "必填" }]);
      if (args.content.length > 500_000) throw new DomainError("too_large", "文件过大");
      const p = resolveInWorkspace(ws.worktreePath!, rel);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, args.content);
      return { path: relative(ws.worktreePath!, p), bytes: Buffer.byteLength(args.content) };
    },
  });
  d.runtime.registerTool("search_code", {
    spec: { name: "search_code", description: "在工作区代码中搜索（git grep，固定字符串）", parameters: obj({ pattern: S }, ["pattern"]) },
    async run(_ctx, args, st) {
      const r = await git(["grep", "-n", "-I", "-F", "--", str(args.pattern, "pattern", 200)], { cwd: await rootOf(st), allowFail: true });
      const matches = r.out.split("\n").filter(Boolean).slice(0, 50);
      return { matches };
    },
  });
  d.runtime.registerTool("run_command", {
    action: "task.start",
    spec: { name: "run_command", description: "在沙箱里、工作区目录下执行命令（无网络、无凭据）", parameters: obj({ command: S }, ["command"]) },
    async run(_ctx, args, st) {
      const ws = await wsOf(st);
      const r = await d.workspaces.exec(ws, str(args.command, "command", 2000));
      const out = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`;
      return { exitCode: r.code, killed: r.killed, durationMs: r.durationMs, output: out.length > OUT_TAIL ? `…${out.slice(-OUT_TAIL)}` : out };
    },
  });
  d.runtime.registerTool("commit", {
    action: "task.start",
    spec: { name: "commit", description: "提交工作区的全部改动（作者为你自己）", parameters: obj({ message: S }, ["message"]) },
    async run(ctx, args, st) {
      const ws = await wsOf(st);
      const t = await taskOf(st);
      const r = await d.workspaces.commit(ctx, ws, st.agent, t, str(args.message, "message"));
      if (!r) return { committed: false, note: "没有改动可提交" };
      await cp(st, { head: r.sha, phase: "committed", next: "push", log: [{ at: new Date().toISOString(), tool: "commit", ok: true, note: r.sha.slice(0, 8) }] });
      return { committed: true, sha: r.sha, files: r.files, humanReviewRequired: Boolean(r.stat.humanReviewRequired) };
    },
  });
  d.runtime.registerTool("push", {
    action: "task.start",
    spec: { name: "push", description: "推送任务分支（只能是任务分支）", parameters: obj({}) },
    async run(ctx, _args, st) {
      const ws = await wsOf(st);
      const t = await taskOf(st);
      try {
        const r = await d.workspaces.push(ctx, ws, t);
        await cp(st, {
          pushedSha: r.sha,
          phase: "pushed",
          next: ws.mrRef ? "wait_ci" : "open_mr",
          log: [{ at: new Date().toISOString(), tool: "push", ok: true, note: `${r.sha.slice(0, 8)}${r.pushed ? "" : "（已是最新）"}` }],
        });
        if (ws.mrRef) st.stop = "waiting_ci";
        return { pushed: r.pushed, sha: r.sha, branch: r.branch, humanReviewRequired: Boolean(r.stat.humanReviewRequired), reasons: r.stat.reasons ?? [] };
      } catch (e) {
        if (e instanceof SecretDetected) {
          // GIT-补8: block the task; the push never happened.
          await d.tasks.transition(ctx, t.id, "blocked", { reason: "推送前密钥扫描命中：改动中疑似包含密钥", needs: "人类 owner 检查并清理" }).catch(() => undefined);
          st.stop = "blocked_secret";
        }
        throw e;
      }
    },
  });
  d.runtime.registerTool("open_merge_request", {
    action: "task.submit_review",
    spec: { name: "open_merge_request", description: "为任务分支创建 MR（已存在则复用）", parameters: obj({ title: S }) },
    async run(ctx, args, st) {
      const ws = await wsOf(st);
      const t = await taskOf(st);
      const mr = await d.workspaces.openMr(ctx, ws, t, typeof args.title === "string" && args.title.trim() ? args.title : undefined);
      await cp(st, { mr: mr.ref, phase: "mr_opened", next: "wait_ci", log: [{ at: new Date().toISOString(), tool: "open_merge_request", ok: true, note: `${mr.ref}${mr.reused ? "（复用）" : ""}` }] });
      st.stop = "waiting_ci";
      return { mr: mr.ref, url: mr.url, reused: mr.reused, ci: mr.workspace.ci };
    },
  });
  d.runtime.registerTool("get_pipeline", {
    spec: { name: "get_pipeline", description: "查看当前提交的 CI 状态", parameters: obj({}) },
    async run(_ctx, _args, st) {
      const ws = await wsOf(st);
      return { head: ws.headCommit, ci: ws.ci };
    },
  });
  d.runtime.registerTool("request_review", {
    action: "task.submit_review",
    spec: {
      name: "request_review",
      description: "CI 通过后提交评审：任务进入评审中；附改动说明与测试计划草案",
      parameters: obj({ summary: S, testPlan: { type: "object" } }, ["summary"]),
    },
    async run(ctx, args, st) {
      const t = await taskOf(st);
      const plan = (args.testPlan && typeof args.testPlan === "object" ? args.testPlan : {}) as Record<string, unknown>;
      // REL-补1: the dev attaches a draft test plan; reviewers confirm or extend it.
      await d.tasks.update(ctx, t.id, { testPlan: { ...plan, draftBy: st.agent.id, summary: asText(args.summary).slice(0, 2000) } });
      const r = await d.tasks.transition(ctx, t.id, "in_review", {});
      await cp(st, { phase: "in_review", next: "wait_review", log: [{ at: new Date().toISOString(), tool: "request_review", ok: true }] });
      st.stop = "review_requested";
      return { status: r.status };
    },
  });
  d.runtime.registerTool("block_task", {
    action: "task.start",
    spec: { name: "block_task", description: "任务无法继续时标记阻塞，写明原因和需要谁决策", parameters: obj({ reason: S, needs: S }, ["reason", "needs"]) },
    async run(ctx, args, st) {
      const t = await taskOf(st);
      const r = await d.tasks.transition(ctx, t.id, "blocked", { reason: str(args.reason, "reason", 500), needs: str(args.needs, "needs", 100) });
      await cp(st, { phase: "blocked", log: [{ at: new Date().toISOString(), tool: "block_task", ok: true, note: String(args.reason).slice(0, 80) }] });
      st.stop = "blocked";
      return { status: r.status };
    },
  });
  d.runtime.registerTool("add_task_comment", {
    spec: { name: "add_task_comment", description: "在任务上写评论", parameters: obj({ body: S }, ["body"]) },
    async run(ctx, args, st) {
      return d.tasks.comment(ctx, st.taskId!, str(args.body, "body", 5000));
    },
  });

  /* ───────────── the turn ───────────── */

  async function stateBlock(t: TaskRow, wsId: string, checkpoint: DevCheckpoint) {
    const ws = await d.workspaces.load(wsId);
    const r = (await d.repos.byId(ws.repoId))!;
    const dirty = ws.worktreePath ? Boolean((await git(["status", "--porcelain"], { cwd: ws.worktreePath })).out) : false;
    const head = ws.worktreePath ? (await git(["rev-parse", "HEAD"], { cwd: ws.worktreePath })).out : (ws.headCommit ?? "");
    const ci = ws.ci as { status: string; sha: string } | null;
    return {
      taskStatus: t.status,
      repo: r.name,
      branch: ws.branch,
      base: ws.baseCommit ?? "",
      head,
      dirty,
      pushedSha: checkpoint.pushedSha ?? null,
      mr: ws.mrRef,
      ci: ci ? { status: ci.status, sha: ci.sha } : null,
      testCommand: d.repos.settingsOf(r).testCommand ?? "bun test",
      humanReviewRequired: Boolean(ws.diffStat?.humanReviewRequired),
      // The latest change request, if it is still open (made on the current head): rework input.
      review: await openChangeRequest(t.id, head),
    };
  }

  async function openChangeRequest(taskId: string, head: string) {
    const [rv] = await db.root.select().from(review).where(eq(review.taskId, taskId)).orderBy(desc(review.createdAt)).limit(1);
    if (!rv || rv.verdict !== "changes_requested" || rv.headSha !== head) return null;
    return { sha: rv.headSha, round: rv.round, comments: rv.comments };
  }

  /** Concurrency cap per agent (AGT-补4): other tasks' running sessions with a live heartbeat. */
  async function busy(a: AgentRow, taskId: string) {
    const [r] = await db.root
      .select({ n: sql<number>`count(*)::int` })
      .from(session)
      .where(
        and(
          eq(session.agentId, a.id),
          eq(session.scopeType, "task"),
          eq(session.status, "running"),
          ne(session.scopeId, taskId),
          sql`${session.heartbeatAt} > now() - make_interval(secs => ${LEASE_MS / 1000})`,
        ),
      );
    return (r?.n ?? 0) >= a.maxConcurrency;
  }

  async function sessionAlive(id: string) {
    const [s] = await db.root.select({ status: session.status, stopReason: session.stopReason }).from(session).where(eq(session.id, id));
    return s && s.status === "running";
  }

  async function turn(p: { tenantId: string; taskId: string; agentId: string; kind: DevWakeKind }, traceId: string, signal?: AbortSignal) {
    const sys = await d.identity.systemCtx(p.tenantId, traceId);
    if (await d.runtime.paused(p.tenantId)) return { skipped: "paused" };
    const a = await loadAgent(p.agentId);
    let t = await loadTask(p.taskId);
    if (!a || !t || a.status !== "active") return { skipped: "inactive" };
    if (t.assigneeAgentId !== a.id || t.takenOverBy) return { skipped: "not_assignee" };
    if (!["ready", "in_progress"].includes(t.status)) return { skipped: `status_${t.status}` };
    const ses = await d.runtime.getOrCreateSession(p.tenantId, a, "task", t.id, null);
    if (await busy(a, t.id)) {
      await db.root.update(session).set({ status: "queued", updatedAt: new Date() }).where(eq(session.id, ses.id));
      throw new RetryLater(15_000, "agent at max concurrency");
    }
    if (!(await d.runtime.lease(ses.id))) throw new RetryLater(5_000, "session leased elsewhere");
    const blocked = await d.llm.budgetBlocked(p.tenantId, { projectId: t.projectId, taskId: t.id });
    if (blocked) return onBudget(sys, a, t, ses, "budget_exceeded");

    const actx = await d.runtime.agentCtx(a, ses.id, traceId);
    const repos = await d.repos.projectRepos(t.projectId);
    const r = repos.find((x) => x.status !== "credential_invalid") ?? repos[0];
    if (!r) {
      await d.tasks.comment(actx, t.id, "项目还没有绑定代码仓库，无法开始开发。请 Maintainer 在「项目设置 → 仓库」绑定仓库后把任务交还给我。").catch(() => undefined);
      await d.runtime.finish(sys, ses, "idle", "no_repo", { steps: 0, tokens: 0, cost: 0 });
      return { skipped: "no_repo" };
    }
    // Step 1 (idempotent): workspace, then ready → in_progress (guard: workspace_ready).
    let ws;
    try {
      ws = await d.workspaces.ensure(actx, t, r);
    } catch (e) {
      log.warn("dev.workspace_failed", { taskId: t.id, err: (e as Error).message.slice(0, 300) });
      await d.runtime.recordTurn(ses.id, { role: "error", content: `工作区创建失败：${(e as Error).message.slice(0, 500)}` });
      await d.runtime.finish(sys, ses, "interrupted", "workspace_failed", { steps: 0, tokens: 0, cost: 0 });
      throw e;
    }
    if (t.status === "ready") {
      await d.tasks.transition(actx, t.id, "in_progress", {});
      t = (await loadTask(t.id))!;
    }
    const [g] = t.groupId ? [t.groupId] : [];
    const st: TurnState = {
      agent: a,
      projectId: t.projectId,
      groupId: g,
      sessionId: ses.id,
      windowMessageIds: new Set(),
      windowSeqs: new Set(),
      wakeDepth: 1,
      effects: [],
      taskId: t.id,
      workspaceId: ws.id,
      isTaskAssignee: true,
    };
    const [sesRow] = await db.root.select().from(session).where(eq(session.id, ses.id));
    const checkpoint = (sesRow?.checkpoint ?? {}) as DevCheckpoint;
    if (a.engine !== "builtin" && d.harness) return harnessTurn({ sys, actx, a, t, ses, wsId: ws.id, st, checkpoint, kind: p.kind, prKey: await projectKey(t.projectId) });
    const modelName = a.modelPolicy.primary ?? (await d.llm.defaultModelName(p.tenantId));
    const mdl = await d.llm.findModel(p.tenantId, modelName);
    const budgets = d.runtime.layerBudgets(mdl?.m.contextWindow ?? 8192, a.modelPolicy.maxTokens ?? 1024);
    const [pr] = await db.root.select({ key: project.key }).from(project).where(eq(project.id, t.projectId));
    const pkg: ContextPackage = {
      policy: {
        tenantId: p.tenantId,
        projectId: t.projectId,
        agentId: a.id,
        permissions: ["task.start", "task.submit_review"],
        budget: { tokens: a.budget.maxTokens ?? 0, costUsd: a.budget.maxCostUsd ?? 0, wallClockMs: a.budget.wallClockMs ?? DEV_WALL_MS },
        toolAllowlist: d.runtime.effectiveTools(a),
      },
      trigger: { kind: p.kind === "ci_completed" || p.kind === "handback" ? "task_assigned" : p.kind, taskId: t.id, actorPrincipalId: sys.actor.principalId },
      task: {
        id: t.id,
        title: `${pr?.key ?? "T"}-${t.number} ${t.title}`,
        description: t.description,
        acceptanceCriteria: t.acceptanceCriteria.map((c) => c.text),
        status: t.status,
        branch: ws.branch,
        issueUrl: t.issueUrl ?? undefined,
        owners: [],
      },
      recentMessages: [],
      knowledge: [],
      memory: [],
    };
    const history = (checkpoint.log ?? []).map((l) => `- ${l.at.slice(11, 19)} ${l.tool}${l.ok ? "" : "（失败）"}${l.note ? `：${l.note}` : ""}`).join("\n");
    const ciNote = p.kind === "ci_completed" && ws.ci ? `CI 结果：${(ws.ci as { status: string }).status}（${String((ws.ci as { sha: string }).sha).slice(0, 8)}）` : "";
    const baseRendered = d.runtime.render(pkg, {
      instructions: `${DEV_INSTRUCTIONS}\n\n${a.instructions}`.trim(),
      notes: [history ? `## 之前的进展（检查点）\n${history}` : "", ciNote, `唤醒原因：${p.kind}`].filter(Boolean),
      budgets,
    });
    pkg.layerTokens = baseRendered.layerTokens;
    await d.runtime.recordTurn(ses.id, { role: "context", content: `触发：${p.kind}`, contextPackage: pkg });

    const t0 = Date.now();
    const wall = a.budget.wallClockMs ?? DEV_WALL_MS;
    const maxSteps = a.budget.maxSteps ?? DEV_MAX_STEPS;
    const convo: ChatMsg[] = [];
    const recent: string[] = [];
    let steps = 0;
    let tokens = 0;
    let cost = 0;
    let stopReason = "turn_complete";
    let usedModel = modelName;
    try {
      while (true) {
        // #8: the job timed out or another worker owns it now — no further side effects from here.
        if (signal?.aborted) throw new JobAborted(`dev.turn aborted: ${String((signal.reason as Error | undefined)?.message ?? "")}`);
        if (steps >= maxSteps) {
          stopReason = "max_steps";
          break;
        }
        if (Date.now() - t0 > wall) {
          stopReason = "wall_clock";
          break;
        }
        if (!(await sessionAlive(ses.id))) {
          stopReason = "cancelled";
          break;
        }
        const fresh = await loadTask(t.id);
        if (!fresh || fresh.assigneeAgentId !== a.id || fresh.takenOverBy || !["in_progress"].includes(fresh.status)) {
          stopReason = `task_${fresh?.status ?? "gone"}`;
          break;
        }
        const state = await stateBlock(fresh, ws.id, ((await db.root.select({ c: session.checkpoint }).from(session).where(eq(session.id, ses.id)))[0]?.c ?? {}) as DevCheckpoint);
        const user = `${baseRendered.messages[1]!.content}\n\n## 工作区状态\n<state>${JSON.stringify(state)}</state>`;
        let res;
        try {
          res = await d.llm.complete(actx, {
            purpose: "dev.turn",
            promptVersion: DEV_PROMPTS.turn,
            scope: { projectId: t.projectId, taskId: t.id, sessionId: ses.id, agentId: a.id },
            messages: [baseRendered.messages[0]!, { role: "user", content: user }, ...convo],
            tools: d.runtime.toolSpecs(a),
            modelPolicy: a.modelPolicy,
            dataClasses: ["code", "task"],
          });
        } catch (e) {
          if (e instanceof BudgetExceeded) return onBudget(sys, a, (await loadTask(t.id))!, ses, "budget_exceeded", { steps, tokens, cost });
          const msg = e instanceof LlmUnavailable ? e.message : "模型调用失败";
          await d.runtime.recordTurn(ses.id, { role: "error", content: msg });
          // LLM-05: the model is unavailable → the task is blocked with that reason, not left spinning.
          await d.tasks.transition(actx, t.id, "blocked", { reason: `模型不可用：${msg.slice(0, 120)}`, needs: "Tenant Admin" }).catch(() => undefined);
          stopReason = "llm_unavailable";
          break;
        }
        steps++;
        tokens += res.tokensIn + res.tokensOut;
        cost += res.cost;
        usedModel = res.model;
        const calls = res.toolCalls.slice(0, 3);
        await d.runtime.recordTurn(ses.id, { role: "assistant", content: res.content, toolCalls: [{ mode: res.toolMode }, ...calls], tokensIn: res.tokensIn, tokensOut: res.tokensOut });
        await d.runtime.heartbeat(ses.id);
        if (!calls.length) {
          stopReason = "model_done";
          break;
        }
        const ided = calls.map((c, i) => ({ id: `call_${steps}_${i}`, name: c.name, arguments: c.arguments }));
        convo.push({ role: "assistant", content: res.content, toolCalls: ided, ...(res.reasoning !== undefined ? { reasoning: res.reasoning } : {}) });
        const answered = new Set<string>();
        for (const [ci, call] of calls.entries()) {
          if (signal?.aborted) throw new JobAborted("dev.turn aborted before a tool call");
          // AGT-补1 loop guard: the same call with the same args N times in a row aborts the turn.
          const sig = `${call.name}:${JSON.stringify(call.arguments)}`;
          recent.push(sig);
          if (recent.length >= LOOP_REPEAT && recent.slice(-LOOP_REPEAT).every((x) => x === sig)) {
            stopReason = "loop_detected";
            break;
          }
          const out = await d.runtime.invokeTool(actx, st, call as ParsedToolCall);
          hooks.afterTool?.(call.name);
          const text = JSON.stringify(out).slice(0, 12_000);
          await d.runtime.recordTurn(ses.id, { role: "tool", content: text.slice(0, 4000), toolCalls: [call] });
          convo.push({ role: "tool", toolCallId: ided[ci]!.id, name: call.name, content: text });
          answered.add(ided[ci]!.id);
          if (st.stop) break;
        }
        // Every call needs a result message, even ones skipped by an early stop.
        for (const c of ided) if (!answered.has(c.id)) convo.push({ role: "tool", toolCallId: c.id, name: c.name, content: '{"ok":false,"error":"未执行"}' });
        if (stopReason === "loop_detected") {
          await d.tasks.comment(actx, t.id, `检测到重复调用同一工具（${recent[recent.length - 1]!.split(":")[0]}），本轮已中止，避免空转。`).catch(() => undefined);
          break;
        }
        // Keep the running transcript inside the model window (oldest whole steps dropped first).
        while (convo.length > 4 && convo.reduce((n, m) => n + estimateTokens(m.content), 0) > budgets.L3 + budgets.L4) dropOldestStep(convo);
        if (st.stop) {
          stopReason = st.stop;
          break;
        }
      }
    } catch (e) {
      // Crash-like failure: leave the lease to expire so recovery resumes from the checkpoint (SES-补2).
      log.warn("dev.turn_crashed", { taskId: t.id, err: (e as Error).message.slice(0, 300) });
      throw e;
    }
    await d.runtime.recordTurn(ses.id, { role: "effects", content: JSON.stringify(st.effects).slice(0, 4000) });
    if (stopReason !== "cancelled" && (await sessionAlive(ses.id))) {
      await d.runtime.finish(sys, ses, stopReason === "loop_detected" || stopReason === "max_steps" || stopReason === "wall_clock" ? "suspended" : "idle", stopReason, {
        steps,
        tokens,
        cost,
        model: usedModel,
      });
      if (["loop_detected", "max_steps", "wall_clock"].includes(stopReason)) {
        const cur = await loadTask(t.id);
        if (cur?.status === "in_progress") await d.tasks.transition(actx, t.id, "blocked", { reason: `Agent 失控保护触发：${stopReason}`, needs: "人类 owner" }).catch(() => undefined);
      }
    } else {
      await db.root
        .update(session)
        .set({ steps: sql`${session.steps} + ${steps}`, tokensUsed: sql`${session.tokensUsed} + ${tokens}`, costUsed: sql`${session.costUsed} + ${cost}` })
        .where(eq(session.id, ses.id));
    }
    return { stopReason, steps, effects: st.effects };
  }

  /* ───────────── external engine (ADR-0010) ───────────── */

  async function projectKey(projectId: string) {
    const [pr] = await db.root.select({ key: project.key }).from(project).where(eq(project.id, projectId));
    return pr?.key ?? "T";
  }

  /** Rework input for the harness: the open change request, or the latest failed test run on this head. */
  async function reworkNotes(t: TaskRow, kind: DevWakeKind, head: string) {
    const out: string[] = [];
    const rv = await openChangeRequest(t.id, head);
    if (rv) out.push(`## 评审意见（第 ${rv.round} 轮，需要修改）\n${rv.comments.map((c) => `- ${c.path ? `${c.path}${c.line ? `:${c.line}` : ""}：` : ""}${c.body}`).join("\n")}`);
    if (kind === "test_failed") {
      const [tr] = await db.root.select().from(testRun).where(eq(testRun.taskId, t.id)).orderBy(desc(testRun.createdAt)).limit(1);
      if (tr && tr.status !== "passed") {
        const bad = tr.criteriaResults.filter((c) => c.verdict !== "met" && c.verdict !== "pass");
        out.push(`## 测试未通过（第 ${tr.attempt} 次）\n${bad.map((c) => `- ${c.text}：${c.verdict}${c.evidence ? `（${c.evidence.slice(0, 300)}）` : ""}`).join("\n") || "- 见任务评论"}`);
      }
    }
    return out;
  }

  function harnessPrompt(t: TaskRow, key: string, a: AgentRow, branch: string, testCommand: string, notes: string[]) {
    return [
      `你是平台上的开发 Agent「${a.name}」，在任务分支 ${branch} 的工作区里完成下面的任务。`,
      `# ${key}-${t.number} ${t.title}`,
      t.description,
      t.acceptanceCriteria.length ? `## 验收标准\n${t.acceptanceCriteria.map((c) => `- ${c.text}`).join("\n")}` : "",
      ...notes,
      [
        "## 规则",
        "- 直接修改工作区里的代码，并运行测试确认通过：" + testCommand,
        "- 不要执行 git commit / push，也不要创建 MR：你结束后由平台提交、推送并开 MR",
        "- 需要任务信息时用 platform 工具 get_task；遇到需要人决定的问题，用 block_task 写明原因后结束",
        "- 结束时用几句话总结改了什么、怎么验证的（会作为改动说明和测试计划草案）",
        a.instructions ? `## 额外要求\n${a.instructions}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /**
   * One wake of a dev agent bound to an external engine. The harness only edits the workspace; the
   * platform drives every side effect through the same tools (and checks) as the built-in loop:
   * commit → push (secret scan) → MR → wait CI → on success request review, on failure rerun.
   */
  async function harnessTurn(o: { sys: Ctx; actx: Ctx; a: AgentRow; t: TaskRow; ses: SessionRow; wsId: string; st: TurnState; checkpoint: DevCheckpoint; kind: DevWakeKind; prKey: string }) {
    const { sys, actx, a, t, ses, st, checkpoint } = o;
    const engine = a.engine;
    const call = (name: string, args: Record<string, unknown> = {}) => d.runtime.invokeTool(actx, st, { name, arguments: args } as ParsedToolCall);
    let runs = 0;
    const done = async (stopReason: string, status: "idle" | "suspended" = "idle") => {
      await d.runtime.recordTurn(ses.id, { role: "effects", content: JSON.stringify(st.effects).slice(0, 4000) });
      if (await sessionAlive(ses.id)) await d.runtime.finish(sys, ses, status, stopReason, { steps: runs, tokens: 0, cost: 0 });
      return { stopReason, steps: runs, effects: st.effects };
    };
    const block = async (reason: string, stop: string) => {
      const cur = await loadTask(t.id);
      if (cur?.status === "in_progress") await d.tasks.transition(actx, t.id, "blocked", { reason: reason.slice(0, 500), needs: "人类 owner" }).catch(() => undefined);
      return done(stop);
    };
    const ws = await d.workspaces.load(o.wsId);
    const ci = ws.ci as { status: string; sha: string; url?: string } | null;
    const notes: string[] = [];
    if (o.kind === "ci_completed") {
      if (!ci || ci.sha !== ws.headCommit) return done("ci_stale");
      if (ci.status === "success") {
        const r = await call("request_review", { summary: checkpoint.harnessSummary || `${engine} 完成了改动，CI 已通过` });
        return r.ok ? done("review_requested") : block(`提交评审失败：${r.error}`, "request_review_failed");
      }
      if (!["failed", "canceled"].includes(ci.status)) return done("waiting_ci");
      notes.push(`## CI 未通过\n提交 ${ci.sha.slice(0, 8)} 的流水线状态为 ${ci.status}${ci.url ? `（${ci.url}）` : ""}。请在本地运行测试找到原因并修复。`);
    }
    const r = (await d.repos.byId(ws.repoId))!;
    const head = (await git(["rev-parse", "HEAD"], { cwd: ws.worktreePath! })).out;
    notes.push(...(await reworkNotes(t, o.kind, head)));
    await d.runtime.recordTurn(ses.id, { role: "context", content: `触发：${o.kind}（执行引擎 ${engine}）` });
    const res = await d.harness!.run({
      agent: a,
      sessionId: ses.id,
      role: "dev",
      cwd: ws.worktreePath!,
      taskId: t.id,
      workspaceId: ws.id,
      prompt: harnessPrompt(t, o.prKey, a, ws.branch, d.repos.settingsOf(r).testCommand ?? "bun test", notes),
      resume: o.kind === "task_assigned" ? null : (checkpoint.harnessSession ?? null),
      timeoutMs: a.budget.wallClockMs ?? DEV_WALL_MS,
      maxTurns: a.budget.maxSteps ? a.budget.maxSteps * 3 : undefined,
    });
    runs = 1;
    await cp(st, {
      harnessSession: res.sessionRef ?? checkpoint.harnessSession ?? null,
      ...(res.summary ? { harnessSummary: res.summary.slice(0, 2000) } : {}),
      log: [{ at: new Date().toISOString(), tool: `harness:${engine}`, ok: res.ok, note: `${Math.round(res.durationMs / 1000)}s${res.killed ? " 超时" : ""}` }],
    });
    if (!(await sessionAlive(ses.id))) return { stopReason: "cancelled", steps: runs, effects: st.effects };
    const fresh = await loadTask(t.id);
    // The harness may have blocked the task itself (block_task over MCP), or a human may have stepped in.
    if (!fresh || fresh.status !== "in_progress" || fresh.assigneeAgentId !== a.id || fresh.takenOverBy) return done(`task_${fresh?.status ?? "gone"}`);
    if (!res.ok) {
      const why = res.killed ? "运行超时" : (res.events.findLast((e) => e.kind === "error") as { message?: string } | undefined)?.message || res.stderrTail.slice(-300) || `退出码 ${res.exitCode}`;
      return block(`执行引擎 ${engine} 运行失败：${why}`, "harness_failed");
    }
    const c = await call("commit", { message: `${o.prKey}-${t.number} ${t.title}\n\n${res.summary.slice(0, 1500)}`.trim() });
    if (!c.ok) return block(`提交失败：${c.error}`, "commit_failed");
    const committed = (c.result as { committed: boolean }).committed;
    const now = await d.workspaces.load(ws.id);
    const pushed = ((await db.root.select({ c: session.checkpoint }).from(session).where(eq(session.id, ses.id)))[0]?.c as DevCheckpoint | undefined)?.pushedSha;
    if (!committed && pushed && pushed === (await git(["rev-parse", "HEAD"], { cwd: now.worktreePath! })).out)
      return block(`执行引擎 ${engine} 结束了，但没有产生新的改动${res.summary ? `。它的说明：${res.summary.slice(0, 300)}` : ""}`, "no_changes");
    if (!committed && !pushed && (await git(["rev-parse", "HEAD"], { cwd: now.worktreePath! })).out === now.baseCommit)
      return block(`执行引擎 ${engine} 结束了，但没有改动任何文件${res.summary ? `。它的说明：${res.summary.slice(0, 300)}` : ""}`, "no_changes");
    const p = await call("push");
    if (!p.ok) return st.stop === "blocked_secret" ? done("blocked_secret") : block(`推送失败：${p.error}`, "push_failed");
    if (!now.mrRef) {
      const m = await call("open_merge_request", { title: `${o.prKey}-${t.number} ${t.title}` });
      if (!m.ok) return block(`创建 MR 失败：${m.error}`, "mr_failed");
    }
    return done("waiting_ci");
  }

  async function onBudget(sys: Ctx, a: AgentRow, t: TaskRow, ses: SessionRow, reason: string, usage = { steps: 0, tokens: 0, cost: 0 }) {
    // OBS-补3 / INV-19: visible stop — task blocked with the reason, not silent.
    if (t.status === "in_progress") {
      const actx = await d.runtime.agentCtx(a, ses.id, sys.traceId);
      await d.tasks.transition(actx, t.id, "blocked", { reason: "预算超限", needs: "Tenant Admin 追加预算" }).catch(() => undefined);
    }
    await d.runtime.finish(sys, ses, "suspended", reason, usage);
    return { skipped: "budget" };
  }

  /* ───────────── human controls (AGT-补3) ───────────── */

  async function takeover(ctx: Ctx, taskId: string, reason: string) {
    const t = await d.tasks.load(ctx, taskId);
    const roles = await d.tasks.rolesFor(ctx, t);
    if (!roles.has("human_owner") && !roles.has("maintainer")) throw forbidden("任务 owner 或 Maintainer");
    if (["done", "cancelled"].includes(t.status)) throw new DomainError("conflict", "任务已结束");
    if (!reason.trim()) throw invalid("接管需要填写原因", [{ path: "/reason", message: "必填" }]);
    await db.tx(async (q) => {
      await q
        .update(task)
        .set({ takenOverBy: ctx.actor.principalId, version: t.version + 1, updatedAt: new Date() })
        .where(eq(task.id, t.id));
      // The person who takes over may not review this task later (AGT-补3, enforced in S6 review).
      await d.events.emit(ctx, { type: "task.takeover", aggregateType: "task", aggregateId: t.id, payload: { projectId: t.projectId, taskId: t.id, by: ctx.actor.principalId, back: false } });
      await d.audit.write(ctx, { action: "task.takeover", resourceType: "task", resourceId: t.id, projectId: t.projectId, after: { reason } });
    });
    await endSessions(ctx.tenantId, t.id, "taken_over");
    return { ok: true as const };
  }
  async function handback(ctx: Ctx, taskId: string) {
    const t = await d.tasks.load(ctx, taskId);
    const roles = await d.tasks.rolesFor(ctx, t);
    if (!roles.has("human_owner") && !roles.has("maintainer")) throw forbidden("任务 owner 或 Maintainer");
    if (!t.takenOverBy) throw new DomainError("conflict", "任务未被接管");
    await db.tx(async (q) => {
      await q
        .update(task)
        .set({ takenOverBy: null, version: t.version + 1, updatedAt: new Date() })
        .where(eq(task.id, t.id));
      await d.events.emit(ctx, { type: "task.takeover", aggregateType: "task", aggregateId: t.id, payload: { projectId: t.projectId, taskId: t.id, by: ctx.actor.principalId, back: true } });
      await d.audit.write(ctx, { action: "task.handback", resourceType: "task", resourceId: t.id, projectId: t.projectId });
    });
    return { ok: true as const };
  }
  async function cancelSession(ctx: Ctx, sessionId: string, reason: string) {
    const [s] = await db.root
      .select()
      .from(session)
      .where(and(eq(session.id, sessionId), eq(session.tenantId, ctx.tenantId)));
    if (!s) throw notFound("会话");
    let allowed = false;
    if (s.scopeType === "task") {
      const t = await d.tasks.load(ctx, s.scopeId);
      const roles = await d.tasks.rolesFor(ctx, t);
      allowed = roles.has("human_owner") || roles.has("maintainer");
    } else allowed = (await d.identity.check(ctx, "agent.manage", { projectId: s.projectId })).allowed;
    if (!allowed) throw forbidden("任务 owner 或 Maintainer");
    if (!["idle", "queued", "running", "suspended", "interrupted"].includes(s.status)) return { ok: true as const };
    await db.tx(async (q) => {
      await q.update(session).set({ status: "completed", stopReason: "cancelled_by_human", leaseOwner: null, updatedAt: new Date() }).where(eq(session.id, s.id));
      await d.events.emit(ctx, {
        type: "session.cancelled",
        aggregateType: "session",
        aggregateId: s.id,
        payload: { sessionId: s.id, projectId: s.projectId, taskId: s.scopeType === "task" ? s.scopeId : null, reason: "cancelled_by_human" },
      });
      await d.audit.write(ctx, { action: "session.cancel", resourceType: "session", resourceId: s.id, projectId: s.projectId, after: { reason } });
    });
    return { ok: true as const };
  }

  /* ───────────── reads ───────────── */

  /** Agent directory load (FR-AGT-08, AGT-补4): running / queued sessions and recent tasks. */
  async function load(ctx: Ctx, projectId: string) {
    await d.identity.projectInTenant(ctx, projectId);
    await d.identity.require(ctx, "project.view", { projectId });
    const agents = await db.root.select({ id: agent.id, max: agent.maxConcurrency }).from(agent).where(eq(agent.projectId, projectId));
    const ids = agents.map((a) => a.id);
    if (!ids.length) return [];
    const ses = await db.root
      .select({ agentId: session.agentId, status: session.status, n: sql<number>`count(*)::int` })
      .from(session)
      .where(and(inArray(session.agentId, ids), eq(session.scopeType, "task"), inArray(session.status, ["running", "queued"])))
      .groupBy(session.agentId, session.status);
    const queuedJobs = await db.root.execute<{ agent_id: string; n: number }>(
      sql`select payload->>'agentId' as agent_id, count(*)::int as n from job where type = 'dev.turn' and status = 'queued' and payload->>'agentId' in ${ids} group by 1`,
    );
    const recent = await db.root
      .select({ id: task.id, agentId: task.assigneeAgentId, number: task.number, title: task.title, status: task.status, updatedAt: task.updatedAt })
      .from(task)
      .where(and(eq(task.projectId, projectId), inArray(task.assigneeAgentId, ids)))
      .orderBy(desc(task.updatedAt))
      .limit(100);
    const [pr] = await db.root.select({ key: project.key }).from(project).where(eq(project.id, projectId));
    const jobRows = (queuedJobs as unknown as { rows: Array<{ agent_id: string; n: number }> }).rows;
    return agents.map((a) => ({
      agentId: a.id,
      maxConcurrency: a.max,
      running: ses.find((s) => s.agentId === a.id && s.status === "running")?.n ?? 0,
      queued: (ses.find((s) => s.agentId === a.id && s.status === "queued")?.n ?? 0) + (jobRows.find((j) => j.agent_id === a.id)?.n ?? 0),
      activeTasks: recent.filter((r) => r.agentId === a.id && !["done", "cancelled", "backlog"].includes(r.status)).length,
      recentTasks: recent
        .filter((r) => r.agentId === a.id)
        .slice(0, 5)
        .map((r) => ({ id: r.id, ref: `${pr?.key ?? "T"}-${r.number}`, title: r.title, status: r.status })),
    }));
  }

  /** Task cost (FR-OBS-03): metered model calls for the task, by agent. */
  async function taskCost(taskId: string) {
    const rows = await db.root
      .select({
        agentId: llmCall.agentId,
        tokens: sql<number>`coalesce(sum(${llmCall.tokensIn} + ${llmCall.tokensOut}), 0)::int`,
        cost: sql<number>`coalesce(sum(${llmCall.cost}), 0)::float`,
        calls: sql<number>`count(*)::int`,
      })
      .from(llmCall)
      .where(eq(llmCall.taskId, taskId))
      .groupBy(llmCall.agentId);
    const sessions = await db.root
      .select({ id: session.id, agentId: session.agentId, status: session.status, stopReason: session.stopReason, steps: session.steps, updatedAt: session.updatedAt })
      .from(session)
      .where(and(eq(session.scopeType, "task"), eq(session.scopeId, taskId)))
      .orderBy(desc(session.updatedAt));
    return {
      tokens: rows.reduce((n, r) => n + r.tokens, 0),
      costUsd: Number(rows.reduce((n, r) => n + r.cost, 0).toFixed(6)),
      calls: rows.reduce((n, r) => n + r.calls, 0),
      sessions: sessions.map((s) => ({ ...s, updatedAt: s.updatedAt.toISOString() })),
    };
  }

  /** Stale running sessions (worker died) → interrupted, so recovery is visible (SES-补2). */
  async function sweep() {
    await db.root
      .update(session)
      .set({ status: "interrupted", updatedAt: new Date() })
      .where(and(eq(session.scopeType, "task"), eq(session.status, "running"), lt(session.heartbeatAt, new Date(Date.now() - LEASE_MS * 2))));
    void workspace;
  }

  return { consumer, turn, takeover, handback, cancelSession, endSessions, load, taskCost, sweep, hooks };
}
export type DevAgent = ReturnType<typeof createDevAgent>;
