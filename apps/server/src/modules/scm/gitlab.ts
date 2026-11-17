import { asText } from "@ap/shared";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { addRedactionValue } from "../../core/logger";
import { askpassEnv } from "./git";
import { ScmAuthError, ScmNotReady, ScmPermissionError, type AccessCheck, type IssueInfo, type MrInfo, type PipelineInfo, type PipelineStatus, type Scm } from "./types";

export interface GitLabRepo {
  /** https://gitlab.example.com/group/project(.git) */
  url: string;
  /** Numeric project id or "group/project". */
  externalId: string;
  defaultBranch: string;
}

export interface GitLabOptions {
  token: string;
  /** PEM of a private CA (self-hosted GitLab). */
  caCert?: string | null;
  fetch?: typeof fetch;
  /** Retries for "not ready" merge responses (TRAP-9). */
  notReadyRetries?: number;
  backoffMs?: number;
}

type Json = Record<string, unknown>;

const PIPE: Record<string, PipelineStatus> = {
  created: "pending",
  waiting_for_resource: "pending",
  preparing: "pending",
  pending: "pending",
  scheduled: "pending",
  manual: "pending",
  running: "running",
  success: "success",
  failed: "failed",
  canceled: "canceled",
  skipped: "canceled",
};

/**
 * GitLab provider (REST v4). 已实现、本地假服务验证；未经真实 GitLab 验证 (see PROGRESS).
 * The token travels only in request headers / one-shot askpass and is registered with the log redactor.
 */
