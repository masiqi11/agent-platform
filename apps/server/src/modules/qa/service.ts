import { asText, estimateTokens, type DomainEvent, type ParsedToolCall } from "@ap/shared";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Audit } from "../../core/audit";
import type { Ctx } from "../../core/context";
import { DomainError, invalid } from "../../core/errors";
import type { Consumer, Events } from "../../core/events";
import { newId } from "../../core/ids";
import { JobAborted, RetryLater, type createJobs } from "../../core/jobs";
import { agentMaxTokens } from "../llm/service";
import { log, redactValue } from "../../core/logger";
import type { ObjectStore } from "../../core/object-store";
import type { Database } from "../../db";
import { agent, artifact, project, review, session, task, taskComment, testRun } from "../../db/schema";
import type { Harness } from "../harness/service";
import type { Identity } from "../identity/service";
import { BudgetExceeded, LlmUnavailable, type ChatMsg, type Llm } from "../llm/service";
import type { Quality } from "../quality/service";
import type { Repos } from "../repos/service";
import { untrusted, type Runtime, type TurnState } from "../runtime/service";
import type { Sandbox } from "../sandbox/service";
import { git } from "../scm/service";
import type { Tasks } from "../tasks/service";
import type { Workspaces } from "../workspaces/service";
import { QA_PROMPTS, REVIEWER_INSTRUCTIONS, TESTER_INSTRUCTIONS } from "./prompts";

type Jobs = ReturnType<typeof createJobs>;
type TaskRow = typeof task.$inferSelect;
export type QaRole = "reviewer" | "tester";

export const QA_MAX_STEPS = 10;
/** Wall clock for a reviewer / tester running on an external engine. */
export const QA_WALL_MS = 15 * 60_000;
const DIFF_CAP = 12_000;
const OUT_TAIL = 6_000;

/**
 * Reviewer and tester agents (§12.8, S6): woken when a task enters 评审中 / 测试中, each works in
 * its own fresh checkout of the exact head commit (never the dev's workspace), and records a
 * conclusion bound to that commit through the quality service.
 */
