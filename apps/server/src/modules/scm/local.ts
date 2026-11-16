import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { newId } from "../../core/ids";
import type { Database } from "../../db";
import { localScmIssue, localScmMr, localScmNote, localScmPipeline } from "../../db/schema";
import { git } from "./git";
import type { AccessCheck, IssueInfo, MrInfo, PipelineInfo, PipelineStatus, Scm } from "./types";

/**
 * Server-side guard installed into local bare repos: protected branches only accept pushes from the
 * merge queue (INV-10 enforced by the "server" too, GIT-补2). The merge queue sets AP_MERGE_QUEUE=1.
 */
export const preReceiveHook = (protectedBranches: string[]) => `#!/bin/sh
# 由平台安装（勿改）：受保护分支只允许合并队列更新。
protected="${protectedBranches.join(" ")}"
while read old new ref; do
  b="\${ref#refs/heads/}"
  for p in $protected; do
    if [ "$b" = "$p" ] && [ "$AP_MERGE_QUEUE" != "1" ]; then
      echo "受保护分支 $b 只能由合并队列更新" >&2
      exit 1
    fi
  done
done
exit 0
`;

/** Creates a bare repo with an initial commit (optionally seeded from a directory) and installs the guard hook. */
export async function createLocalBareRepo(path: string, o: { defaultBranch?: string; seedDir?: string; files?: Record<string, string>; author?: string } = {}) {
  const branch = o.defaultBranch ?? "main";
  if (existsSync(path)) throw new Error(`本地仓库已存在：${path}`);
  await mkdir(path, { recursive: true });
  await git(["init", "--bare", "-b", branch, path], { cwd: "/" });
  const work = await mkdtemp(join(tmpdir(), "ap-seed-"));
  try {
    await git(["init", "-b", branch, work], { cwd: "/" });
    if (o.seedDir) await cp(o.seedDir, work, { recursive: true, filter: (src) => !src.includes("/.git") });
    for (const [rel, body] of Object.entries(o.files ?? {})) {
      await mkdir(join(work, rel, ".."), { recursive: true });
      await writeFile(join(work, rel), body);
    }
    if (!o.seedDir && !Object.keys(o.files ?? {}).length) await writeFile(join(work, "README.md"), "# repo\n");
    const id = ["-c", `user.name=${o.author ?? "平台"}`, "-c", "user.email=platform@agents.local"];
    await git([...id, "add", "-A"], { cwd: work });
    await git([...id, "commit", "-qm", "初始提交"], { cwd: work });
    await git(["push", "-q", path, `HEAD:refs/heads/${branch}`], { cwd: work });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  await installGuard(path, [branch]);
}

export async function installGuard(barePath: string, protectedBranches: string[]) {
  const hook = join(barePath, "hooks", "pre-receive");
  await writeFile(hook, preReceiveHook(protectedBranches));
  await chmod(hook, 0o755);
}

/**
 * Local SCM provider (dev / demo / offline tests): a bare repo on disk plus issue / MR / note /
 * pipeline rows in `local_scm_*`. Pipelines are recorded here and executed by the CI runner.
 */
export function createLocalScm(
  db: Database,
  repo: { url: string; defaultBranch: string; settings: Record<string, unknown> },
  publicUrl: string,
): Scm & {
  createPipeline(sha: string, ref: string): Promise<PipelineInfo>;
  finishPipeline(id: string, status: PipelineStatus, log: string): Promise<void>;
  mergeLocal(iid: number, mergeCommit: string): Promise<void>;
} {
  const path = repo.url;
  const web = (kind: string, iid: number) => `${publicUrl}/local-scm/${encodeURIComponent(path.split("/").slice(-1)[0] ?? "repo")}/${kind}/${iid}`;
  const protectedList = () => [repo.defaultBranch, ...(((repo.settings.protectedBranches as string[] | undefined) ?? []) as string[])];

  async function nextIid(table: "issue" | "mr") {
    await db.q().execute(sql`select pg_advisory_xact_lock(hashtext(${`localscm:${table}:${path}`}))`);
    const t = table === "issue" ? localScmIssue : localScmMr;
    const [r] = await db
      .q()
      .select({ n: sql<number>`coalesce(max(${t.iid}), 0)::int` })
      .from(t)
      .where(eq(t.repoPath, path));
    return (r?.n ?? 0) + 1;
  }
  const issueView = (i: typeof localScmIssue.$inferSelect): IssueInfo => ({
    iid: i.iid,
    ref: `#${i.iid}`,
    url: web("issues", i.iid),
    state: i.state,
    title: i.title,
    description: i.description,
    labels: i.labels,
  });
  const mrView = (m: typeof localScmMr.$inferSelect): MrInfo => ({
    iid: m.iid,
    ref: `!${m.iid}`,
    url: web("merge_requests", m.iid),
    state: m.state,
    sourceBranch: m.sourceBranch,
    targetBranch: m.targetBranch,
    mergeCommit: m.mergeCommit,
  });

  return {
    provider: "local",
    async gitRemote() {
      return { url: path, env: {}, cleanup: async () => undefined };
    },
    async checkAccess(): Promise<AccessCheck> {
      if (!existsSync(join(path, "HEAD"))) return { ok: false, defaultBranch: repo.defaultBranch, defaultBranchProtected: false, canPush: false, warnings: [], detail: `本地仓库不存在：${path}` };
      const head = await git(["rev-parse", "--verify", `refs/heads/${repo.defaultBranch}`], { cwd: path, allowFail: true });
      const guarded = existsSync(join(path, "hooks", "pre-receive"));
      const warnings: string[] = [];
      if (!head.ok) warnings.push(`默认分支 ${repo.defaultBranch} 不存在`);
      if (!guarded) warnings.push("默认分支未受保护：仓库侧没有 pre-receive 保护（平台侧仍强制 INV-10）");
      return {
        ok: head.ok,
        defaultBranch: repo.defaultBranch,
        defaultBranchProtected: guarded,
        canPush: true,
        warnings,
        detail: head.ok ? `本地裸仓库，${repo.defaultBranch}@${head.out.slice(0, 8)}` : "默认分支缺失",
      };
    },
    async isProtected(branch) {
      return protectedList().includes(branch);
    },
    async upsertIssue(input) {
      return db.tx(async (q) => {
        let row = input.iid
          ? (
              await q
                .select()
                .from(localScmIssue)
                .where(and(eq(localScmIssue.repoPath, path), eq(localScmIssue.iid, input.iid)))
            )[0]
          : (
              await q
                .select()
                .from(localScmIssue)
                .where(and(eq(localScmIssue.repoPath, path), sql`${localScmIssue.labels} @> ${JSON.stringify([input.marker])}::jsonb`))
            )[0];
        const labels = [...new Set([input.marker, ...input.labels])];
        if (row) {
          [row] = await q
            .update(localScmIssue)
            .set({ title: input.title, description: input.description, labels, state: input.state, updatedAt: new Date() })
            .where(eq(localScmIssue.id, row.id))
            .returning();
        } else {
          [row] = await q
            .insert(localScmIssue)
            .values({ id: newId("lsi"), repoPath: path, iid: await nextIid("issue"), title: input.title, description: input.description, labels, state: input.state })
            .returning();
        }
        return issueView(row!);
      });
    },
    async getIssue(iid) {
      const [i] = await db.root
        .select()
        .from(localScmIssue)
        .where(and(eq(localScmIssue.repoPath, path), eq(localScmIssue.iid, iid)));
      return i ? issueView(i) : null;
    },
    async openMr(input) {
      return db.tx(async (q) => {
        const [open] = await q
          .select()
          .from(localScmMr)
          .where(and(eq(localScmMr.repoPath, path), eq(localScmMr.sourceBranch, input.sourceBranch), eq(localScmMr.state, "opened")));
        if (open) return { ...mrView(open), reused: true };
        const [m] = await q
          .insert(localScmMr)
          .values({
            id: newId("lsm"),
            repoPath: path,
            iid: await nextIid("mr"),
            sourceBranch: input.sourceBranch,
            targetBranch: input.targetBranch,
            title: input.title,
            description: input.description,
          })
          .returning();
        return { ...mrView(m!), reused: false };
      });
    },
    async getMr(iid) {
      const [m] = await db.root
        .select()
        .from(localScmMr)
        .where(and(eq(localScmMr.repoPath, path), eq(localScmMr.iid, iid)));
      return m ? mrView(m) : null;
    },
    async closeMr(iid) {
      await db.root
        .update(localScmMr)
        .set({ state: "closed", updatedAt: new Date() })
        .where(and(eq(localScmMr.repoPath, path), eq(localScmMr.iid, iid), eq(localScmMr.state, "opened")));
    },
    async addNote(target, iid, body) {
      await db.root.insert(localScmNote).values({ id: newId("lsn"), repoPath: path, targetType: target, targetIid: iid, body, author: "platform" });
    },
    async latestPipeline(sha) {
      const [p] = await db.root
        .select()
        .from(localScmPipeline)
        .where(and(eq(localScmPipeline.repoPath, path), eq(localScmPipeline.sha, sha)))
        .orderBy(desc(localScmPipeline.createdAt))
        .limit(1);
      return p ? { id: p.id, sha: p.sha, ref: p.ref, status: p.status, url: web("pipelines", 0).replace(/\/0$/, `/${p.id}`) } : null;
    },
    async createPipeline(sha, ref) {
      const id = newId("lsp");
      await db.root.insert(localScmPipeline).values({ id, repoPath: path, sha, ref, status: "running" });
      return { id, sha, ref, status: "running" };
    },
    async finishPipeline(id, status, log) {
      await db.root
        .update(localScmPipeline)
        .set({ status: status as "running" | "success" | "failed" | "canceled", log: log.slice(-200_000), finishedAt: new Date() })
        .where(and(eq(localScmPipeline.id, id), eq(localScmPipeline.status, "running")));
    },
    async mergeLocal(iid, mergeCommit) {
      await db.root
        .update(localScmMr)
        .set({ state: "merged", mergeCommit, updatedAt: new Date() })
        .where(and(eq(localScmMr.repoPath, path), eq(localScmMr.iid, iid)));
    },
  };
}
