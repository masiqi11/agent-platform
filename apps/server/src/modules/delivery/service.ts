import { STATUS_LABELS, asText, type DomainEvent, type TaskStatus } from "@ap/shared";
import { and, eq } from "drizzle-orm";
import type { Audit } from "../../core/audit";
import type { Consumer, Events } from "../../core/events";
import { newId } from "../../core/ids";
import type { createJobs } from "../../core/jobs";
import { log } from "../../core/logger";
import type { Config } from "../../config";
import type { Database } from "../../db";
import { task, taskComment, workspace } from "../../db/schema";
import type { Identity } from "../identity/service";
import type { Repos, RepoRow } from "../repos/service";
import type { Workspaces } from "../workspaces/service";

type Jobs = ReturnType<typeof createJobs>;

/** Marker label tying a SCM issue to a platform task (convergent re-runs find it). */
export const issueMarker = (key: string, number: number) => `ap::${key}-${number}`;

/**
 * Delivery glue (§12.6 Issue 同步, TSK-补2, §10.5 webhooks): platform_wins issue sync that is
 * convergent and re-entrant, cancellation cleanup with retry, GitLab webhook intake.
 */
export function createDelivery(d: { config: Config; db: Database; audit: Audit; events: Events; jobs: Jobs; identity: Identity; repos: Repos; workspaces: Workspaces }) {
  const { db } = d;

  const consumer: Consumer = {
    name: "delivery",
    types: ["task.created", "task.updated", "task.status_changed", "mr.opened", "repo.bound"],
    async handle(e: DomainEvent) {
      const p = e.payload as { taskId?: string; to?: string; projectId?: string };
      if (e.type === "repo.bound" && p.projectId) {
        // Back-fill issues for open tasks of a project that just got its first repo.
        const open = await db.root.select({ id: task.id, status: task.status }).from(task).where(eq(task.projectId, p.projectId));
        for (const t of open) if (!["done", "cancelled"].includes(t.status)) await enqueueSync(e.tenantId, t.id, e.seq);
        return;
      }
      if (!p.taskId) return;
      await enqueueSync(e.tenantId, p.taskId, e.seq);
      if (e.type === "task.status_changed" && p.to === "cancelled")
        await d.jobs.enqueue("task.cleanup", { taskId: p.taskId }, { tenantId: e.tenantId, dedupeKey: `cleanup:${p.taskId}`, maxAttempts: 8 });
    },
  };

  async function enqueueSync(tenantId: string, taskId: string, seq: number) {
    // One sync per triggering event (a sync already *running* must not swallow a later change);
    // serialized per task, and convergent, so extra runs are harmless.
    await d.jobs.enqueue("issue.sync", { taskId }, { tenantId, dedupeKey: `issue:${taskId}:${seq}`, concurrencyKey: `issue:${taskId}`, maxAttempts: 6 });
  }

  /**
   * Convergent sync (TRAP-9): running it any number of times yields the same issue — found by
   * iid, else by marker label — with title/description/labels/state derived from the task.
   */
  async function syncIssue(taskId: string, opts: { forceClosed?: boolean } = {}) {
    const [t] = await db.root.select().from(task).where(eq(task.id, taskId));
    if (!t) return { skipped: "no_task" };
    const repos = await d.repos.projectRepos(t.projectId);
    const r = repos[0];
    if (!r) return { skipped: "no_repo" };
    if (r.status === "credential_invalid") return { skipped: "credential_invalid" };
    const key = await d.repos.projectKey(t.projectId);
    const scm = await d.repos.scmFor(r);
    const iid = t.issueRef ? Number(t.issueRef.replace(/^#/, "")) : null;
    // The merge queue closes the issue as part of merging, just before the task moves to done.
    const terminal = t.status === "done" || t.status === "cancelled" || Boolean(opts.forceClosed);
    const description = [
      t.description,
      "",
      "### 验收标准",
      ...t.acceptanceCriteria.map((c) => `- [${c.verdict === "met" ? "x" : " "}] ${c.text}`),
      "",
      `平台任务：${d.config.publicUrl}/tasks/${t.id}（以平台为准；在此处修改标题/描述不会覆盖平台）`,
    ].join("\n");
    try {
      const issue = await scm.upsertIssue({
        iid,
        marker: issueMarker(key, t.number),
        title: `${key}-${t.number} ${t.title}`,
        description,
        labels: [
          `status::${opts.forceClosed ? STATUS_LABELS.done : STATUS_LABELS[t.status as TaskStatus]}`,
          `priority::${t.priority}`,
          `type::${t.type}`,
          ...(t.status === "cancelled" ? ["取消"] : []),
        ],
        state: terminal ? "closed" : "opened",
      });
      if (t.issueRef !== issue.ref || t.issueUrl !== issue.url) {
        const sys = await d.identity.systemCtx(t.tenantId);
        await db.tx(async (q) => {
          // Metadata only: no version bump, so it never conflicts with a human edit (If-Match).
          await q.update(task).set({ issueRef: issue.ref, issueUrl: issue.url }).where(eq(task.id, t.id));
          await d.events.emit(sys, {
            type: "issue.synced",
            aggregateType: "task",
            aggregateId: t.id,
            payload: { projectId: t.projectId, taskId: t.id, issueRef: issue.ref },
            idempotencyKey: `issue:${t.id}:${issue.ref}`,
          });
        });
      }
      return { issue: issue.ref, state: issue.state };
    } catch (e) {
      await d.repos.onAuthError(r, e);
      throw e;
    }
  }

  /** TSK-补2: close MRs (branch kept), release workspaces; each step retried until it sticks. Status stays cancelled regardless. */
  async function cleanupCancelled(taskId: string) {
    const [t] = await db.root.select().from(task).where(eq(task.id, taskId));
    if (!t || t.status !== "cancelled") return { skipped: true };
    const sys = await d.identity.systemCtx(t.tenantId);
    const errors: string[] = [];
    for (const ws of await d.workspaces.forTask(taskId)) {
      const r = await d.repos.byId(ws.repoId);
      if (ws.mrRef && r) {
        try {
          const scm = await d.repos.scmFor(r);
          await scm.closeMr(Number(ws.mrRef.replace(/^!/, "")));
          await scm.addNote("mr", Number(ws.mrRef.replace(/^!/, "")), "任务已在平台取消，MR 关闭；分支保留。").catch(() => undefined);
        } catch (e) {
          errors.push(`关闭 MR 失败：${(e as Error).message.slice(0, 100)}`);
        }
      }
      try {
        await d.workspaces.release(sys, ws, "任务取消");
      } catch (e) {
        errors.push(`回收工作区失败：${(e as Error).message.slice(0, 100)}`);
      }
    }
    await d.audit.write(sys, { action: "task.cleanup", resourceType: "task", resourceId: t.id, projectId: t.projectId, outcome: errors.length ? "denied" : "allowed", after: { errors } });
    if (errors.length) throw new Error(errors.join("；"));
    return { ok: true };
  }

  /* ───────────── GitLab webhooks (§10.5) ───────────── */

  /**
   * Handles one verified delivery. Idempotent (INV-16): pipeline updates are monotonic, comments
   * carry the GitLab note id / event uuid as external id. Loop-back: our own bot's actions are ignored.
   */
  async function onGitLabEvent(r: RepoRow, kind: string, uuid: string | null, body: Record<string, unknown>) {
    const bot = d.repos.settingsOf(r).botUserId;
    const user = (body.user as { id?: number } | undefined)?.id ?? (body.object_attributes as { author_id?: number } | undefined)?.author_id;
    if (bot && user !== undefined && String(user) === bot && kind !== "Pipeline Hook") return { ignored: "loopback" };
    const attrs = (body.object_attributes ?? {}) as Record<string, unknown>;
    if (kind === "Pipeline Hook") {
      const sha = asText(attrs.sha);
      const ref = asText(attrs.ref);
      const [ws] = await db.root
        .select()
        .from(workspace)
        .where(and(eq(workspace.repoId, r.id), eq(workspace.branch, ref)));
      if (!ws) return { ignored: "no_workspace" };
      const map: Record<string, "pending" | "running" | "success" | "failed" | "canceled"> = {
        pending: "pending",
        created: "pending",
        running: "running",
        success: "success",
        failed: "failed",
        canceled: "canceled",
        skipped: "canceled",
      };
      const status = map[String(attrs.status)] ?? "pending";
      return d.workspaces.applyCi(ws.id, { sha, status, pipelineId: asText(attrs.id), url: typeof attrs.url === "string" ? attrs.url : undefined });
    }
    const issueIid = kind === "Issue Hook" ? Number(attrs.iid) : kind === "Note Hook" && body.issue ? Number((body.issue as { iid?: number }).iid) : null;
    if (!issueIid) return { ignored: kind };
    const [t] = await db.root
      .select()
      .from(task)
      .where(and(eq(task.projectId, r.projectId), eq(task.issueRef, `#${issueIid}`)));
    if (!t) return { ignored: "no_task" };
    const sys = await d.identity.systemCtx(t.tenantId);
    let body2: string | null = null;
    let externalId: string | null = null;
    if (kind === "Note Hook") {
      externalId = `gitlab-note:${asText(attrs.id)}`;
      const author = (body.user as { name?: string } | undefined)?.name ?? "GitLab 用户";
      body2 = `【GitLab 评论 · ${author}】${asText(attrs.note).slice(0, 4000)}`;
    } else if (kind === "Issue Hook" && attrs.action === "update") {
      const changes = (body.changes ?? {}) as Record<string, unknown>;
      const fields = ["title", "description"].filter((f) => f in changes);
      if (!fields.length) return { ignored: "no_relevant_change" };
      externalId = `gitlab-issue-edit:${uuid ?? `${asText(attrs.id)}:${asText(attrs.updated_at)}`}`;
      // platform_wins: GitLab-side edits come back as a hint, never overwrite the task.
      body2 = `GitLab 侧修改了 Issue 的${fields.map((f) => (f === "title" ? "标题" : "描述")).join("、")}；平台以任务为准，如需采用请在平台编辑任务。`;
    }
    if (!body2 || !externalId) return { ignored: kind };
    const [dup] = await db.root
      .select({ id: taskComment.id })
      .from(taskComment)
      .where(and(eq(taskComment.taskId, t.id), eq(taskComment.source, "gitlab"), eq(taskComment.externalId, externalId)));
    if (dup) return { ignored: "duplicate" };
    const cid = newId("tcm");
    await db.tx(async (q) => {
      await q.insert(taskComment).values({ id: cid, tenantId: t.tenantId, taskId: t.id, authorPrincipalId: sys.actor.principalId, body: body2!, source: "gitlab", externalId });
      await d.events.emit(sys, {
        type: "task.comment_added",
        aggregateType: "task",
        aggregateId: t.id,
        payload: { projectId: t.projectId, taskId: t.id, commentId: cid },
        idempotencyKey: externalId!,
      });
    });
    return { commented: cid };
  }

  async function handleWebhook(repoId: string, headers: Headers, body: unknown) {
    const r = await d.repos.verifyWebhook(repoId, headers.get("x-gitlab-token"));
    if (!r) return { status: 401 as const, body: { ok: false } };
    const kind = headers.get("x-gitlab-event") ?? "";
    const uuid = headers.get("x-gitlab-event-uuid");
    try {
      const res = await onGitLabEvent(r, kind, uuid, (body ?? {}) as Record<string, unknown>);
      return { status: 200 as const, body: { ok: true, result: res } };
    } catch (e) {
      log.warn("webhook.failed", { repoId, kind, err: (e as Error).message.slice(0, 200) });
      return { status: 500 as const, body: { ok: false } };
    }
  }

  return { consumer, syncIssue, cleanupCancelled, onGitLabEvent, handleWebhook, enqueueSync };
}
export type Delivery = ReturnType<typeof createDelivery>;