export function createQa(d: {
  db: Database;
  audit: Audit;
  events: Events;
  jobs: Jobs;
  identity: Identity;
  tasks: Tasks;
  repos: Repos;
  workspaces: Workspaces;
  quality: Quality;
  llm: Llm;
  runtime: Runtime;
  sandbox: Sandbox;
  objectStore: ObjectStore;
  harness?: Harness;
}) {
  const { db } = d;
  const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
  const S = { type: "string" };

  /* ───────────── wake ───────────── */

  /** Least-loaded active agent of the role in the project; never the task's dev (INV-08). */
  async function pick(t: TaskRow, role: QaRole) {
    const rows = await db.root
      .select({ a: agent, n: sql<number>`(select count(*)::int from session s where s.agent_id = ${agent.id} and s.scope_type = 'task' and s.status in ('running','queued'))` })
      .from(agent)
      .where(and(eq(agent.projectId, t.projectId), eq(agent.role, role), eq(agent.status, "active")));
    const ok = rows.filter((r) => r.a.id !== t.assigneeAgentId);
    ok.sort((x, y) => x.n - y.n || x.a.createdAt.getTime() - y.a.createdAt.getTime());
    return ok[0]?.a ?? null;
  }

  async function noAgentNotice(t: TaskRow, role: QaRole) {
    const sys = await d.identity.systemCtx(t.tenantId);
    const body = role === "reviewer" ? "项目没有可用的评审 Agent：请人类评审人或 Maintainer 在任务详情中评审。" : "项目没有可用的测试 Agent：请 Maintainer 安排测试。";
    const [dup] = await db.root
      .select({ id: taskComment.id })
      .from(taskComment)
      .where(and(eq(taskComment.taskId, t.id), eq(taskComment.body, body)));
    if (!dup) await d.tasks.comment(sys, t.id, body).catch(() => undefined);
  }

  const consumer: Consumer = {
    name: "qa",
    types: ["task.status_changed"],
    async handle(e: DomainEvent) {
      const p = e.payload as { taskId?: string; to?: string };
      if (!p.taskId || (p.to !== "in_review" && p.to !== "testing")) return;
      if (await d.runtime.paused(e.tenantId)) return;
      const [t] = await db.root.select().from(task).where(eq(task.id, p.taskId));
      if (!t || t.status !== p.to) return;
      const role: QaRole = p.to === "in_review" ? "reviewer" : "tester";
      const a = await pick(t, role);
      if (!a) return noAgentNotice(t, role);
      const ws = await d.quality.headOf(t.id);
      const sys = await d.identity.systemCtx(e.tenantId, e.traceId);
      await db.tx(async () => {
        const id = await d.jobs.enqueue(
          "qa.turn",
          { tenantId: e.tenantId, taskId: t.id, agentId: a.id, role, headSha: ws?.headCommit ?? null },
          { tenantId: e.tenantId, dedupeKey: `qa:${role}:${t.id}:${ws?.headCommit ?? ""}:${e.seq}`, concurrencyKey: `qa:${t.id}`, traceId: e.traceId, maxAttempts: 3 },
        );
        if (id)
          await d.events.emit(sys, {
            type: "wake.requested",
            aggregateType: "task",
            aggregateId: t.id,
            payload: { projectId: t.projectId, taskId: t.id, agentId: a.id, kind: role === "reviewer" ? "review_requested" : "test_requested", jobId: id },
          });
      });
    },
  };

  /* ───────────── tools ───────────── */

  async function diffOf(st: TurnState) {
    const ws = await d.quality.headOf(st.taskId!);
    if (!ws?.baseCommit || !st.cwd) return { diff: "", files: [] as string[] };
    const diff = (await git(["diff", `${ws.baseCommit}..HEAD`], { cwd: st.cwd })).out;
    const files = (await git(["diff", "--name-only", `${ws.baseCommit}..HEAD`], { cwd: st.cwd })).out.split("\n").filter(Boolean);
    return { diff: diff.length > DIFF_CAP ? `${diff.slice(0, DIFF_CAP)}\n…（已截断）` : diff, files };
  }

  /** Runs a command in the sandbox inside the tester's checkout; full log stored as evidence. */
  async function runTests(t: TaskRow, st: TurnState, command: string, by: string) {
    const r = await d.quality.headOf(t.id);
    const repo = r ? await d.repos.byId(r.repoId) : null;
    const res = await d.sandbox.exec({ cwd: st.cwd!, cmd: command, image: repo ? d.repos.settingsOf(repo).image : undefined });
    const logText = redactValue(`$ ${command}\n${res.log}${res.killed ? `\n[killed: ${res.killed}]` : ""}\n[exit ${res.code}] ${res.durationMs} ms (${res.sandbox})`);
    const o = await d.objectStore.put(`tests/${t.tenantId}/${t.id}/${newId("log")}.log`, logText);
    const id = newId("art");
    await db.root.insert(artifact).values({
      id,
      tenantId: t.tenantId,
      taskId: t.id,
      sessionId: st.sessionId,
      kind: "log",
      name: `测试 ${String(r?.headCommit ?? "").slice(0, 8)}.log`,
      uri: o.uri,
      sha256: o.sha256,
      size: o.size,
      createdBy: by,
    });
    st.scratch = { ...st.scratch, lastLogArtifactId: id, lastExit: res.code, lastDurationMs: res.durationMs };
    const out = `${res.stdout}${res.stderr ? `\n[stderr]\n${res.stderr}` : ""}`;
    return { exitCode: res.code, killed: res.killed, durationMs: res.durationMs, logArtifactId: id, output: out.length > OUT_TAIL ? `…${out.slice(-OUT_TAIL)}` : out };
  }

  d.runtime.registerTool("get_diff", {
    spec: { name: "get_diff", description: "查看本任务相对基线的完整改动（unified diff）", parameters: obj({}) },
    async run(_ctx, _args, st) {
      return diffOf(st);
    },
  });
  d.runtime.registerTool("submit_review", {
    action: "review.approve",
    spec: {
      name: "submit_review",
      description: "提交评审结论（绑定当前提交）。要求修改时给出逐条意见；通过时可确认/补充测试计划",
      parameters: obj(
        {
          verdict: { type: "string", enum: ["approved", "changes_requested"] },
          summary: S,
          comments: { type: "array", items: obj({ path: S, line: { type: "number" }, body: S }, ["body"]) },
          criteria: {
            type: "object",
            description: "逐条验收标准结论：键是验收标准 id（如 ac1），值只能是 met / unmet / na；理由写进 summary",
            additionalProperties: { type: "string", enum: ["met", "unmet", "na"] },
          },
          testPlan: obj({ cases: { type: "array", items: S }, confirmedNote: S }),
        },
        ["verdict", "summary"],
      ),
    },
    async run(ctx, args, st) {
      const verdict = args.verdict === "approved" ? "approved" : args.verdict === "changes_requested" ? "changes_requested" : null;
      if (!verdict) throw invalid("verdict 只能是 approved 或 changes_requested", [{ path: "/verdict", message: "无效" }]);
      const comments = Array.isArray(args.comments)
        ? (args.comments as Array<Record<string, unknown>>)
            .map((c) => ({ path: asText(c.path) || undefined, line: typeof c.line === "number" ? c.line : undefined, body: asText(c.body) }))
            .filter((c) => c.body)
        : [];
      const r = await d.quality.submitReview(ctx, st.taskId!, {
        verdict,
        summary: asText(args.summary),
        comments,
        // Only `id → met|unmet|na` pairs count; anything richer is ignored rather than guessed at.
        criteria: Object.fromEntries(
          Object.entries(args.criteria && typeof args.criteria === "object" ? (args.criteria as Record<string, unknown>) : {}).filter(([, v]) => v === "met" || v === "unmet" || v === "na"),
        ) as Record<string, "met" | "unmet" | "na">,
        testPlan: (args.testPlan && typeof args.testPlan === "object" ? args.testPlan : undefined) as Record<string, unknown> | undefined,
      });
      st.stop = "review_submitted";
      return r;
    },
  });
  d.runtime.registerTool("run_tests", {
    action: "test.run",
    spec: { name: "run_tests", description: "在独立测试环境（沙箱）里执行测试命令；不填则运行仓库测试命令", parameters: obj({ command: S }) },
    async run(ctx, args, st) {
      const t = (await db.root.select().from(task).where(eq(task.id, st.taskId!)))[0]!;
      const cmd = asText(args.command) || asText(st.scratch?.testCommand) || "bun test";
      return runTests(t, st, cmd.slice(0, 2000), ctx.actor.principalId);
    },
  });
  d.runtime.registerTool("submit_test_result", {
    action: "test.run",
    spec: {
      name: "submit_test_result",
      description: "提交测试结论（绑定当前提交），逐条给出验收标准结论与证据",
      parameters: obj(
        {
          status: { type: "string", enum: ["passed", "failed"] },
          summary: S,
          criteriaResults: { type: "array", items: obj({ id: S, verdict: { type: "string", enum: ["met", "unmet", "na"] }, evidence: S }, ["id", "verdict"]) },
        },
        ["status", "criteriaResults"],
      ),
    },
    async run(ctx, args, st) {
      const status = args.status === "passed" ? "passed" : "failed";
      const list = Array.isArray(args.criteriaResults) ? (args.criteriaResults as Array<Record<string, unknown>>) : [];
      const r = await d.quality.submitTest(ctx, st.taskId!, {
        status,
        summary: asText(args.summary),
        criteriaResults: list.map((c) => ({
          id: asText(c.id),
          verdict: (["met", "unmet", "na"].includes(asText(c.verdict)) ? asText(c.verdict) : "unmet") as "met" | "unmet" | "na",
          evidence: asText(c.evidence) || undefined,
        })),
        logArtifactId: (st.scratch?.lastLogArtifactId as string | undefined) ?? null,
        durationMs: (st.scratch?.lastDurationMs as number | undefined) ?? undefined,
      });
      st.stop = "test_submitted";
      return r;
    },
  });

  /** Whether this agent recorded a conclusion on this head since `since` (an engine concludes over MCP). */
  async function concluded(taskId: string, role: QaRole, head: string, principalId: string, since: Date) {
    const rows =
      role === "reviewer"
        ? await db.root
            .select({ id: review.id })
            .from(review)
            .where(and(eq(review.taskId, taskId), eq(review.headSha, head), eq(review.reviewerPrincipalId, principalId), gte(review.createdAt, since)))
        : await db.root
            .select({ id: testRun.id })
            .from(testRun)
            .where(
              and(eq(testRun.taskId, taskId), eq(testRun.headSha, head), eq(testRun.testerPrincipalId, principalId), inArray(testRun.status, ["passed", "failed"]), gte(testRun.createdAt, since)),
            );
    return rows.length > 0;
  }

  /* ───────────── the turn ───────────── */

  async function turn(p: { tenantId: string; taskId: string; agentId: string; role: QaRole; headSha: string | null }, traceId: string, signal?: AbortSignal) {
    const sys = await d.identity.systemCtx(p.tenantId, traceId);
    if (await d.runtime.paused(p.tenantId)) return { skipped: "paused" };
    const [a] = await db.root.select().from(agent).where(eq(agent.id, p.agentId));
    const [t] = await db.root.select().from(task).where(eq(task.id, p.taskId));
    if (!a || !t || a.status !== "active" || a.role !== p.role) return { skipped: "inactive" };
    const want = p.role === "reviewer" ? "in_review" : "testing";
    if (t.status !== want) return { skipped: `status_${t.status}` };
    const ws = await d.quality.headOf(t.id);
    if (!ws?.headCommit || (p.headSha && ws.headCommit !== p.headSha)) return { skipped: "head_moved" };
    const repo = await d.repos.byId(ws.repoId);
    if (!repo) return { skipped: "no_repo" };
    const ses = await d.runtime.getOrCreateSession(p.tenantId, a, "task", t.id, null);
    if (!(await d.runtime.lease(ses.id))) throw new RetryLater(5_000, "session leased elsewhere");
    if (await d.llm.budgetBlocked(p.tenantId, { projectId: t.projectId, taskId: t.id })) {
      await d.runtime.finish(sys, ses, "suspended", "budget_exceeded", { steps: 0, tokens: 0, cost: 0 });
      return { skipped: "budget" };
    }
    const actx = await d.runtime.agentCtx(a, ses.id, traceId);
    let dir = "";
    try {
      dir = await d.workspaces.checkout(t, repo, ws.headCommit, p.role === "reviewer" ? "review" : "test");
    } catch (e) {
      await d.runtime.recordTurn(ses.id, { role: "error", content: `检出失败：${(e as Error).message.slice(0, 300)}` });
      await d.runtime.finish(sys, ses, "interrupted", "checkout_failed", { steps: 0, tokens: 0, cost: 0 });
      throw e;
    }
    const testCommand = d.repos.settingsOf(repo).testCommand ?? "bun test";
    const st: TurnState = {
      agent: a,
      projectId: t.projectId,
      groupId: t.groupId ?? undefined,
      sessionId: ses.id,
      windowMessageIds: new Set(),
      windowSeqs: new Set(),
      wakeDepth: 1,
      effects: [],
      taskId: t.id,
      workspaceId: ws.id,
      isTaskAssignee: false,
      cwd: dir,
      scratch: { testCommand },
    };
    let steps = 0;
    let tokens = 0;
    let cost = 0;
    let stopReason = "turn_complete";
    try {
      const [pr] = await db.root.select({ key: project.key }).from(project).where(eq(project.id, t.projectId));
      const { diff, files } = await diffOf(st);
      const prev = await db.root.select().from(review).where(eq(review.taskId, t.id)).orderBy(desc(review.createdAt)).limit(10);
      // REL-补2: the tester always runs the repo's tests first; the result is evidence either way.
      const auto = p.role === "tester" ? await runTests(t, st, testCommand, actx.actor.principalId) : null;
      const state =
        p.role === "reviewer"
          ? {
              role: "reviewer",
              head: ws.headCommit,
              files,
              criteria: t.acceptanceCriteria.map((c) => ({ id: c.id, text: c.text })),
              testPlan: t.testPlan,
              humanReviewRequired: Boolean(ws.diffStat?.humanReviewRequired),
              previousReviews: prev.map((r) => ({ round: r.round, verdict: r.verdict, headSha: r.headSha, comments: r.comments.length })),
            }
          : { role: "tester", head: ws.headCommit, criteria: t.acceptanceCriteria.map((c) => ({ id: c.id, text: c.text })), testPlan: t.testPlan, autoRun: auto };
      const instructions = `${p.role === "reviewer" ? REVIEWER_INSTRUCTIONS : TESTER_INSTRUCTIONS}\n\n${a.instructions}`.trim();
      const ctxText = [
        `## 任务（L1）\n${untrusted("task", `${pr?.key ?? "T"}-${t.number} ${t.title}\n${t.description}\n验收标准：\n${t.acceptanceCriteria.map((c) => `- [${c.id}] ${c.text}`).join("\n")}`)}`,
        p.role === "reviewer" ? `## 改动（diff）\n${untrusted("code", diff || "（无改动）")}` : "",
        `## 状态\n<state>${JSON.stringify(state)}</state>`,
      ]
        .filter(Boolean)
        .join("\n\n");
      await d.runtime.recordTurn(ses.id, {
        role: "context",
        content: `触发：${p.role === "reviewer" ? "评审" : "测试"} @${ws.headCommit.slice(0, 8)}`,
        contextPackage: { policy: { agentId: a.id, toolAllowlist: d.runtime.effectiveTools(a) }, state, layerTokens: { L1: estimateTokens(ctxText) } },
      });
      const conclude = p.role === "reviewer" ? "submit_review" : "submit_test_result";
      if (a.engine !== "builtin" && d.harness) {
        // External engine (ADR-0010): it reads the checkout and concludes through the platform tool only.
        const since = new Date();
        const res = await d.harness.run({
          agent: a,
          sessionId: ses.id,
          role: p.role,
          cwd: dir,
          taskId: t.id,
          workspaceId: ws.id,
          prompt: [
            instructions,
            ctxText,
            [
              "## 规则",
              `- 当前目录是提交 ${ws.headCommit.slice(0, 8)} 的独立只读检出：只阅读${p.role === "tester" ? "和运行测试" : ""}，不要修改文件`,
              p.role === "tester" ? `- 用平台工具 run_tests 运行测试（不填命令即 ${testCommand}），它的日志会作为证据附在结论上` : "- 需要完整改动时用平台工具 get_diff",
              `- 结论只能通过平台工具 ${conclude} 提交，验收标准用方括号里的 id；提交后就结束`,
            ].join("\n"),
          ].join("\n\n"),
          timeoutMs: a.budget.wallClockMs ?? QA_WALL_MS,
          maxTurns: (a.budget.maxSteps ?? QA_MAX_STEPS) * 4,
          scratch: st.scratch,
        });
        steps = 1;
        if (await concluded(t.id, p.role, ws.headCommit, a.principalId, since)) stopReason = st.stop = p.role === "reviewer" ? "review_submitted" : "test_submitted";
        else stopReason = res.ok ? "no_conclusion" : res.killed ? "harness_timeout" : "harness_failed";
      } else {
        const convo: ChatMsg[] = [];
        const limit = a.budget.maxSteps ?? QA_MAX_STEPS;
        let grace = 0; // one extra conclusion-only step when the forced conclusion is rejected by validation
        for (;;) {
          if (signal?.aborted) throw new JobAborted(`qa.turn aborted: ${String((signal.reason as Error | undefined)?.message ?? "")}`);
          if (steps >= limit + grace) {
            stopReason = "max_steps";
            break;
          }
          const cur = (await db.root.select({ s: session.status }).from(session).where(eq(session.id, ses.id)))[0];
          if (cur?.s !== "running") {
            stopReason = "cancelled";
            break;
          }
          // Thorough models keep reading until the budget runs out: the last step may only conclude.
          const lastStep = steps >= limit - 1;
          const tools = d.runtime.toolSpecs(a);
          let res;
          try {
            res = await d.llm.complete(actx, {
              purpose: p.role === "reviewer" ? "review.turn" : "test.turn",
              promptVersion: p.role === "reviewer" ? QA_PROMPTS.review : QA_PROMPTS.test,
              scope: { projectId: t.projectId, taskId: t.id, sessionId: ses.id, agentId: a.id },
              messages: [
                { role: "system", content: instructions },
                { role: "user", content: ctxText },
                ...convo,
                ...(lastStep && convo.length
                  ? [{ role: "user" as const, content: `这是本轮最后一步：不要再读取或检索，立即调用 ${conclude} 给出结论（依据已掌握的信息；信息不足就如实写明）。` }]
                  : []),
              ],
              tools: lastStep ? tools.filter((x) => x.name === conclude) : tools,
              modelPolicy: { ...a.modelPolicy, maxTokens: a.modelPolicy.maxTokens ?? agentMaxTokens(undefined) },
              dataClasses: ["code", "task"],
            });
          } catch (e) {
            stopReason = e instanceof BudgetExceeded ? "budget_exceeded" : e instanceof LlmUnavailable ? "llm_unavailable" : "llm_error";
            await d.runtime.recordTurn(ses.id, { role: "error", content: (e as Error).message.slice(0, 500) });
            break;
          }
          steps++;
          tokens += res.tokensIn + res.tokensOut;
          cost += res.cost;
          const calls = res.toolCalls.slice(0, 2);
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
            if (signal?.aborted) throw new JobAborted("qa.turn aborted before a tool call");
            const out = await d.runtime.invokeTool(actx, st, call as ParsedToolCall);
            const text = JSON.stringify(out).slice(0, 12_000);
            await d.runtime.recordTurn(ses.id, { role: "tool", content: text.slice(0, 4000), toolCalls: [call] });
            convo.push({ role: "tool", toolCallId: ided[ci]!.id, name: call.name, content: text });
            answered.add(ided[ci]!.id);
            if (st.stop) break;
          }
          for (const c of ided) if (!answered.has(c.id)) convo.push({ role: "tool", toolCallId: c.id, name: c.name, content: '{"ok":false,"error":"未执行"}' });
          if (lastStep && !st.stop && grace === 0 && calls.some((c) => c.name === conclude)) grace = 1;
          if (st.stop) {
            stopReason = st.stop;
            break;
          }
        }
      }
      if (!st.stop && stopReason !== "cancelled") {
        // A turn that ends without a conclusion is visible, not silent.
        await d.tasks.comment(actx, t.id, `${a.name} 本轮没有给出${p.role === "reviewer" ? "评审" : "测试"}结论（${stopReason}），请人工跟进或重新触发。`).catch(() => undefined);
      }
    } catch (e) {
      log.warn("qa.turn_failed", { taskId: t.id, role: p.role, err: (e as Error).message.slice(0, 300) });
      if (!(e instanceof DomainError)) throw e;
      stopReason = "tool_error";
    } finally {
      await d.workspaces.dropCheckout(dir);
    }
    await d.runtime.recordTurn(ses.id, { role: "effects", content: JSON.stringify(st.effects).slice(0, 4000) });
    if ((await db.root.select({ s: session.status }).from(session).where(eq(session.id, ses.id)))[0]?.s === "running")
      await d.runtime.finish(sys, ses, "idle", stopReason, { steps, tokens, cost, model: undefined });
    return { stopReason, steps, effects: st.effects };
  }

  return { consumer, turn, pick };
}
export type Qa = ReturnType<typeof createQa>;

/** Wakes re-check: Ctx only needed for symmetry with other modules. */
export type QaCtx = Ctx;
