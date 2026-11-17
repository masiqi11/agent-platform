import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_PROJECT_SETTINGS, findSecrets, type ProjectSettings } from "@ap/shared";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Audit } from "../../core/audit";
import type { Ctx } from "../../core/context";
import { DomainError, notFound } from "../../core/errors";
import type { Events } from "../../core/events";
import { newId } from "../../core/ids";
import type { createJobs } from "../../core/jobs";
import { log, redactValue } from "../../core/logger";
import type { ObjectStore } from "../../core/object-store";
import type { Config } from "../../config";
import type { Database } from "../../db";
import { agent, appUser, artifact, principal, project, repo, task, taskOwner, workspace } from "../../db/schema";
import type { Identity } from "../identity/service";
import type { Repos, RepoRow } from "../repos/service";
import type { ExecResult, Sandbox } from "../sandbox/service";
import { git } from "../scm/service";
import { TERMINAL_PIPELINE, type PipelineStatus } from "../scm/service";

type Jobs = ReturnType<typeof createJobs>;
export type WorkspaceRow = typeof workspace.$inferSelect;
type TaskRow = typeof task.$inferSelect;
type AgentRow = typeof agent.$inferSelect;

export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
  paths: string[];
  /** GIT-补7: change too large or touching sensitive paths → a human must review, whatever mergePolicy says. */
  humanReviewRequired?: boolean;
  reasons?: string[];
}

/** Disk watermark for the workspaces volume (GIT-补9). */
export const DISK_WARN_RATIO = 0.9;

/** Pure: GIT-补7 change-scope guard. */
export function scopeGuard(
  stat: Omit<DiffStat, "humanReviewRequired" | "reasons">,
  settings: Pick<ProjectSettings, "sensitivePaths" | "changeLimits">,
): { humanReviewRequired: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (stat.files > settings.changeLimits.files) reasons.push(`改动文件数 ${stat.files} 超过上限 ${settings.changeLimits.files}`);
  if (stat.additions + stat.deletions > settings.changeLimits.lines) reasons.push(`改动行数 ${stat.additions + stat.deletions} 超过上限 ${settings.changeLimits.lines}`);
  const hit = stat.paths.filter((p) => settings.sensitivePaths.some((s) => (s.endsWith("/") ? p.startsWith(s) || p.includes(`/${s}`) : p === s || p.endsWith(`/${s}`))));
  if (hit.length) reasons.push(`触及敏感路径：${hit.slice(0, 5).join("、")}`);
  return { humanReviewRequired: reasons.length > 0, reasons };
}

/** Pure: GIT-补8 — secrets in *added* lines of a unified diff. */
export function scanDiffForSecrets(diff: string): string[] {
  const added = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
  return findSecrets(added).map((h) => `${h.slice(0, 6)}…（${h.length} 字符）`);
}

export class SecretDetected extends DomainError {
  constructor(readonly hits: string[]) {
    super("conflict", `推送被阻止：改动中疑似包含密钥（${hits.length} 处）`, { hits });
  }
}

/**
 * Workspaces & CI (§12.7, FR-GIT-01/02/04/07/08, GIT-补1/7/8/9, TRAP-7). Git runs on the host
 * (control plane) with per-call credentials; agent commands run in the sandbox without any.
 */
