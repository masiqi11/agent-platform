import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DomainEvent } from "@ap/shared";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Audit } from "../../core/audit";
import type { Ctx } from "../../core/context";
import { forbidden } from "../../core/errors";
import type { Consumer, Events } from "../../core/events";
import { newId } from "../../core/ids";
import type { createJobs } from "../../core/jobs";
import { log } from "../../core/logger";
import type { Config } from "../../config";
import type { Database } from "../../db";
import { approval, mergeQueueItem, project, releaseRecord, task, testRun, workspace } from "../../db/schema";
import type { Delivery } from "../delivery/service";
import type { Identity } from "../identity/service";
import type { Inbox } from "../inbox/service";
import type { Quality } from "../quality/service";
import type { Repos, RepoRow } from "../repos/service";
import { ScmAuthError, ScmNotReady, ScmPermissionError, createGitLabScm, git } from "../scm/service";
import type { Tasks } from "../tasks/service";
import type { Workspaces } from "../workspaces/service";

type Jobs = ReturnType<typeof createJobs>;
type Item = typeof mergeQueueItem.$inferSelect;
type TaskRow = typeof task.$inferSelect;

/** TRAP-10 / GIT-补3: every wait has an upper bound, after which the item goes to a human. */
export const PIPELINE_TIMEOUT_MS = 30 * 60_000;
export const NOT_READY_TIMEOUT_MS = 2 * 3600_000;
export const MAX_REBASE_ATTEMPTS = 3;
const ACTIVE: Item["status"][] = ["queued", "rebasing", "waiting_ci", "merging"];

export interface QueueState {
  paused: boolean;
  reason?: string;
  sha?: string;
  at?: string;
  by?: string;
}

/**
 * The merge queue (FR-GIT-05, §12.7): the ONLY merger. Per project, items are processed in order:
 * rebase onto the default branch → CI on the rebased commit → fast-forward merge → close the issue →
 * task → done → release record. It loops until the queue is empty (TRAP-10); a failed item goes to a
 * human without blocking the next; a red default branch pauses the queue (GIT-补4).
 */