export function createGitLabScm(
  repo: GitLabRepo,
  o: GitLabOptions,
): Scm & { mergeMr(iid: number, sha: string): Promise<{ mergeCommit: string }>; api: (method: string, path: string, body?: Json) => Promise<{ status: number; body: unknown }> } {
  addRedactionValue(o.token);
  const origin = new URL(repo.url).origin;
  const pid = encodeURIComponent(repo.externalId);
  const doFetch = o.fetch ?? fetch;
  const retries = o.notReadyRetries ?? 3;
  const backoff = o.backoffMs ?? 2000;

  async function api(method: string, path: string, body?: Json) {
    const res = await doFetch(`${origin}/api/v4${path}`, {
      method,
      headers: { "PRIVATE-TOKEN": o.token, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      ...(o.caCert ? ({ tls: { ca: o.caCert } } as Record<string, unknown>) : {}),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    if (res.status === 401) throw new ScmAuthError("GitLab 令牌无效或已过期");
    return { status: res.status, body: parsed };
  }
  const ok = (r: { status: number; body: unknown }, what: string) => {
    if (r.status >= 200 && r.status < 300) return r.body as Json;
    if (r.status === 403) throw new ScmAuthError(`GitLab 拒绝访问（${what}）：令牌权限不足`);
    throw new Error(`GitLab ${what} 失败：HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  };
  const issueView = (i: Json): IssueInfo => ({
    iid: Number(i.iid),
    ref: `#${asText(i.iid)}`,
    url: asText(i.web_url),
    state: i.state === "closed" ? "closed" : "opened",
    title: asText(i.title),
    description: asText(i.description),
    labels: (i.labels as string[]) ?? [],
  });
  const mrView = (m: Json): MrInfo => ({
    iid: Number(m.iid),
    ref: `!${asText(m.iid)}`,
    url: asText(m.web_url),
    state: m.state === "merged" ? "merged" : m.state === "opened" ? "opened" : "closed",
    sourceBranch: String(m.source_branch),
    targetBranch: String(m.target_branch),
    mergeCommit: (m.merge_commit_sha as string | null) ?? null,
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return {
    provider: "gitlab",
    api,
    async gitRemote() {
      const a = await askpassEnv(o.token);
      const url = repo.url.endsWith(".git") ? repo.url : `${repo.url}.git`;
      const env: Record<string, string> = { ...a.env };
      if (o.caCert) {
        // Custom CA for self-hosted GitLab, only for this git call (no global git config).
        const ca = join(dirname(a.env.GIT_ASKPASS), "ca.pem");
        await writeFile(ca, o.caCert);
        env.GIT_SSL_CAINFO = ca;
      }
      return { url, env, cleanup: a.cleanup };
    },
    async checkAccess(): Promise<AccessCheck> {
      const warnings: string[] = [];
      const p = await api("GET", `/projects/${pid}`);
      if (p.status === 404) return { ok: false, defaultBranch: repo.defaultBranch, defaultBranchProtected: false, canPush: false, warnings, detail: "项目不存在或令牌无权访问" };
      const proj = ok(p, "读取项目");
      const defaultBranch = asText(proj.default_branch) || repo.defaultBranch;
      const perms = (proj.permissions ?? {}) as { project_access?: { access_level?: number } | null; group_access?: { access_level?: number } | null };
      const level = Math.max(perms.project_access?.access_level ?? 0, perms.group_access?.access_level ?? 0);
      const canPush = level >= 30;
      if (!canPush) warnings.push("令牌对该项目的权限低于 Developer，无法推送分支或创建 MR");
      if (level >= 50) warnings.push("令牌是 Owner 级别，权限过大；建议使用 Developer 级别的项目令牌（R6）");
      const pb = await api("GET", `/projects/${pid}/protected_branches/${encodeURIComponent(defaultBranch)}`);
      const prot = pb.status === 200;
      if (!prot) warnings.push(`默认分支 ${defaultBranch} 未受保护：请在 GitLab 中保护它（GIT-补2）`);
      else {
        const pbb = pb.body as { allow_force_push?: boolean; push_access_levels?: Array<{ access_level?: number }>; merge_access_levels?: Array<{ access_level?: number }> };
        if (pbb.allow_force_push) warnings.push("默认分支允许强推");
        const mergeLevels = (pbb.merge_access_levels ?? []).map((l) => l.access_level ?? 0).filter((l) => l > 0);
        if (mergeLevels.length && !mergeLevels.some((l) => l <= level))
          warnings.push(`令牌（权限等级 ${level}）不在默认分支 ${defaultBranch} 的「允许合并」角色内：合并队列将无法合并，请把「允许合并」设为 Developers + Maintainers（「允许推送」保持 No one）`);
        if ((pbb.push_access_levels ?? []).some((l) => (l.access_level ?? 0) > 0 && (l.access_level ?? 0) <= level)) warnings.push("令牌可直接推送默认分支：平台令牌不应具备绕过保护的权限");
      }
      const me = await api("GET", "/user");
      const self = await api("GET", "/personal_access_tokens/self");
      const scopes = self.status === 200 ? ((self.body as { scopes?: string[] }).scopes ?? []) : [];
      if (scopes.includes("sudo") || scopes.includes("admin_mode")) warnings.push(`令牌包含高危 scope：${scopes.filter((s) => s === "sudo" || s === "admin_mode").join("、")}`);
      return {
        ok: true,
        defaultBranch,
        defaultBranchProtected: prot,
        canPush,
        warnings,
        detail: `GitLab ${asText(proj.path_with_namespace) || repo.externalId}，权限等级 ${level}`,
        botUserId: me.status === 200 ? String((me.body as Json).id) : undefined,
      };
    },
    async isProtected(branch) {
      if (branch === repo.defaultBranch) return true;
      const r = await api("GET", `/projects/${pid}/protected_branches/${encodeURIComponent(branch)}`);
      return r.status === 200;
    },
    async upsertIssue(input) {
      // Convergent (TRAP-9): find by iid, else by the marker label left by an earlier attempt, else create.
      let iid = input.iid ?? null;
      if (!iid) {
        const found = ok(await api("GET", `/projects/${pid}/issues?labels=${encodeURIComponent(input.marker)}&state=all&per_page=1`), "查找 Issue") as unknown as Json[];
        if (Array.isArray(found) && found[0]) iid = Number(found[0].iid);
      }
      const labels = [...new Set([input.marker, ...input.labels])].join(",");
      if (iid) {
        const cur = await api("GET", `/projects/${pid}/issues/${iid}`);
        const curState = cur.status === 200 ? (cur.body as Json).state : null;
        const stateEvent = curState === "opened" && input.state === "closed" ? "close" : curState === "closed" && input.state === "opened" ? "reopen" : undefined;
        return issueView(
          ok(await api("PUT", `/projects/${pid}/issues/${iid}`, { title: input.title, description: input.description, labels, ...(stateEvent ? { state_event: stateEvent } : {}) }), "更新 Issue"),
        );
      }
      const created = issueView(ok(await api("POST", `/projects/${pid}/issues`, { title: input.title, description: input.description, labels }), "创建 Issue"));
      if (input.state === "closed") return issueView(ok(await api("PUT", `/projects/${pid}/issues/${created.iid}`, { state_event: "close" }), "关闭 Issue"));
      return created;
    },
    async getIssue(iid) {
      const r = await api("GET", `/projects/${pid}/issues/${iid}`);
      return r.status === 404 ? null : issueView(ok(r, "读取 Issue"));
    },
    async openMr(input) {
      const r = await api("POST", `/projects/${pid}/merge_requests`, {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
        description: input.description,
        remove_source_branch: false,
      });
      if (r.status === 409 || r.status === 422) {
        // "Another open merge request already exists for this source branch" → reuse it (TRAP-9).
        const list = ok(await api("GET", `/projects/${pid}/merge_requests?source_branch=${encodeURIComponent(input.sourceBranch)}&state=opened`), "查找 MR") as unknown as Json[];
        if (Array.isArray(list) && list[0]) return { ...mrView(list[0]), reused: true };
      }
      return { ...mrView(ok(r, "创建 MR")), reused: false };
    },
    async getMr(iid) {
      const r = await api("GET", `/projects/${pid}/merge_requests/${iid}`);
      return r.status === 404 ? null : mrView(ok(r, "读取 MR"));
    },
    async closeMr(iid) {
      const r = await api("PUT", `/projects/${pid}/merge_requests/${iid}`, { state_event: "close" });
      if (r.status !== 404) ok(r, "关闭 MR");
    },
    async addNote(target, iid, body) {
      ok(await api("POST", `/projects/${pid}/${target === "mr" ? "merge_requests" : "issues"}/${iid}/notes`, { body }), "发表评论");
    },
    async latestPipeline(sha): Promise<PipelineInfo | null> {
      const list = ok(await api("GET", `/projects/${pid}/pipelines?sha=${sha}&order_by=id&sort=desc&per_page=1`), "读取流水线") as unknown as Json[];
      const p = Array.isArray(list) ? list[0] : undefined;
      return p ? { id: asText(p.id), sha: asText(p.sha), ref: asText(p.ref), status: PIPE[asText(p.status)] ?? "pending", url: asText(p.web_url) } : null;
    },
    /** Merge (used by the merge queue in S6). 405/406/422 = not ready: bounded retries, then ScmNotReady with GitLab's reason (GIT-补3). */
    async mergeMr(iid, sha) {
      let last = "";
      for (let i = 0; i <= retries; i++) {
        let r: { status: number; body: unknown };
        try {
          r = await api("PUT", `/projects/${pid}/merge_requests/${iid}/merge`, { sha, should_remove_source_branch: false });
        } catch (e) {
          // GitLab answers 401 (not 403) on the merge endpoint when the user may not merge into the
          // target branch. If the token still reads the project, it is a permission problem, not a dead token.
          if (e instanceof ScmAuthError && (await api("GET", `/projects/${pid}`).catch(() => null))?.status === 200)
            throw new ScmPermissionError("令牌没有合并到目标分支的权限：请在受保护分支设置里把「允许合并」设为包含该令牌的角色（Developer），或由人在 GitLab 合并");
          throw e;
        }
        if (r.status >= 200 && r.status < 300) return { mergeCommit: asText((r.body as Json).merge_commit_sha) };
        if (![405, 406, 422].includes(r.status)) ok(r, "合并 MR");
        last = `HTTP ${r.status} ${JSON.stringify((r.body as Json | null)?.message ?? r.body).slice(0, 200)}`;
        if (i < retries) await sleep(backoff * 2 ** i);
      }
      throw new ScmNotReady(`MR 未就绪：${last}`);
    },
  };
}
