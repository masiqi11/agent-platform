import { evaluateGate, type DomainEvent, type TaskStatus } from "@ap/shared";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Audit } from "../../core/audit";
import type { Ctx } from "../../core/context";
import { DomainError, conflict, forbidden, invalid } from "../../core/errors";
import type { Consumer, Events } from "../../core/events";
import { newId } from "../../core/ids";
import { log } from "../../core/logger";
import type { Database } from "../../db";
import { agent, approval, artifact, llmCall, mergeQueueItem, principal, review, task, testRun, workspace, type AcceptanceCriterion } from "../../db/schema";
import type { Approvals } from "../approvals/service";
import type { Identity } from "../identity/service";
import type { Repos } from "../repos/service";
import type { Tasks } from "../tasks/service";

type TaskRow = typeof task.$inferSelect;
export type Verdict = "approved" | "changes_requested";
export interface ReviewComment {
  path?: string;
  line?: number;
  body: string;
}
export interface SubmitReviewInput {
  verdict: Verdict;
  summary?: string;
  comments?: ReviewComment[];
  /** Per acceptance criterion: met / unmet / na (TSK-补9). */
  criteria?: Record<string, "met" | "unmet" | "na">;
  /** REL-补1: the reviewer confirms or extends the dev's draft test plan. */
  testPlan?: Record<string, unknown>;
}
export interface SubmitTestInput {
  status: "passed" | "failed" | "error";
  criteriaResults: Array<{ id: string; verdict: "met" | "unmet" | "na"; evidence?: string }>;
  logArtifactId?: string | null;
  reportArtifactId?: string | null;
  durationMs?: number;
  summary?: string;
}

/**
 * Reviews, test runs and the merge gate (§12.8, FR-REL-01…04, TSK-补5, NTF-补1/4). Every
 * conclusion is bound to the head commit it was made on; a new push supersedes it.
 */