export function createMergeQueue(d: {
  config: Config;
  db: Database;
  audit: Audit;
  events: Events;
  jobs: Jobs;
  identity: Identity;
  tasks: Tasks;
  repos: Repos;
  workspaces: Workspaces;
  delivery: Delivery;
  quality: Quality;
  inbox: Inbox;
}) {
  const { db } = d;
  const hooks: { afterMerged?: (ctx: Ctx, taskId: string) => Promise<unknown> } = {};
  const identityFor = () => ({ name: "合并队列", email: `merge-queue@agents.${new URL(d.config.publicUrl).hostname || "local"}` });

  async function queueState(projectId: string): Promise<QueueState> {
    const [p] = await db.root.select({ s: project.settings }).from(project).where(eq(project.id, projectId));
    return ((p?.s as { mergeQueue?: QueueState } | undefined)?.mergeQueue ?? { paused: false }) as QueueState;
  }
  async function setState(projectId: string, st: QueueState) {
    await db.root.execute(sql`update project set settings = settings || ${JSON.stringify({ mergeQueue: st })}::jsonb, updated_at = now() where id = ${projectId}`);
  }
  async function kick(tenantId: string, projectId: string) {
    await d.jobs.enqueue("merge.process", { projectId }, { tenantId, dedupeKey: `merge:${projectId}`, concurrencyKey: `merge:${projectId}`, maxAttempts: 5 });
  }

  /* ───────────── membership ───────────── */

  async function enqueue(ctx: Ctx, t: TaskRow, headSha: string) {
    const [cur] = await db.root.select().from(mergeQueueItem).where(eq(mergeQueueItem.taskId, t.id));
    if (cur?.status === "merged") return cur;
    if (cur && cur.headSha === headSha && ACTIVE.includes(cur.status)) return cur;
    const id = newId("mqi");
    const [row] = await db.tx(async (q) => {
      // Re-queueing (after a fix) goes to the tail: a fresh row gets a fresh position.
      if (cur) await q.delete(mergeQueueItem).where(eq(mergeQueueItem.id, cur.id));
      const r = await q.insert(mergeQueueItem).values({ id, tenantId: t.tenantId, projectId: t.projectId, taskId: t.id, headSha }).returning();
      await d.events.emit(ctx, { type: "merge.queued", aggregateType: "merge", aggregateId: id, payload: { projectId: t.projectId, taskId: t.id, itemId: id, headSha } });
      await d.audit.write(ctx, { action: "merge.enqueue", resourceType: "task", resourceId: t.id, projectId: t.projectId, after: { headSha } });
      await kick(t.tenantId, t.projectId);
      return r;
    });
    return row!;
  }

  async function dequeue(ctx: Ctx, taskId: string, reason: string) {
    const [cur] = await db.root.select().from(mergeQueueItem).where(eq(mergeQueueItem.taskId, taskId));
    if (!cur || cur.status === "merged" || cur.status === "failed") return false;
    await db.tx(async (q) => {
      await q
        .update(mergeQueueItem)
        .set({ status: "failed", lastError: reason.slice(0, 500), updatedAt: new Date() })
        .where(eq(mergeQueueItem.id, cur.id));
      await d.events.emit(ctx, { type: "merge.failed", aggregateType: "merge", aggregateId: cur.id, payload: { projectId: cur.projectId, taskId, itemId: cur.id, reason: reason.slice(0, 120) } });
      await d.audit.write(ctx, { action: "merge.dequeue", resourceType: "task", resourceId: taskId, projectId: cur.projectId, after: { reason } });
    });
    return true;
  }

  async function update(item: Item, patch: Partial<Item>) {
    await db.root
      .update(mergeQueueItem)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(mergeQueueItem.id, item.id));
    return { ...item, ...patch } as Item;
  }

  /** Hands an item to a human (conflict, red CI, timeout, not ready …); the queue moves on (FR-GIT-05/06). */
  async function needsHuman(item: Item, t: TaskRow, reason: string, files: string[] = []) {
    const sys = await d.identity.systemCtx(item.tenantId);
    const owners = (await d.tasks.ownersOf([t.id])).filter((o) => o.role === "owner").map((o) => o.principalId);
    const maint = await d.inbox.maintainers(t.projectId);
    await db.tx(async (q) => {
      await q
        .update(mergeQueueItem)
        .set({ status: "needs_human", lastError: reason.slice(0, 1000), conflictFiles: files.slice(0, 100), updatedAt: new Date() })
        .where(eq(mergeQueueItem.id, item.id));
      await d.events.emit(sys, {
        type: "merge.failed",
        aggregateType: "merge",
        aggregateId: item.id,
        payload: { projectId: t.projectId, taskId: t.id, itemId: item.id, reason: reason.slice(0, 120), needsHuman: true, inboxPrincipalIds: [...new Set([...owners, ...maint])] },
      });
      await d.audit.write(sys, { action: "merge.needs_human", resourceType: "task", resourceId: t.id, projectId: t.projectId, after: { reason, files } });
    });
    await d.tasks.comment(sys, t.id, `合并队列需要人工处理：${reason}${files.length ? `\n冲突文件：\n${files.map((f) => `- ${f}`).join("\n")}` : ""}`).catch(() => undefined);
    return "done" as const;
  }

  /* ───────────── processing ───────────── */

  async function repoOf(taskId: string): Promise<{ r: RepoRow; ws: typeof workspace.$inferSelect } | null> {
    const [ws] = await db.root.select().from(workspace).where(eq(workspace.taskId, taskId)).orderBy(desc(workspace.createdAt)).limit(1);
    if (!ws) return null;
    const r = await d.repos.byId(ws.repoId);
    return r ? { r, ws } : null;
  }

  /** Local provider: rebase the task branch onto the current default branch in a throwaway clone. */
  async function rebaseLocal(r: RepoRow, branch: string, expectHead: string) {
    const dir = await mkdtemp(join(tmpdir(), "ap-mq-"));
    const id = identityFor();
    const env = { GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email };
    try {
      await git(["clone", "-q", r.url, dir], { cwd: "/" });
      const head = (await git(["rev-parse", `origin/${branch}`], { cwd: dir, allowFail: true })).out;
      if (head !== expectHead) return { moved: head || "（分支不存在）" } as const;
      await git(["checkout", "-q", "-B", "mq", `origin/${branch}`], { cwd: dir });
      const rb = await git(["-c", `user.name=${id.name}`, "-c", `user.email=${id.email}`, "rebase", `origin/${r.defaultBranch}`], { cwd: dir, env, allowFail: true });
      if (!rb.ok) {
        const files = (await git(["diff", "--name-only", "--diff-filter=U"], { cwd: dir, allowFail: true })).out.split("\n").filter(Boolean);
        await git(["rebase", "--abort"], { cwd: dir, allowFail: true });
        return { conflict: files.length ? files : ["（无法确定冲突文件）"] } as const;
      }
      const sha = (await git(["rev-parse", "HEAD"], { cwd: dir })).out;
      // Park the rebased commit under a queue ref (not a protected branch) so CI can check it out.
      if (sha !== expectHead) await git(["push", "-q", "-f", r.url, `${sha}:refs/merge-queue/${branch.replace(/[^\w.-]/g, "_")}`], { cwd: dir });
      return { sha } as const;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Fast-forward the default branch to the rebased commit; only the queue may (AP_MERGE_QUEUE=1, INV-10). */
  async function mergeLocal(r: RepoRow, sha: string) {
    const dir = await mkdtemp(join(tmpdir(), "ap-mq-"));
    try {
      await git(["clone", "-q", r.url, dir], { cwd: "/" });
      await git(["fetch", "-q", "origin", `+refs/merge-queue/*:refs/remotes/mq/*`], { cwd: dir, allowFail: true });
      const contains = (await git(["merge-base", "--is-ancestor", sha, `origin/${r.defaultBranch}`], { cwd: dir, allowFail: true })).ok;
      if (contains) return "already" as const; // merged before a crash: idempotent
      const ff = (await git(["merge-base", "--is-ancestor", `origin/${r.defaultBranch}`, sha], { cwd: dir, allowFail: true })).ok;
      if (!ff) return "moved" as const;
      const p = await git(["push", "-q", r.url, `${sha}:refs/heads/${r.defaultBranch}`], { cwd: dir, env: { AP_MERGE_QUEUE: "1" }, allowFail: true });
      if (!p.ok) return "moved" as const;
      return "merged" as const;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function finalize(item: Item, t: TaskRow, r: RepoRow, ws: typeof workspace.$inferSelect, mergeSha: string) {
    const sys = await d.identity.systemCtx(item.tenantId);
    if (r.provider === "local" && ws.mrRef) await d.repos.localScm(r).mergeLocal(Number(ws.mrRef.replace(/^!/, "")), mergeSha);
    // Close the issue as part of merging (guard issue_closed for testing → done).
    if (t.issueRef) await d.delivery.syncIssue(t.id, { forceClosed: true });
    const [tr] = await db.root
      .select({ id: testRun.id })
      .from(testRun)
      .where(and(eq(testRun.taskId, t.id), eq(testRun.headSha, item.headSha ?? ""), eq(testRun.status, "passed")))
      .orderBy(desc(testRun.createdAt))
      .limit(1);
    const [ap] = await db.root
      .select({ by: approval.decidedBy })
      .from(approval)
      .where(and(eq(approval.taskId, t.id), eq(approval.kind, "merge"), eq(approval.headSha, item.headSha ?? ""), eq(approval.status, "approved")))
      .limit(1);
    const relId = newId("rel");
    const owners = (await d.tasks.ownersOf([t.id])).filter((o) => o.role === "owner").map((o) => o.principalId);
    await db.tx(async (q) => {
      await q.update(mergeQueueItem).set({ status: "merged", mergeSha, lastError: null, updatedAt: new Date() }).where(eq(mergeQueueItem.id, item.id));
      const [existing] = await q.select({ id: releaseRecord.id }).from(releaseRecord).where(eq(releaseRecord.taskId, t.id));
      if (!existing) {
        // REL-补4: the P0 release record — task, MR, merge commit, test run, approver, time.
        await q.insert(releaseRecord).values({ id: relId, tenantId: t.tenantId, taskId: t.id, mrRef: ws.mrRef, mergeCommit: mergeSha, testRunId: tr?.id ?? null, approvedBy: ap?.by ?? null });
        await d.events.emit(sys, { type: "release.recorded", aggregateType: "task", aggregateId: t.id, payload: { projectId: t.projectId, taskId: t.id, releaseId: relId, mergeSha } });
      }
      await d.events.emit(sys, {
        type: "merge.completed",
        aggregateType: "merge",
        aggregateId: item.id,
        payload: { projectId: t.projectId, taskId: t.id, itemId: item.id, mergeSha, mrRef: ws.mrRef, inboxPrincipalIds: owners },
        idempotencyKey: `merged:${item.id}`,
      });
      await d.audit.write(sys, { action: "merge.complete", resourceType: "task", resourceId: t.id, projectId: t.projectId, after: { mergeSha, mr: ws.mrRef, headSha: item.headSha } });
    });
    const fresh = (await db.root.select().from(task).where(eq(task.id, t.id)))[0]!;
    if (fresh.status === "testing") await d.tasks.transition(sys, t.id, "done", {});
    await d.workspaces.release(sys, ws, "已合并").catch((e) => log.warn("merge.release_failed", { err: (e as Error).message }));
    // GIT-补4: watch the default branch after every merge.
    if (r.provider === "local") {
      const p = await d.repos.localScm(r).createPipeline(mergeSha, r.defaultBranch);
      await d.jobs.enqueue("ci.sha_run", { repoId: r.id, pipelineId: p.id, sha: mergeSha, purpose: "main", projectId: t.projectId }, { tenantId: t.tenantId, dedupeKey: `ci:${p.id}`, maxAttempts: 2 });
    }
    await hooks.afterMerged?.(sys, t.id).catch((e) => log.warn("merge.after_hook_failed", { err: (e as Error).message }));
    return "done" as const;
  }

  /** One state-machine step for an item. "wait" = nothing to do until an event (CI, sweep). */
  async function step(item: Item): Promise<"done" | "wait" | "again"> {
    const [t] = await db.root.select().from(task).where(eq(task.id, item.taskId));
    if (!t || t.status !== "testing") {
      await update(item, { status: "failed", lastError: `任务状态已变为 ${t?.status ?? "（不存在）"}` });
      return "done";
    }
    const loc = await repoOf(t.id);
    if (!loc) return needsHuman(item, t, "任务没有工作区/仓库");
    const { r, ws } = loc;
    // The gate is re-checked at merge time: evidence must still hold for the queued head.
    const g = await d.quality.gate(t);
    if (!g.ok || ws.headCommit !== item.headSha) {
      await update(item, { status: "failed", lastError: `门禁未通过：${g.missing.join("、") || "提交已变化"}` });
      return "done";
    }
    const now = Date.now();
    if (r.provider === "gitlab") {
      if (item.status === "queued") item = await update(item, { status: "merging", waitingSince: new Date(), attempts: item.attempts + 1 });
      if (!ws.mrRef) return needsHuman(item, t, "没有 MR");
      try {
        const scm = (await d.repos.scmFor(r)) as ReturnType<typeof createGitLabScm>;
        const m = await scm.mergeMr(Number(ws.mrRef.replace(/^!/, "")), item.headSha!);
        return finalize(item, t, r, ws, m.mergeCommit);
      } catch (e) {
        if (e instanceof ScmNotReady) {
          if (item.waitingSince && now - item.waitingSince.getTime() > NOT_READY_TIMEOUT_MS) return needsHuman(item, t, `GitLab 长时间未就绪：${e.message}`);
          await update(item, { lastError: e.message.slice(0, 500) });
          return "wait";
        }
        if (e instanceof ScmPermissionError) return needsHuman(item, t, e.message);
        if (e instanceof ScmAuthError) {
          await d.repos.onAuthError(r, e);
          return needsHuman(item, t, "GitLab 凭据无效");
        }
        throw e;
      }
    }
    // Local provider.
    if (item.status === "queued" || item.status === "rebasing") {
      item = await update(item, { status: "rebasing", attempts: item.attempts + 1 });
      if (item.attempts > MAX_REBASE_ATTEMPTS) return needsHuman(item, t, `默认分支持续变化，变基 ${MAX_REBASE_ATTEMPTS} 次仍未合入`);
      const rb = await rebaseLocal(r, ws.branch, item.headSha!);
      if ("moved" in rb) return needsHuman(item, t, `任务分支已变化（当前 ${String(rb.moved).slice(0, 8)}），与入队时的提交不一致`);
      if ("conflict" in rb) return needsHuman(item, t, "变基到默认分支时有冲突，不能自动忽略（FR-GIT-06）", [...(rb.conflict ?? [])]);
      if (rb.sha === item.headSha) {
        // Already on top of the default branch: CI for this exact commit has passed (gate).
        item = await update(item, { status: "merging", rebasedSha: rb.sha });
      } else {
        const p = await d.repos.localScm(r).createPipeline(rb.sha, `merge-queue/${ws.branch}`);
        await update(item, { status: "waiting_ci", rebasedSha: rb.sha, pipelineId: p.id, waitingSince: new Date() });
        await d.jobs.enqueue(
          "ci.sha_run",
          { repoId: r.id, pipelineId: p.id, sha: rb.sha, purpose: "merge_queue", projectId: t.projectId, itemId: item.id, taskId: t.id },
          { tenantId: t.tenantId, dedupeKey: `ci:${p.id}`, maxAttempts: 2 },
        );
        return "wait";
      }
    }
    if (item.status === "waiting_ci") {
      const pl = await d.repos.localScm(r).latestPipeline(item.rebasedSha!);
      if (!pl || pl.status === "running" || pl.status === "pending") {
        if (item.waitingSince && now - item.waitingSince.getTime() > PIPELINE_TIMEOUT_MS) return needsHuman(item, t, `变基后的流水线超过 ${PIPELINE_TIMEOUT_MS / 60_000} 分钟未结束`);
        return "wait";
      }
      if (pl.status !== "success") return needsHuman(item, t, `变基后的提交 ${item.rebasedSha!.slice(0, 8)} CI 未通过`);
      item = await update(item, { status: "merging" });
    }
    if (item.status === "merging") {
      const res = await mergeLocal(r, item.rebasedSha!);
      if (res === "moved") {
        // Someone else merged first: rebase again (bounded by MAX_REBASE_ATTEMPTS).
        await update(item, { status: "queued", rebasedSha: null, pipelineId: null, waitingSince: null });
        return "again";
      }
      return finalize(item, t, r, ws, item.rebasedSha!);
    }
    return "done";
  }

  /** Processes the project's queue until it is empty or waiting (TRAP-10: never stop after one item). */
  async function process(projectId: string) {
    const st = await queueState(projectId);
    if (st.paused) return { state: "paused" as const, processed: 0 };
    let processed = 0;
    for (let guard = 0; guard < 100; guard++) {
      const [item] = await db.root
        .select()
        .from(mergeQueueItem)
        .where(and(eq(mergeQueueItem.projectId, projectId), inArray(mergeQueueItem.status, ACTIVE)))
        .orderBy(asc(mergeQueueItem.position))
        .limit(1);
      if (!item) return { state: "empty" as const, processed };
      const r = await step(item);
      if (r === "wait") return { state: "waiting" as const, processed };
      if (r === "done") processed++;
    }
    return { state: "guard" as const, processed };
  }

  /** GIT-补4: a red default branch pauses the queue; a later green run on the current head resumes it. */
  async function onMainPipeline(tenantId: string, projectId: string, sha: string, status: string) {
    const st = await queueState(projectId);
    const sys = await d.identity.systemCtx(tenantId);
    if (status === "failed") {
      if (st.paused) return;
      await setState(projectId, { paused: true, reason: "main_red", sha, at: new Date().toISOString() });
      const maint = await d.inbox.maintainers(projectId);
      await d.events.emit(sys, {
        type: "escalation.raised",
        aggregateType: "project",
        aggregateId: projectId,
        payload: { projectId, level: 2, reason: `默认分支 ${sha.slice(0, 8)} 流水线失败，合并队列已暂停`, inboxPrincipalIds: maint },
      });
      await d.audit.write(sys, { action: "merge.queue_pause", resourceType: "project", resourceId: projectId, projectId, after: { reason: "main_red", sha } });
    } else if (status === "success" && st.paused && st.reason === "main_red") {
      await setState(projectId, { paused: false });
      await d.audit.write(sys, { action: "merge.queue_resume", resourceType: "project", resourceId: projectId, projectId, after: { reason: "main_green", sha } });
      await kick(tenantId, projectId);
    }
  }

  async function resume(ctx: Ctx, projectId: string) {
    await d.identity.projectInTenant(ctx, projectId);
    const dec = await d.identity.check(ctx, "project.update", { projectId });
    if (!dec.allowed) throw forbidden(dec.required);
    await setState(projectId, { paused: false, by: ctx.actor.principalId, at: new Date().toISOString() });
    await d.audit.write(ctx, { action: "merge.queue_resume", resourceType: "project", resourceId: projectId, projectId, after: { reason: "manual" } });
    await kick(ctx.tenantId, projectId);
    return { ok: true as const };
  }

  /** Re-queue an item a human has dealt with (e.g. after resolving a conflict on the branch). */
  async function retry(ctx: Ctx, taskId: string) {
    const t = await d.tasks.load(ctx, taskId);
    const roles = await d.tasks.rolesFor(ctx, t);
    if (!roles.has("maintainer") && !roles.has("human_owner")) throw forbidden("任务 owner 或 Maintainer");
    await d.quality.reevaluate(ctx.tenantId, taskId, ctx.traceId);
    const [cur] = await db.root.select().from(mergeQueueItem).where(eq(mergeQueueItem.taskId, taskId));
    if (cur && (cur.status === "needs_human" || cur.status === "failed")) {
      const loc = await repoOf(taskId);
      if (loc?.ws.headCommit) {
        await db.root.delete(mergeQueueItem).where(eq(mergeQueueItem.id, cur.id));
        await enqueue(ctx, t, loc.ws.headCommit);
      }
    }
    return { ok: true as const };
  }

  async function list(ctx: Ctx, projectId: string) {
    await d.identity.projectInTenant(ctx, projectId);
    await d.identity.require(ctx, "project.view", { projectId });
    const rows = await db.root
      .select({ i: mergeQueueItem, number: task.number, title: task.title })
      .from(mergeQueueItem)
      .innerJoin(task, eq(task.id, mergeQueueItem.taskId))
      .where(eq(mergeQueueItem.projectId, projectId))
      .orderBy(desc(mergeQueueItem.position))
      .limit(50);
    const key = await d.repos.projectKey(projectId);
    return {
      state: await queueState(projectId),
      items: rows.map(({ i, number, title }) => ({
        id: i.id,
        taskId: i.taskId,
        ref: `${key}-${number}`,
        title,
        status: i.status,
        position: i.position,
        headSha: i.headSha,
        rebasedSha: i.rebasedSha,
        mergeSha: i.mergeSha,
        attempts: i.attempts,
        lastError: i.lastError,
        conflictFiles: i.conflictFiles,
        enqueuedAt: i.enqueuedAt.toISOString(),
        updatedAt: i.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * GIT-补6: the standard path after a bad merge — a rollback task (hotfix) that reverts the merge
   * commit and goes through review, test and approval like any other change.
   */
  async function rollbackTask(ctx: Ctx, taskId: string) {
    const t = await d.tasks.load(ctx, taskId);
    if (t.status !== "done") throw forbidden("已完成的任务", "只有已合并完成的任务可以创建回滚任务");
    const rel = await releaseOf(taskId);
    if (!rel) throw forbidden("发布记录", "没有找到该任务的合并记录");
    const key = await d.repos.projectKey(t.projectId);
    const owners = (await d.tasks.ownersOf([t.id])).filter((o) => o.role === "owner").map((o) => o.principalId);
    return d.tasks.create(ctx, {
      projectId: t.projectId,
      groupId: t.groupId,
      title: `回滚 ${key}-${t.number}：${t.title}`.slice(0, 200),
      type: "hotfix",
      priority: "P1",
      description: `回滚 ${key}-${t.number} 的合并提交 \`${rel.mergeCommit}\`（MR ${rel.mrRef ?? "-"}）。\n\n做法：在任务分支上 \`git revert ${rel.mergeCommit}\`，生成 revert MR；同样经过评审、测试与合并审批。`,
      acceptanceCriteria: [`生成 revert MR，撤销合并提交 ${rel.mergeCommit.slice(0, 8)}`, "回滚后仓库测试全部通过", "回滚经过评审、测试与合并审批"],
      ownerPrincipalIds: owners,
      followUpOf: t.id,
    });
  }

  async function itemOf(taskId: string) {
    return (await db.root.select().from(mergeQueueItem).where(eq(mergeQueueItem.taskId, taskId)))[0] ?? null;
  }
  async function releaseOf(taskId: string) {
    return (await db.root.select().from(releaseRecord).where(eq(releaseRecord.taskId, taskId)))[0] ?? null;
  }

  /** Safety net (lost events, timeouts): kick every project that still has active items. */
  async function sweep() {
    const rows = await db.root.selectDistinct({ projectId: mergeQueueItem.projectId, tenantId: mergeQueueItem.tenantId }).from(mergeQueueItem).where(inArray(mergeQueueItem.status, ACTIVE));
    for (const r of rows) await kick(r.tenantId, r.projectId);
    return rows.length;
  }

  const consumer: Consumer = {
    name: "mergequeue",
    types: ["pipeline.completed", "merge.queued", "task.status_changed"],
    async handle(e: DomainEvent) {
      const p = e.payload as { projectId?: string; purpose?: string; sha?: string; status?: string; taskId?: string; to?: string };
      if (e.type === "task.status_changed") {
        // TSK-补2: a cancelled task leaves the queue.
        if (p.to === "cancelled" && p.taskId) await dequeue(await d.identity.systemCtx(e.tenantId), p.taskId, "任务已取消");
        return;
      }
      if (!p.projectId) return;
      if (e.type === "pipeline.completed" && p.purpose === "main" && p.sha && p.status) await onMainPipeline(e.tenantId, p.projectId, p.sha, p.status);
      if (e.type === "merge.queued" || p.purpose === "merge_queue" || p.purpose === "main") await kick(e.tenantId, p.projectId);
    },
  };

  return { rollbackTask, enqueue, dequeue, process, onMainPipeline, resume, retry, list, itemOf, releaseOf, sweep, consumer, hooks, queueState };
}
export type MergeQueue = ReturnType<typeof createMergeQueue>;