export function createWorkspaces(d: { config: Config; db: Database; audit: Audit; events: Events; identity: Identity; repos: Repos; sandbox: Sandbox; objectStore: ObjectStore; jobs: Jobs }) {
  const { db } = d;
  const root = resolve(d.config.dirs.workspaces);
  const mirrorDir = (r: RepoRow) => join(resolve(d.config.dirs.repoCache), `${r.id}.git`);
  /** In-process serialization of mirror syncs per repo (see syncMirror). */
  const mirrorLocks = new Map<string, Promise<string>>();

  async function settingsOf(projectId: string): Promise<ProjectSettings> {
    const [p] = await db.root.select({ settings: project.settings }).from(project).where(eq(project.id, projectId));
    return { ...DEFAULT_PROJECT_SETTINGS, ...((p?.settings ?? {}) as Partial<ProjectSettings>) };
  }

  /**
   * Mirror cache (§12.7): one bare mirror per repo, refreshed before creating workspaces.
   * Several jobs sync the same repo at once (e.g. kb.index and dev.turn right after binding): syncs
   * of one repo are serialized in-process, and a first clone goes to a private directory that is
   * renamed into place, so concurrent workers never clone into the same path.
   */
  function syncMirror(r: RepoRow): Promise<string> {
    const prev = mirrorLocks.get(r.id) ?? Promise.resolve("");
    const next = prev.catch(() => "").then(() => syncMirrorNow(r));
    mirrorLocks.set(r.id, next);
    void next
      .finally(() => {
        if (mirrorLocks.get(r.id) === next) mirrorLocks.delete(r.id);
      })
      .catch(() => undefined);
    return next;
  }

  async function syncMirrorNow(r: RepoRow) {
    const scm = await d.repos.scmFor(r);
    const remote = await scm.gitRemote();
    try {
      const dir = mirrorDir(r);
      const fetch = () => git(["fetch", "-q", "--prune", remote.url, "+refs/heads/*:refs/heads/*"], { cwd: dir, env: remote.env, timeoutMs: 600_000 });
      if (existsSync(join(dir, "HEAD"))) {
        await fetch();
        return dir;
      }
      await mkdir(resolve(dir, ".."), { recursive: true });
      const tmp = `${dir}.tmp-${newId("cln")}`;
      try {
        await git(["clone", "-q", "--mirror", remote.url, tmp], { cwd: "/", env: remote.env, timeoutMs: 600_000 });
        try {
          await rename(tmp, dir);
        } catch {
          // Another worker finished first: keep theirs and bring it up to date.
          await fetch();
        }
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
      return dir;
    } catch (e) {
      await d.repos.onAuthError(r, e);
      throw e;
    } finally {
      await remote.cleanup();
    }
  }

  async function load(id: string) {
    const [w] = await db.root.select().from(workspace).where(eq(workspace.id, id));
    if (!w) throw notFound("工作区");
    return w;
  }
  async function forTask(taskId: string) {
    return db.root.select().from(workspace).where(eq(workspace.taskId, taskId)).orderBy(desc(workspace.createdAt));
  }

  /** FR-GIT-02: branch from the project pattern; suffix -2, -3 … when the name is taken by someone else. */
  async function pickBranch(r: RepoRow, t: TaskRow, mirror: string, settings: ProjectSettings) {
    const key = await d.repos.projectKey(t.projectId);
    const base = (settings.branchPattern || "task/{number}").replace("{number}", String(t.number)).replace("{key}", key.toLowerCase());
    const others = await db.root
      .select({ branch: workspace.branch })
      .from(workspace)
      .where(and(eq(workspace.repoId, r.id), sql`${workspace.taskId} <> ${t.id}`));
    for (let i = 1; i < 50; i++) {
      const name = i === 1 ? base : `${base}-${i}`;
      const exists = (await git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { cwd: mirror, allowFail: true })).ok;
      if (!exists && !others.some((o) => o.branch === name)) return name;
    }
    throw new DomainError("conflict", "无法分配分支名");
  }

  /**
   * Creates (or recreates after release) the task workspace on one repo. Idempotent per
   * (task, repo): a second call returns the ready workspace (FR-GIT-01).
   */
  async function ensure(ctx: Ctx, t: TaskRow, r: RepoRow): Promise<WorkspaceRow> {
    const [existing] = await db.root
      .select()
      .from(workspace)
      .where(and(eq(workspace.taskId, t.id), eq(workspace.repoId, r.id)));
    if (existing?.status === "ready" && existing.worktreePath && existsSync(join(existing.worktreePath, ".git"))) return existing;
    const settings = await settingsOf(t.projectId);
    const mirror = await syncMirror(r);
    const branch = existing?.branch ?? (await pickBranch(r, t, mirror, settings));
    const path = join(root, t.tenantId, t.id, r.name);
    const id = existing?.id ?? newId("wsp");
    if (!existing)
      await db.root.insert(workspace).values({ id, tenantId: t.tenantId, taskId: t.id, repoId: r.id, branch, status: "creating", worktreePath: path, workerId: null }).onConflictDoNothing();
    await rm(path, { recursive: true, force: true });
    await mkdir(resolve(path, ".."), { recursive: true });
    await git(["clone", "-q", "--no-hardlinks", mirror, path], { cwd: "/" });
    const remoteHas = (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: mirror, allowFail: true })).ok;
    // Reuse the pushed branch (reassignment / recreate, TSK-补3); otherwise branch off the default branch.
    if (remoteHas) await git(["checkout", "-q", "-B", branch, `origin/${branch}`], { cwd: path });
    else await git(["checkout", "-q", "-b", branch, `origin/${r.defaultBranch}`], { cwd: path });
    const baseCommit = existing?.baseCommit ?? (await git(["rev-parse", `origin/${r.defaultBranch}`], { cwd: path })).out;
    const head = (await git(["rev-parse", "HEAD"], { cwd: path })).out;
    // Never let the agent see a remote URL with credentials: origin points at the local mirror only.
    await db.tx(async () => {
      await db
        .q()
        .update(workspace)
        .set({ status: "ready", worktreePath: path, baseCommit, headCommit: existing?.headCommit ?? head, workerId: d.config.role, updatedAt: new Date() })
        .where(eq(workspace.id, id));
      if (!existing || existing.status === "released")
        await d.events.emit(ctx, { type: "workspace.created", aggregateType: "workspace", aggregateId: id, payload: { projectId: t.projectId, taskId: t.id, workspaceId: id, repoId: r.id, branch } });
      await d.audit.write(ctx, {
        action: "workspace.create",
        resourceType: "workspace",
        resourceId: id,
        projectId: t.projectId,
        after: { taskId: t.id, repoId: r.id, branch, base: baseCommit.slice(0, 12) },
      });
    });
    return load(id);
  }

  /** GIT-补1: agent identity as author; task ref and human owners as trailers. Never a human as author. */
  async function commitIdentity(a: AgentRow, t: TaskRow) {
    const host = new URL(d.config.publicUrl).hostname || "agents.local";
    const owners = await db.root
      .select({ name: appUser.name, email: appUser.email })
      .from(taskOwner)
      .innerJoin(principal, eq(principal.id, taskOwner.principalId))
      .innerJoin(appUser, eq(appUser.id, principal.refId))
      .where(and(eq(taskOwner.taskId, t.id), eq(taskOwner.role, "owner")));
    const key = await d.repos.projectKey(t.projectId);
    return {
      name: a.name,
      email: `${a.id}@agents.${host}`,
      trailers: [`Task: ${key}-${t.number}`, ...owners.map((o) => `Co-authored-by: ${o.name} <${o.email}>`)],
    };
  }

  async function diffStatOf(ws: WorkspaceRow, settings: ProjectSettings): Promise<DiffStat> {
    const out = (await git(["diff", "--numstat", `${ws.baseCommit}..HEAD`], { cwd: ws.worktreePath! })).out;
    const rows = out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"));
    const stat = {
      files: rows.length,
      additions: rows.reduce((n, r) => n + (Number(r[0]) || 0), 0),
      deletions: rows.reduce((n, r) => n + (Number(r[1]) || 0), 0),
      paths: rows.map((r) => r[2] ?? "").slice(0, 200),
    };
    return { ...stat, ...scopeGuard(stat, settings) };
  }

  /** Stages everything and commits as the agent. Returns null when there is nothing to commit. */
  async function commit(ctx: Ctx, ws: WorkspaceRow, a: AgentRow, t: TaskRow, message: string) {
    const cwd = ws.worktreePath!;
    if (ws.status !== "ready") throw new DomainError("conflict", "工作区不可用");
    await git(["add", "-A"], { cwd });
    const staged = (await git(["diff", "--cached", "--name-only"], { cwd })).out;
    if (!staged) return null;
    const id = await commitIdentity(a, t);
    const msg = `${message.trim().slice(0, 2000)}\n\n${id.trailers.join("\n")}\n`;
    await git(["-c", `user.name=${id.name}`, "-c", `user.email=${id.email}`, "commit", "-q", "-m", msg], { cwd });
    const sha = (await git(["rev-parse", "HEAD"], { cwd })).out;
    const stat = await diffStatOf(ws, await settingsOf(t.projectId));
    await db.root.update(workspace).set({ headCommit: sha, diffStat: stat, updatedAt: new Date() }).where(eq(workspace.id, ws.id));
    await d.audit.write(ctx, { action: "workspace.commit", resourceType: "workspace", resourceId: ws.id, projectId: t.projectId, after: { sha: sha.slice(0, 12), files: stat.files } });
    return { sha, stat, files: staged.split("\n") };
  }

  /**
   * Push (INV-10, GIT-补8): never to the default/protected branch; diff scanned for secrets first;
   * idempotent — re-pushing the same head is a no-op and emits no second event (SES-补2).
   */
  async function push(ctx: Ctx, ws: WorkspaceRow, t: TaskRow) {
    const r = (await d.repos.byId(ws.repoId))!;
    const scm = await d.repos.scmFor(r);
    const cwd = ws.worktreePath!;
    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).out;
    if (branch !== ws.branch || branch === r.defaultBranch || (await scm.isProtected(branch))) {
      await d.audit.write(ctx, {
        action: "workspace.push",
        resourceType: "workspace",
        resourceId: ws.id,
        projectId: t.projectId,
        outcome: "denied",
        after: { branch, reason: "受保护分支或非任务分支（INV-10）" },
      });
      throw new DomainError("forbidden", `不能推送到 ${branch}：开发 Agent 只能推送任务分支，合并只由合并队列执行（INV-10）`);
    }
    const diff = (await git(["diff", `${ws.baseCommit}..HEAD`], { cwd })).out;
    const hits = scanDiffForSecrets(diff);
    if (hits.length) {
      await d.audit.write(ctx, {
        action: "workspace.push",
        resourceType: "workspace",
        resourceId: ws.id,
        projectId: t.projectId,
        outcome: "denied",
        after: { reason: "secret_scan", hits: hits.length },
      });
      throw new SecretDetected(hits);
    }
    const sha = (await git(["rev-parse", "HEAD"], { cwd })).out;
    const remote = await scm.gitRemote();
    try {
      const ls = await git(["ls-remote", "--heads", remote.url, `refs/heads/${branch}`], { cwd, env: remote.env });
      const already = ls.out.split(/\s+/)[0] === sha;
      if (!already) await git(["push", "-q", remote.url, `HEAD:refs/heads/${branch}`], { cwd, env: remote.env, timeoutMs: 300_000 });
      const settings = await settingsOf(t.projectId);
      const stat = await diffStatOf(ws, settings);
      const patch = await d.objectStore.put(`patches/${t.tenantId}/${t.id}/${sha}.patch`, redactValue(diff));
      await db.tx(async () => {
        await db.q().update(workspace).set({ headCommit: sha, diffStat: stat, updatedAt: new Date() }).where(eq(workspace.id, ws.id));
        if (!already) {
          await db
            .q()
            .insert(artifact)
            .values({
              id: newId("art"),
              tenantId: t.tenantId,
              taskId: t.id,
              kind: "patch",
              name: `${sha.slice(0, 8)}.patch`,
              uri: patch.uri,
              sha256: patch.sha256,
              size: patch.size,
              createdBy: ctx.actor.principalId,
            });
          await d.events.emit(ctx, {
            type: "commit.pushed",
            aggregateType: "workspace",
            aggregateId: ws.id,
            payload: { projectId: t.projectId, taskId: t.id, workspaceId: ws.id, sha, branch, humanReviewRequired: Boolean(stat.humanReviewRequired) },
            idempotencyKey: `push:${ws.id}:${sha}`,
          });
          await d.audit.write(ctx, {
            action: "workspace.push",
            resourceType: "workspace",
            resourceId: ws.id,
            projectId: t.projectId,
            after: { branch, sha: sha.slice(0, 12), files: stat.files, scope: stat.reasons ?? [] },
          });
        }
      });
      // A push after the MR exists re-runs CI for the new head (§12.7 "推送后若已有 MR，自动入队 CI").
      const fresh = await load(ws.id);
      if (fresh.mrRef) await startCi(fresh, sha);
      return { sha, branch, pushed: !already, stat };
    } catch (e) {
      if (await d.repos.onAuthError(r, e)) throw new DomainError("upstream_unavailable", "仓库凭据无效，已通知 Maintainer");
      throw e;
    } finally {
      await remote.cleanup();
    }
  }

  /** FR-GIT-04: MR description carries the task link and acceptance criteria. Reuses an open MR (TRAP-9). */
  async function openMr(ctx: Ctx, ws: WorkspaceRow, t: TaskRow, title?: string) {
    if (!ws.headCommit || ws.headCommit === ws.baseCommit) throw new DomainError("conflict", "分支上还没有提交，不能创建 MR");
    const r = (await d.repos.byId(ws.repoId))!;
    const scm = await d.repos.scmFor(r);
    const key = await d.repos.projectKey(t.projectId);
    const ref = `${key}-${t.number}`;
    const body = [
      `任务：[${ref}](${d.config.publicUrl}/tasks/${t.id}) ${t.title}`,
      t.issueRef ? `关联 Issue：${t.issueRef}${t.issueUrl ? ` ${t.issueUrl}` : ""}` : "",
      "",
      "### 验收标准",
      ...t.acceptanceCriteria.map((c) => `- [ ] ${c.text}`),
      "",
      "_由平台开发 Agent 创建；合并只由平台合并队列执行。_",
    ]
      .filter((x) => x !== null)
      .join("\n");
    try {
      const mr = await scm.openMr({ sourceBranch: ws.branch, targetBranch: r.defaultBranch, title: (title ?? `${ref} ${t.title}`).slice(0, 200), description: body });
      await db.tx(async () => {
        await db.q().update(workspace).set({ mrRef: mr.ref, mrUrl: mr.url, updatedAt: new Date() }).where(eq(workspace.id, ws.id));
        if (!ws.mrRef) {
          await d.events.emit(ctx, {
            type: "mr.opened",
            aggregateType: "workspace",
            aggregateId: ws.id,
            payload: { projectId: t.projectId, taskId: t.id, workspaceId: ws.id, mrRef: mr.ref, reused: mr.reused },
            idempotencyKey: `mr:${ws.id}:${mr.iid}`,
          });
          await d.audit.write(ctx, { action: "workspace.open_mr", resourceType: "workspace", resourceId: ws.id, projectId: t.projectId, after: { mr: mr.ref, reused: mr.reused } });
        }
      });
      const fresh = await load(ws.id);
      if (fresh.headCommit && (!fresh.ci || fresh.ci.sha !== fresh.headCommit)) await startCi(fresh, fresh.headCommit);
      return { ...mr, workspace: fresh };
    } catch (e) {
      if (await d.repos.onAuthError(r, e)) throw new DomainError("upstream_unavailable", "仓库凭据无效，已通知 Maintainer");
      throw e;
    }
  }

  /* ───────────── CI (TRAP-7, TRAP-8 precondition) ───────────── */

  /** Local provider: record a pipeline and queue the run. GitLab: CI starts on push; we poll as a fallback. */
  async function startCi(ws: WorkspaceRow, sha: string) {
    const r = (await d.repos.byId(ws.repoId))!;
    if (r.provider === "local") {
      const existing = await d.repos.localScm(r).latestPipeline(sha);
      const p = existing ?? (await d.repos.localScm(r).createPipeline(sha, ws.branch));
      await applyCi(ws.id, { sha, status: p.status === "pending" ? "running" : p.status, pipelineId: p.id, url: p.url });
      if (!existing)
        await d.jobs.enqueue("ci.local_run", { workspaceId: ws.id, pipelineId: p.id, sha }, { tenantId: ws.tenantId, dedupeKey: `ci:${p.id}`, concurrencyKey: `ci:${r.id}`, maxAttempts: 2 });
    } else {
      await applyCi(ws.id, { sha, status: "pending" });
      await d.jobs.enqueue("ci.poll", { workspaceId: ws.id, sha }, { tenantId: ws.tenantId, dedupeKey: `cipoll:${ws.id}:${sha}`, runAt: new Date(Date.now() + 15_000) });
    }
  }

  /**
   * The only writer of workspace.ci. Monotonic per sha (TRAP-7): a terminal status is never
   * downgraded by a late poll; duplicate webhook/poll reports are no-ops; reports for an old
   * sha are ignored. Emits pipeline.completed once per (sha, terminal status).
   */
  async function applyCi(workspaceId: string, rep: { sha: string; status: PipelineStatus; pipelineId?: string; url?: string }) {
    return db.tx(async (q) => {
      const [ws] = await q.select().from(workspace).where(eq(workspace.id, workspaceId)).for("update");
      if (!ws) return { changed: false, reason: "no_workspace" };
      if (ws.headCommit && rep.sha !== ws.headCommit) return { changed: false, reason: "stale_sha" };
      const cur = ws.ci as { status: PipelineStatus; sha: string; pipelineId?: string } | null;
      if (cur && cur.sha === rep.sha) {
        if (cur.status === rep.status) return { changed: false, reason: "duplicate" };
        const curTerminal = TERMINAL_PIPELINE.includes(cur.status);
        if (curTerminal && !TERMINAL_PIPELINE.includes(rep.status)) return { changed: false, reason: "no_downgrade" };
        // A different terminal result for the same sha is accepted only from a *new* pipeline (retry, GIT-补5).
        if (curTerminal && (!rep.pipelineId || rep.pipelineId === cur.pipelineId)) return { changed: false, reason: "terminal_kept" };
      }
      const terminal = TERMINAL_PIPELINE.includes(rep.status);
      await q
        .update(workspace)
        .set({
          ci: {
            status: rep.status,
            sha: rep.sha,
            ...(rep.url ? { url: rep.url } : {}),
            ...(rep.pipelineId ? { pipelineId: rep.pipelineId } : {}),
            ...(terminal ? { finishedAt: new Date().toISOString() } : {}),
          },
          updatedAt: new Date(),
        })
        .where(eq(workspace.id, workspaceId));
      if (terminal) {
        const [t] = await q.select({ projectId: task.projectId }).from(task).where(eq(task.id, ws.taskId));
        const sys = await d.identity.systemCtx(ws.tenantId);
        await d.events.emit(sys, {
          type: "pipeline.completed",
          aggregateType: "workspace",
          aggregateId: ws.id,
          payload: { projectId: t?.projectId ?? null, taskId: ws.taskId, workspaceId: ws.id, sha: rep.sha, status: rep.status, pipelineId: rep.pipelineId ?? null },
          idempotencyKey: `ci:${ws.id}:${rep.sha}:${rep.status}:${rep.pipelineId ?? ""}`,
        });
      }
      return { changed: true, reason: "ok" };
    });
  }

  /** Local CI runner: fresh checkout of the pushed sha, repo test command in the sandbox, log as evidence. */
  /** Runs the repo test command on one sha in the sandbox (fresh checkout from the local bare repo); returns status + redacted log. */
  async function execPipeline(r: RepoRow, sha: string) {
    const dir = await mkdtemp(join(tmpdir(), "ap-ci-"));
    let res: ExecResult | null = null;
    let status: PipelineStatus = "failed";
    let logText = "";
    try {
      await git(["clone", "-q", r.url, dir], { cwd: "/" });
      // Rebased merge-queue commits live under refs/merge-queue/* (not fetched by a plain clone).
      await git(["fetch", "-q", "origin", "+refs/merge-queue/*:refs/remotes/mq/*"], { cwd: dir, allowFail: true });
      await git(["checkout", "-q", sha], { cwd: dir });
      const cmd = d.repos.settingsOf(r).testCommand || "bun test";
      res = await d.sandbox.exec({ cwd: dir, cmd, image: d.repos.settingsOf(r).image, timeoutMs: d.config.sandbox.timeoutMs });
      status = res.code === 0 ? "success" : "failed";
      logText = `$ ${cmd}\n${res.log}${res.killed ? `\n[killed: ${res.killed}]` : ""}\n[exit ${res.code}] ${res.durationMs} ms (${res.sandbox}${res.imageDigest ? ` ${res.imageDigest.slice(0, 19)}` : ""})`;
    } catch (e) {
      logText = `CI 执行出错：${(e as Error).message}`;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return { status, log: redactValue(logText), durationMs: res?.durationMs ?? 0 };
  }

  /** Local CI runner: fresh checkout of the pushed sha, repo test command in the sandbox, log as evidence. */
  async function runLocalCi(p: { workspaceId: string; pipelineId: string; sha: string }) {
    const ws = await load(p.workspaceId);
    const r = (await d.repos.byId(ws.repoId))!;
    const scm = d.repos.localScm(r);
    const { status, log: safe, durationMs } = await execPipeline(r, p.sha);
    const obj = await d.objectStore.put(`ci/${ws.tenantId}/${ws.id}/${p.pipelineId}.log`, safe);
    const sys = await d.identity.systemCtx(ws.tenantId);
    await db.root.insert(artifact).values({
      id: newId("art"),
      tenantId: ws.tenantId,
      taskId: ws.taskId,
      kind: "log",
      name: `CI ${p.sha.slice(0, 8)}.log`,
      uri: obj.uri,
      sha256: obj.sha256,
      size: obj.size,
      createdBy: sys.actor.principalId,
    });
    await scm.finishPipeline(p.pipelineId, status, safe);
    await applyCi(ws.id, { sha: p.sha, status, pipelineId: p.pipelineId });
    return { status, durationMs };
  }

  /**
   * CI for a sha that is not a task head: the merge queue's rebased commit, or the default branch
   * after a merge (GIT-补4). Emits pipeline.completed with `purpose` so the queue can react.
   */
  async function runShaPipeline(p: { repoId: string; pipelineId: string; sha: string; purpose: "merge_queue" | "main"; projectId: string; itemId?: string; taskId?: string }) {
    const r = (await d.repos.byId(p.repoId))!;
    const { status, log: safe } = await execPipeline(r, p.sha);
    const sys = await d.identity.systemCtx(r.tenantId);
    const obj = await d.objectStore.put(`ci/${r.tenantId}/${p.purpose}/${p.pipelineId}.log`, safe);
    await db.root.insert(artifact).values({
      id: newId("art"),
      tenantId: r.tenantId,
      taskId: p.taskId ?? null,
      kind: "log",
      name: `CI ${p.purpose === "main" ? "主干" : "合并队列"} ${p.sha.slice(0, 8)}.log`,
      uri: obj.uri,
      sha256: obj.sha256,
      size: obj.size,
      createdBy: sys.actor.principalId,
    });
    await d.repos.localScm(r).finishPipeline(p.pipelineId, status, safe);
    await d.events.emit(sys, {
      type: "pipeline.completed",
      aggregateType: "repo",
      aggregateId: r.id,
      payload: { projectId: p.projectId, repoId: r.id, sha: p.sha, status, pipelineId: p.pipelineId, purpose: p.purpose, itemId: p.itemId ?? null },
      idempotencyKey: `ci:${r.id}:${p.pipelineId}:${status}`,
    });
    return { status };
  }

  /** GitLab polling fallback when webhooks are missing/late (§12.7). */
  async function pollCi(p: { workspaceId: string; sha: string }) {
    const ws = await load(p.workspaceId);
    if (ws.status === "released" || ws.headCommit !== p.sha) return { done: true };
    const cur = ws.ci as { status: PipelineStatus; sha: string } | null;
    if (cur?.sha === p.sha && TERMINAL_PIPELINE.includes(cur.status)) return { done: true };
    const r = (await d.repos.byId(ws.repoId))!;
    try {
      const pl = await (await d.repos.scmFor(r)).latestPipeline(p.sha);
      if (pl) await applyCi(ws.id, { sha: pl.sha, status: pl.status, pipelineId: pl.id, url: pl.url });
      return { done: Boolean(pl && TERMINAL_PIPELINE.includes(pl.status)) };
    } catch (e) {
      await d.repos.onAuthError(r, e);
      throw e;
    }
  }

  /**
   * Independent checkout for review / test (§12.7): reviewer and tester never share the dev's working
   * directory, and test against exactly the commit their conclusion will be bound to.
   */
  async function checkout(t: TaskRow, r: RepoRow, sha: string, purpose: "review" | "test") {
    const mirror = await syncMirror(r);
    const dir = join(root, t.tenantId, t.id, `${r.name}.${purpose}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(resolve(dir, ".."), { recursive: true });
    await git(["clone", "-q", "--no-hardlinks", mirror, dir], { cwd: "/" });
    await git(["checkout", "-q", "--detach", sha], { cwd: dir });
    return dir;
  }
  /** FR-REL-02: the test environment is destroyed when the run ends. */
  async function dropCheckout(dir: string) {
    if (dir.startsWith(root + "/") && /\.(review|test)$/.test(dir)) await rm(dir, { recursive: true, force: true });
  }

  /** FR-GIT-07: remove the directory (and container), keep the branch and the record. */
  async function release(ctx: Ctx, ws: WorkspaceRow, reason: string) {
    if (ws.worktreePath) await rm(ws.worktreePath, { recursive: true, force: true });
    if (ws.status === "released") return;
    await db.tx(async () => {
      await db.q().update(workspace).set({ status: "released", containerId: null, updatedAt: new Date() }).where(eq(workspace.id, ws.id));
      await d.events.emit(ctx, { type: "workspace.released", aggregateType: "workspace", aggregateId: ws.id, payload: { taskId: ws.taskId, workspaceId: ws.id, reason: reason.slice(0, 60) } });
      await d.audit.write(ctx, { action: "workspace.release", resourceType: "workspace", resourceId: ws.id, after: { reason } });
    });
  }

  /**
   * GIT-补9 / SBX-10: release workspaces of finished tasks, delete directories with no live
   * workspace record, remove leftover sandbox containers, and warn on the disk watermark.
   */
  async function sweep() {
    let released = 0;
    let orphans = 0;
    const finished = await db.root
      .select({ ws: workspace })
      .from(workspace)
      .innerJoin(task, eq(task.id, workspace.taskId))
      .where(and(inArray(task.status, ["done", "cancelled"]), notInArray(workspace.status, ["released"])));
    for (const { ws } of finished) {
      await release(await d.identity.systemCtx(ws.tenantId), ws, "任务已结束");
      released++;
    }
    if (existsSync(root)) {
      const live = new Set(
        (
          await db.root
            .select({ p: workspace.worktreePath })
            .from(workspace)
            .where(notInArray(workspace.status, ["released"]))
        )
          .map((x) => x.p)
          .filter((x): x is string => Boolean(x)),
      );
      for (const tenantDir of await readdir(root).catch(() => [])) {
        for (const taskDir of await readdir(join(root, tenantDir)).catch(() => [])) {
          for (const repoDir of await readdir(join(root, tenantDir, taskDir)).catch(() => [])) {
            const p = join(root, tenantDir, taskDir, repoDir);
            // Review/test checkouts are short-lived; only reclaim ones left behind for over 2 h.
            if (
              /\.(review|test)$/.test(repoDir) &&
              Date.now() -
                (await stat(p)
                  .then((x) => x.mtimeMs)
                  .catch(() => 0)) <
                2 * 3600_000
            )
              continue;
            if (!live.has(p)) {
              await rm(p, { recursive: true, force: true });
              orphans++;
            }
          }
          if (!(await readdir(join(root, tenantDir, taskDir)).catch(() => ["x"])).length) await rm(join(root, tenantDir, taskDir), { recursive: true, force: true });
        }
      }
    }
    const containers = await d.sandbox.sweep().catch(() => 0);
    const disk = await diskUsage();
    if (disk && disk.usedRatio > DISK_WARN_RATIO) log.warn("workspaces.disk_watermark", { usedRatio: disk.usedRatio });
    return { released, orphans, containers, disk };
  }

  async function diskUsage() {
    try {
      await mkdir(root, { recursive: true });
      const s = await statfs(root);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      return { totalBytes: total, freeBytes: free, usedRatio: total ? Number((1 - free / total).toFixed(3)) : 0 };
    } catch {
      return null;
    }
  }

  /** Runs a command in the sandbox inside the workspace (no credentials, SBX-07). */
  async function exec(ws: WorkspaceRow, cmd: string, timeoutMs?: number) {
    const r = (await d.repos.byId(ws.repoId))!;
    const [t] = await db.root.select({ projectId: task.projectId }).from(task).where(eq(task.id, ws.taskId));
    const s = await settingsOf(t!.projectId);
    return d.sandbox.exec({ cwd: ws.worktreePath!, cmd, image: d.repos.settingsOf(r).image, egress: s.egressAllowlist, timeoutMs: timeoutMs ?? Math.min(d.config.sandbox.timeoutMs, 300_000) });
  }

  /** Task detail "code" view: branch / MR / CI / diff / evidence. */
  async function view(t: TaskRow) {
    const rows = await forTask(t.id);
    const repos = rows.length
      ? await db.root
          .select({ id: repo.id, name: repo.name, provider: repo.provider })
          .from(repo)
          .where(
            inArray(
              repo.id,
              rows.map((w) => w.repoId),
            ),
          )
      : [];
    const arts = await db.root.select().from(artifact).where(eq(artifact.taskId, t.id)).orderBy(desc(artifact.createdAt)).limit(50);
    return {
      workspaces: rows.map((w) => ({
        id: w.id,
        repoId: w.repoId,
        repoName: repos.find((r) => r.id === w.repoId)?.name ?? "",
        provider: repos.find((r) => r.id === w.repoId)?.provider ?? "local",
        branch: w.branch,
        baseCommit: w.baseCommit,
        headCommit: w.headCommit,
        mrRef: w.mrRef,
        mrUrl: w.mrUrl,
        ci: (w.ci as Record<string, unknown> | null) ?? null,
        diffStat: (w.diffStat as Record<string, unknown> | null) ?? null,
        status: w.status,
        updatedAt: w.updatedAt.toISOString(),
      })),
      artifacts: arts.map((a) => ({ id: a.id, kind: a.kind, name: a.name, size: a.size, sha256: a.sha256, createdAt: a.createdAt.toISOString() })),
    };
  }

  return {
    checkout,
    dropCheckout,
    ensure,
    commit,
    push,
    openMr,
    startCi,
    applyCi,
    runLocalCi,
    runShaPipeline,
    execPipeline,
    pollCi,
    release,
    sweep,
    diskUsage,
    exec,
    view,
    load,
    forTask,
    syncMirror,
    settingsOf,
  };
}
export type Workspaces = ReturnType<typeof createWorkspaces>;