export function createQuality(d: { db: Database; audit: Audit; events: Events; identity: Identity; tasks: Tasks; approvals: Approvals; repos: Repos }) {
  const { db } = d;
  /** Set by the merge queue module (avoids a module cycle). */
  const hooks: { enqueueMerge?: (ctx: Ctx, t: TaskRow, headSha: string) => Promise<unknown>; dequeue?: (ctx: Ctx, taskId: string, reason: string) => Promise<unknown> } = {};

  async function headOf(taskId: string) {
    const [ws] = await db.root.select().from(workspace).where(eq(workspace.taskId, taskId)).orderBy(desc(workspace.createdAt)).limit(1);
    return ws ?? null;
  }

  /**
   * INV-08: on one task, dev ≠ reviewer ≠ tester (pairwise). Agents are separated by role; humans
   * by what they already did on this task (took over / reviewed / tested).
   */
  async function assertSeparation(ctx: Ctx, t: TaskRow, as: "review" | "test") {
    const me = ctx.actor.principalId;
    if (ctx.actor.kind === "agent") {
      const [a] = await db.root.select().from(agent).where(eq(agent.principalId, me));
      if (!a) throw forbidden("Agent");
      if (a.id === t.assigneeAgentId) throw forbidden(as === "review" ? "评审 Agent" : "测试 Agent", "开发 Agent 不能评审或测试自己的任务（INV-08）");
      if (as === "review" && a.role !== "reviewer") throw forbidden("评审 Agent", `只有评审 Agent 能提交评审（INV-08），当前角色：${a.role}`);
      if (as === "test" && a.role !== "tester") throw forbidden("测试 Agent", `只有测试 Agent 能提交测试结果（INV-08），当前角色：${a.role}`);
    } else if (ctx.actor.kind === "human") {
      if (t.takenOverBy === me) throw forbidden("其他评审人", "接管并提交过代码的人不能评审或测试该任务（AGT-补3 / INV-08）");
    }
    const otherSide =
      as === "review"
        ? await db.root
            .select({ id: testRun.id })
            .from(testRun)
            .where(and(eq(testRun.taskId, t.id), eq(testRun.testerPrincipalId, me)))
        : await db.root
            .select({ id: review.id })
            .from(review)
            .where(and(eq(review.taskId, t.id), eq(review.reviewerPrincipalId, me)));
    if (otherSide.length) throw forbidden(as === "review" ? "评审人" : "测试人", as === "review" ? "已执行过测试的人不能再评审同一任务（INV-08）" : "已评审过的人不能再测试同一任务（INV-08）");
  }

  /* ───────────── reviews ───────────── */

  async function submitReview(ctx: Ctx, taskId: string, input: SubmitReviewInput) {
    const t = await d.tasks.load(ctx, taskId);
    const deny = async (msg: string) =>
      d.audit.write(ctx, { action: "review.submit", resourceType: "task", resourceId: t.id, projectId: t.projectId, outcome: "denied", after: { verdict: input.verdict, reason: msg } });
    if (ctx.actor.kind === "human") {
      const roles = await d.tasks.rolesFor(ctx, t);
      if (!roles.has("human_reviewer") && !roles.has("maintainer")) {
        await deny("not a reviewer");
        throw forbidden("人类评审人或 Maintainer");
      }
    } else {
      const dec = await d.identity.check(ctx, "review.approve", { projectId: t.projectId, isTaskAssignee: false });
      if (!dec.allowed) {
        await deny("permission");
        throw forbidden(dec.required);
      }
    }
    try {
      await assertSeparation(ctx, t, "review");
    } catch (e) {
      await deny((e as Error).message);
      throw e;
    }
    // TSK-补5: humans may still request changes after the agent approved (task already in testing).
    const humanLate = ctx.actor.kind === "human" && t.status === "testing" && input.verdict === "changes_requested";
    if (t.status !== "in_review" && !humanLate) throw conflict(`任务当前为「${t.status}」，不在评审中`);
    const ws = await headOf(t.id);
    if (!ws?.headCommit) throw conflict("任务还没有提交，无法评审");
    const comments = (input.comments ?? []).filter((c) => c.body?.trim()).slice(0, 50);
    if (input.verdict === "changes_requested" && !comments.length && !input.summary?.trim()) throw invalid("要求修改时必须给出意见", [{ path: "/comments", message: "必填" }]);
    const [{ n }] = (await db.root
      .select({ n: sql<number>`count(*)::int` })
      .from(review)
      .where(eq(review.taskId, t.id))) as [{ n: number }];
    const id = newId("rvw");
    const kind = ctx.actor.kind === "human" ? "human" : "agent";
    await db.tx(async (q) => {
      await q.insert(review).values({
        id,
        tenantId: t.tenantId,
        taskId: t.id,
        reviewerPrincipalId: ctx.actor.principalId,
        reviewerKind: kind,
        headSha: ws.headCommit!,
        verdict: input.verdict,
        comments: comments.map((c) => ({ ...(c.path ? { path: c.path } : {}), ...(c.line ? { line: c.line } : {}), body: c.body.slice(0, 2000) })),
        criteriaVerdicts: input.criteria ?? {},
        round: n + 1,
      });
      if (input.testPlan && Object.keys(input.testPlan).length)
        await q
          .update(task)
          .set({ testPlan: { ...t.testPlan, ...input.testPlan, confirmedBy: ctx.actor.principalId }, version: t.version + 1, updatedAt: new Date() })
          .where(eq(task.id, t.id));
      await d.events.emit(ctx, {
        type: "review.submitted",
        aggregateType: "task",
        aggregateId: t.id,
        payload: { projectId: t.projectId, taskId: t.id, reviewId: id, verdict: input.verdict, headSha: ws.headCommit, kind, round: n + 1 },
      });
      await d.audit.write(ctx, {
        action: "review.submit",
        resourceType: "task",
        resourceId: t.id,
        projectId: t.projectId,
        after: { reviewId: id, verdict: input.verdict, headSha: ws.headCommit, comments: comments.length },
      });
    });
    // Comments also land on the MR, best effort (the platform record is the source of truth).
    if (ws.mrRef && comments.length) {
      const r = await d.repos.byId(ws.repoId);
      if (r)
        await (
          await d.repos.scmFor(r)
        )
          .addNote(
            "mr",
            Number(ws.mrRef.replace(/^!/, "")),
            [`评审第 ${n + 1} 轮：${input.verdict === "approved" ? "通过" : "要求修改"}`, ...comments.map((c) => `- ${c.path ? `\`${c.path}${c.line ? `:${c.line}` : ""}\` ` : ""}${c.body}`)].join(
              "\n",
            ),
          )
          .catch((e) => log.warn("review.mr_note_failed", { err: (e as Error).message.slice(0, 200) }));
    }
    let status: TaskStatus = t.status as TaskStatus;
    let note: string | null = null;
    if (t.status === "in_review") {
      if (input.verdict === "approved") {
        try {
          status = (await d.tasks.transition(ctx, t.id, "testing", {})).status as TaskStatus;
        } catch (e) {
          // e.g. GIT-补7 requires a human review: the agent's approval is recorded, the task waits.
          note = e instanceof DomainError ? e.message : "无法进入测试";
          if ((e as DomainError).code === "illegal_transition") await d.tasks.comment(ctx, t.id, `评审已通过，但还不能进入测试：${note}`).catch(() => undefined);
          else throw e;
        }
      } else {
        const reason = [input.summary?.trim(), ...comments.map((c, i) => `${i + 1}. ${c.path ? `${c.path}${c.line ? `:${c.line}` : ""} ` : ""}${c.body}`)].filter(Boolean).join("\n").slice(0, 1900);
        status = (await d.tasks.transition(ctx, t.id, "in_progress", { reason })).status as TaskStatus;
      }
    } else if (humanLate) {
      // Human changes request after the agent approved: the gate now fails; take it out of the merge queue.
      await hooks.dequeue?.(ctx, t.id, "人类评审要求修改");
      await d.tasks.comment(ctx, t.id, `人类评审要求修改（覆盖评审 Agent 的结论）：${input.summary ?? comments.map((c) => c.body).join("；")}`).catch(() => undefined);
    }
    return { id, verdict: input.verdict, headSha: ws.headCommit, round: n + 1, status, note };
  }

  /* ───────────── test runs ───────────── */

  async function submitTest(ctx: Ctx, taskId: string, input: SubmitTestInput) {
    const t = await d.tasks.load(ctx, taskId);
    if (ctx.actor.kind === "agent") {
      const dec = await d.identity.check(ctx, "test.run", { projectId: t.projectId, isTaskAssignee: false });
      if (!dec.allowed) throw forbidden(dec.required);
    } else {
      const dec = await d.identity.check(ctx, "test.run", { projectId: t.projectId });
      if (!dec.allowed) throw forbidden(dec.required);
    }
    await assertSeparation(ctx, t, "test");
    if (t.status !== "testing") throw conflict(`任务当前为「${t.status}」，不在测试中`);
    const ws = await headOf(t.id);
    if (!ws?.headCommit) throw conflict("任务还没有提交");
    // REL-补2: every acceptance criterion gets a result; cases may be added, never dropped (REL-补1).
    const results = input.criteriaResults.filter((r) => t.acceptanceCriteria.some((c) => c.id === r.id));
    const missing = t.acceptanceCriteria.filter((c) => !results.some((r) => r.id === c.id));
    if (missing.length) throw invalid(`测试结果必须逐条覆盖验收标准，缺少：${missing.map((m) => m.text).join("；")}`, [{ path: "/criteriaResults", message: "不完整" }]);
    if (input.status === "passed" && results.some((r) => r.verdict === "unmet")) throw invalid("有未满足的验收标准时不能判定为通过", [{ path: "/status", message: "矛盾" }]);
    const [{ n }] = (await db.root
      .select({ n: sql<number>`count(*)::int` })
      .from(testRun)
      .where(eq(testRun.taskId, t.id))) as [{ n: number }];
    const id = newId("tst");
    const criteria = t.acceptanceCriteria.map((c): AcceptanceCriterion => {
      const r = results.find((x) => x.id === c.id)!;
      return { ...c, verdict: r.verdict, ...(r.evidence ? { note: r.evidence.slice(0, 500) } : {}) };
    });
    await db.tx(async (q) => {
      await q.insert(testRun).values({
        id,
        tenantId: t.tenantId,
        taskId: t.id,
        testerPrincipalId: ctx.actor.principalId,
        headSha: ws.headCommit!,
        plan: (t.testPlan ?? {}) as Record<string, unknown>,
        status: input.status,
        reportArtifactId: input.reportArtifactId ?? null,
        logArtifactId: input.logArtifactId ?? null,
        attempt: n + 1,
        criteriaResults: results.map((r) => ({
          id: r.id,
          text: t.acceptanceCriteria.find((c) => c.id === r.id)!.text,
          verdict: r.verdict,
          ...(r.evidence ? { evidence: r.evidence.slice(0, 500) } : {}),
        })),
        durationMs: input.durationMs ?? null,
        finishedAt: new Date(),
      });
      // Criterion verdicts on the task follow the latest test run (TSK-补9).
      await q
        .update(task)
        .set({ acceptanceCriteria: criteria, version: t.version + 1, updatedAt: new Date() })
        .where(eq(task.id, t.id));
      await d.events.emit(ctx, {
        type: "test_run.completed",
        aggregateType: "task",
        aggregateId: t.id,
        payload: { projectId: t.projectId, taskId: t.id, testRunId: id, status: input.status, headSha: ws.headCommit, attempt: n + 1 },
      });
      await d.audit.write(ctx, { action: "test.submit", resourceType: "task", resourceId: t.id, projectId: t.projectId, after: { testRunId: id, status: input.status, headSha: ws.headCommit } });
    });
    let status = "testing";
    if (input.status !== "passed" && ctx.actor.kind === "agent") {
      const reason = `测试未通过（第 ${n + 1} 次）：${
        input.summary ??
        results
          .filter((r) => r.verdict === "unmet")
          .map((r) => r.evidence ?? r.id)
          .join("；")
      }`.slice(0, 1900);
      status = (await d.tasks.transition(ctx, t.id, "in_progress", { reason, evidenceArtifactId: input.logArtifactId ?? undefined })).status;
    }
    return { id, status: input.status, headSha: ws.headCommit, attempt: n + 1, taskStatus: status };
  }

  /* ───────────── views ───────────── */

  async function reviewsOf(ctx: Ctx, taskId: string) {
    const t = await d.tasks.load(ctx, taskId);
    await d.identity.require(ctx, "project.view", { projectId: t.projectId });
    const rows = await db.root
      .select({ r: review, name: principal.displayName })
      .from(review)
      .leftJoin(principal, eq(principal.id, review.reviewerPrincipalId))
      .where(eq(review.taskId, taskId))
      .orderBy(desc(review.createdAt));
    const head = (await headOf(taskId))?.headCommit ?? null;
    return rows.map(({ r, name }) => ({
      id: r.id,
      reviewer: { principalId: r.reviewerPrincipalId, name: name ?? "", kind: r.reviewerKind },
      headSha: r.headSha,
      current: r.headSha === head && !r.superseded,
      verdict: r.verdict,
      comments: r.comments,
      criteria: r.criteriaVerdicts,
      round: r.round,
      createdAt: r.createdAt.toISOString(),
    }));
  }
  async function testsOf(ctx: Ctx, taskId: string) {
    const t = await d.tasks.load(ctx, taskId);
    await d.identity.require(ctx, "project.view", { projectId: t.projectId });
    const rows = await db.root
      .select({ r: testRun, name: principal.displayName })
      .from(testRun)
      .leftJoin(principal, eq(principal.id, testRun.testerPrincipalId))
      .where(eq(testRun.taskId, taskId))
      .orderBy(desc(testRun.createdAt));
    const head = (await headOf(taskId))?.headCommit ?? null;
    return rows.map(({ r, name }) => ({
      id: r.id,
      tester: { principalId: r.testerPrincipalId, name: name ?? "" },
      headSha: r.headSha,
      current: r.headSha === head && !r.superseded,
      status: r.status,
      attempt: r.attempt,
      criteriaResults: r.criteriaResults,
      logArtifactId: r.logArtifactId,
      reportArtifactId: r.reportArtifactId,
      durationMs: r.durationMs,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /* ───────────── gate (TRAP-8) ───────────── */

  async function gate(t: TaskRow) {
    const f = await d.tasks.facts(t);
    return { facts: f, ...evaluateGate(f) };
  }

  /** NTF-补1: everything a human needs to decide a merge, as readable fields. */
  async function mergeEvidence(t: TaskRow) {
    const ws = await headOf(t.id);
    const [rv] = await db.root
      .select()
      .from(review)
      .where(and(eq(review.taskId, t.id), eq(review.headSha, ws?.headCommit ?? ""), eq(review.superseded, false)))
      .orderBy(desc(review.createdAt))
      .limit(1);
    const [tr] = await db.root
      .select()
      .from(testRun)
      .where(and(eq(testRun.taskId, t.id), eq(testRun.headSha, ws?.headCommit ?? ""), eq(testRun.superseded, false)))
      .orderBy(desc(testRun.createdAt))
      .limit(1);
    const [cost] = await db.root
      .select({ tokens: sql<number>`coalesce(sum(${llmCall.tokensIn} + ${llmCall.tokensOut}), 0)::int`, usd: sql<number>`coalesce(sum(${llmCall.cost}), 0)::float` })
      .from(llmCall)
      .where(eq(llmCall.taskId, t.id));
    const arts = tr?.logArtifactId ? await db.root.select({ name: artifact.name }).from(artifact).where(eq(artifact.id, tr.logArtifactId)) : [];
    const stat = ws?.diffStat;
    return {
      mr: ws?.mrRef ? `${ws.mrRef}${ws.mrUrl ? ` ${ws.mrUrl}` : ""}` : "（无）",
      diff: stat ? `${stat.files} 个文件 +${stat.additions} −${stat.deletions}：${stat.paths.slice(0, 8).join("、")}` : "（无）",
      review: rv ? `${rv.verdict === "approved" ? "通过" : "要求修改"}（第 ${rv.round} 轮，${rv.reviewerKind === "human" ? "人类" : "Agent"}）` : "（无）",
      tests: tr
        ? `${tr.status === "passed" ? "通过" : "未通过"}（第 ${tr.attempt} 次，${tr.criteriaResults.filter((c) => c.verdict === "met").length}/${tr.criteriaResults.length} 条验收标准满足）${arts[0] ? `，日志 ${arts[0].name}` : ""}`
        : "（无）",
      ci: ws?.ci ? `${(ws.ci as { status: string }).status} @${String((ws.ci as { sha: string }).sha).slice(0, 8)}` : "（无）",
      cost: `${cost?.tokens ?? 0} tokens，$${(cost?.usd ?? 0).toFixed(4)}`,
      risk: stat?.humanReviewRequired ? `需要人类评审：${(stat.reasons ?? []).join("；")}` : "无（改动范围在阈值内）",
    };
  }

  /**
   * Re-evaluates a task's merge gate. Called on every relevant event, so a gate that failed only
   * because CI was still running passes on its own once pipeline.completed arrives (TRAP-8).
   * All-but-approval → request the merge approval with evidence; all green → hand to the merge queue.
   */
  async function reevaluate(tenantId: string, taskId: string, traceId?: string) {
    const [t] = await db.root.select().from(task).where(eq(task.id, taskId));
    if (!t || t.status !== "testing") return null;
    const sys = await d.identity.systemCtx(tenantId, traceId);
    const g = await gate(t);
    const ws = await headOf(t.id);
    await d.events.emit(sys, {
      type: "gate.evaluated",
      aggregateType: "task",
      aggregateId: t.id,
      payload: { projectId: t.projectId, taskId: t.id, ok: g.ok, missing: g.missing, headSha: ws?.headCommit ?? null },
      idempotencyKey: `gate:${t.id}:${ws?.headCommit ?? ""}:${g.missing.join(",") || "ok"}`,
    });
    if (g.ok && ws?.headCommit) {
      await hooks.enqueueMerge?.(sys, t, ws.headCommit);
      return g;
    }
    const onlyApproval = g.missing.length === 1 && g.missing[0] === "merge_approval";
    if (onlyApproval && ws?.headCommit) {
      const existing = await db.root
        .select({ id: approval.id })
        .from(approval)
        // Any decision on this head (incl. rejected / expired) stands until a new commit; never re-ask automatically.
        .where(and(eq(approval.taskId, t.id), eq(approval.kind, "merge"), eq(approval.headSha, ws.headCommit), inArray(approval.status, ["pending", "approved", "rejected", "expired"])));
      if (!existing.length) await d.approvals.request(sys, t.id, { kind: "merge", headSha: ws.headCommit, evidence: await mergeEvidence(t) });
    }
    return g;
  }

  /** New commits make older conclusions stale: reviews/tests superseded, merge approvals invalidated, queue item dropped. */
  async function onNewHead(tenantId: string, taskId: string, sha: string, traceId?: string) {
    const sys = await d.identity.systemCtx(tenantId, traceId);
    const r1 = await db.root
      .update(review)
      .set({ superseded: true })
      .where(and(eq(review.taskId, taskId), ne(review.headSha, sha), eq(review.superseded, false)))
      .returning({ id: review.id });
    const r2 = await db.root
      .update(testRun)
      .set({ superseded: true })
      .where(and(eq(testRun.taskId, taskId), ne(testRun.headSha, sha), eq(testRun.superseded, false)))
      .returning({ id: testRun.id });
    const r3 = await d.approvals.invalidate(sys, taskId, sha);
    const [mq] = await db.root.select().from(mergeQueueItem).where(eq(mergeQueueItem.taskId, taskId));
    if (mq && mq.headSha !== sha && !["merged"].includes(mq.status)) await hooks.dequeue?.(sys, taskId, `新提交 ${sha.slice(0, 8)}，需重新评审/测试`);
    return { reviews: r1.length, tests: r2.length, approvals: r3 };
  }

  const consumer: Consumer = {
    name: "quality",
    types: ["commit.pushed", "review.submitted", "test_run.completed", "pipeline.completed", "approval.decided", "task.status_changed", "task.updated"],
    async handle(e: DomainEvent) {
      const p = e.payload as { taskId?: string; sha?: string; to?: string };
      if (!p.taskId) return;
      if (e.type === "commit.pushed" && p.sha) await onNewHead(e.tenantId, p.taskId, p.sha, e.traceId);
      if (e.type === "task.status_changed" && p.to !== "testing") return;
      await reevaluate(e.tenantId, p.taskId, e.traceId);
    },
  };

  return { submitReview, submitTest, reviewsOf, testsOf, gate, reevaluate, onNewHead, mergeEvidence, consumer, hooks, headOf };
}
export type Quality = ReturnType<typeof createQuality>;
