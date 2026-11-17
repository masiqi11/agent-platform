import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Audit } from "../../core/audit";
import type { Ctx } from "../../core/context";
import { safeEqual, type Vault } from "../../core/crypto";
import { DomainError, conflict, invalid, notFound } from "../../core/errors";
import type { Events } from "../../core/events";
import { newId } from "../../core/ids";
import { log } from "../../core/logger";
import type { Config } from "../../config";
import type { Database } from "../../db";
import { credential, project, projectMember, repo } from "../../db/schema";
import type { Identity } from "../identity/service";
import { createCredentialUseAudit } from "../../core/credential-use";
import type { Projects } from "../projects/service";
import { createGitLabScm } from "../scm/service";
import { createLocalBareRepo, createLocalScm, installGuard } from "../scm/service";
import { ScmAuthError, type AccessCheck, type Scm } from "../scm/service";

export type RepoRow = typeof repo.$inferSelect;
export interface RepoSettings {
  /** Test command run by CI (local provider) and by the tester agent (S6). Platform assumes no stack (REL-补3). */
  testCommand?: string;
  /** Sandbox image for this repo (SBX-09). */
  image?: string;
  protectedBranches?: string[];
  botUserId?: string;
  lastCheck?: AccessCheck & { at: string };
}

export interface BindRepoInput {
  provider: "local" | "gitlab";
  name: string;
  /** gitlab: project URL. local: absent → create a new bare repo; present → existing path under LOCAL_SCM_DIR. */
  url?: string;
  externalId?: string;
  defaultBranch?: string;
  token?: string;
  caCert?: string;
  testCommand?: string;
  image?: string;
  /** Local only: initial files for a newly created repo (seed/demo). */
  seedDir?: string;
  files?: Record<string, string>;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/** Repos (§8.2 repo, §12.7 repo binding wizard). Credentials are encrypted; only the last 4 are shown. */
export function createRepos(d: {
  config: Config;
  db: Database;
  audit: Audit;
  events: Events;
  identity: Identity;
  projects: Projects;
  vault: Vault;
  fetch?: typeof fetch;
  /** §14.5: git remotes are server-side requests too (clone / fetch / push). */
  outbound?: { check(url: string): Promise<void> };
}) {
  const { db } = d;
  const auditUse = createCredentialUseAudit({ audit: d.audit, systemCtx: (t) => d.identity.systemCtx(t) });

  const settingsOf = (r: RepoRow) => (r.settings ?? {}) as RepoSettings;
  const present = (r: RepoRow, last4?: string | null) => {
    const s = settingsOf(r);
    return {
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      provider: r.provider,
      url: r.url,
      externalId: r.externalId,
      defaultBranch: r.defaultBranch,
      status: r.status,
      testCommand: s.testCommand ?? null,
      image: s.image ?? null,
      tokenLast4: last4 ?? null,
      lastCheck: s.lastCheck
        ? {
            ok: s.lastCheck.ok,
            defaultBranchProtected: s.lastCheck.defaultBranchProtected,
            canPush: s.lastCheck.canPush,
            warnings: s.lastCheck.warnings,
            detail: s.lastCheck.detail,
            at: s.lastCheck.at,
          }
        : null,
      createdAt: r.createdAt.toISOString(),
    };
  };

  async function secret(id: string | null) {
    if (!id) return null;
    const [c] = await db.root.select().from(credential).where(eq(credential.id, id));
    if (!c) return null;
    return { value: d.vault.decrypt(c.ciphertext, c.keyVersion), row: c };
  }
  async function storeSecret(ctx: Ctx, name: string, value: string, projectId: string) {
    const enc = d.vault.encrypt(value);
    const id = newId("cred");
    await db
      .q()
      .insert(credential)
      .values({ id, tenantId: ctx.tenantId, kind: "scm", name, ciphertext: enc.ciphertext, keyVersion: enc.keyVersion, last4: value.slice(-4), projectIds: [projectId] });
    return id;
  }

  /** SCM client for a repo; the token is decrypted per call and never cached (FR-GIT-08). */
  async function scmFor(r: RepoRow): Promise<Scm> {
    if (r.provider === "local") return createLocalScm(db, { url: r.url, defaultBranch: r.defaultBranch, settings: r.settings }, d.config.publicUrl);
    const tok = await secret(r.credentialId);
    if (!tok) throw new DomainError("conflict", "仓库缺少凭据");
    // Authorized for this project only (credential.project_ids).
    if (!tok.row.projectIds.includes(r.projectId)) throw new DomainError("forbidden", "凭据未授权给该项目");
    await db.root
      .update(credential)
      .set({ lastUsedAt: new Date(), lastUsedBy: `repo:${r.id}` })
      .where(eq(credential.id, tok.row.id));
    await auditUse(tok.row, `repo:${r.id}`);
    const ca = await secret(r.caCertRef);
    return createGitLabScm({ url: r.url, externalId: r.externalId, defaultBranch: r.defaultBranch }, { token: tok.value, caCert: ca?.value ?? null, fetch: d.fetch });
  }
  /** Local-only extensions (pipelines) for the CI runner. */
  function localScm(r: RepoRow) {
    if (r.provider !== "local") throw new Error("not a local repo");
    return createLocalScm(db, { url: r.url, defaultBranch: r.defaultBranch, settings: r.settings }, d.config.publicUrl);
  }

  /** On 401/403: mark the repo and tell maintainers (repo.credential_invalid). */
  async function onAuthError(r: RepoRow, err: unknown) {
    if (!(err instanceof ScmAuthError)) return false;
    if (r.status === "credential_invalid") return true;
    const sys = await d.identity.systemCtx(r.tenantId);
    const maint = await db.root
      .select({ p: projectMember.principalId })
      .from(projectMember)
      .where(and(eq(projectMember.projectId, r.projectId), eq(projectMember.role, "maintainer")));
    await db.tx(async (q) => {
      await q.update(repo).set({ status: "credential_invalid", updatedAt: new Date() }).where(eq(repo.id, r.id));
      await d.events.emit(sys, {
        type: "repo.credential_invalid",
        aggregateType: "repo",
        aggregateId: r.id,
        payload: { projectId: r.projectId, repoId: r.id, inboxPrincipalIds: maint.map((m) => m.p) },
      });
      await d.audit.write(sys, { action: "repo.credential_invalid", resourceType: "repo", resourceId: r.id, projectId: r.projectId, after: { error: (err as Error).message.slice(0, 200) } });
    });
    return true;
  }

  async function load(ctx: Ctx, id: string) {
    const [r] = await db.root
      .select()
      .from(repo)
      .where(and(eq(repo.id, id), eq(repo.tenantId, ctx.tenantId)));
    if (!r) throw notFound("仓库");
    await d.identity.require(ctx, "project.view", { projectId: r.projectId });
    return r;
  }
  async function last4s(rows: RepoRow[]) {
    const ids = rows.map((r) => r.credentialId).filter((x): x is string => Boolean(x));
    return ids.length ? await db.root.select({ id: credential.id, last4: credential.last4 }).from(credential).where(inArray(credential.id, ids)) : [];
  }

  async function list(ctx: Ctx, projectId: string) {
    await d.identity.projectInTenant(ctx, projectId);
    await d.identity.require(ctx, "project.view", { projectId });
    const rows = await db.root.select().from(repo).where(eq(repo.projectId, projectId)).orderBy(asc(repo.createdAt));
    const l4 = await last4s(rows);
    return rows.map((r) => present(r, l4.find((c) => c.id === r.credentialId)?.last4));
  }

  /** Connectivity + permission check (wizard step); never throws for SCM problems, returns them. */
  async function runCheck(r: RepoRow): Promise<AccessCheck> {
    try {
      return await (await scmFor(r)).checkAccess();
    } catch (e) {
      const auth = e instanceof ScmAuthError;
      return {
        ok: false,
        defaultBranch: r.defaultBranch,
        defaultBranchProtected: false,
        canPush: false,
        warnings: [],
        detail: auth ? (e as Error).message : `无法连接：${(e as Error).message.slice(0, 200)}`,
      };
    }
  }

  /** Dry-run of the wizard: checks a GitLab URL/token before anything is stored. */
  async function preflight(ctx: Ctx, projectId: string, input: BindRepoInput) {
    await d.identity.projectInTenant(ctx, projectId);
    await d.identity.require(ctx, "repo.bind", { projectId });
    if (input.provider !== "gitlab") return { ok: true, defaultBranch: input.defaultBranch ?? "main", defaultBranchProtected: true, canPush: true, warnings: [], detail: "本地仓库无需预检" };
    if (!input.url || !input.token) throw invalid("GitLab 需要项目地址和令牌", [{ path: "/url", message: "必填" }]);
    await d.outbound?.check(input.url);
    const scm = createGitLabScm(
      { url: input.url, externalId: input.externalId ?? new URL(input.url).pathname.replace(/^\/|\.git$/g, ""), defaultBranch: input.defaultBranch ?? "main" },
      { token: input.token, caCert: input.caCert, fetch: d.fetch },
    );
    try {
      return await scm.checkAccess();
    } catch (e) {
      return { ok: false, defaultBranch: input.defaultBranch ?? "main", defaultBranchProtected: false, canPush: false, warnings: [], detail: (e as Error).message.slice(0, 200) };
    }
  }

  async function bind(ctx: Ctx, projectId: string, input: BindRepoInput) {
    const p = await d.projects.assertWritable(ctx, projectId);
    await d.identity.require(ctx, "repo.bind", { projectId });
    if (!NAME.test(input.name)) throw invalid("仓库名只能包含小写字母、数字、点、横线、下划线", [{ path: "/name", message: "格式错误" }]);
    const dup = await db.root
      .select({ id: repo.id })
      .from(repo)
      .where(and(eq(repo.projectId, projectId), eq(repo.name, input.name)));
    if (dup.length) throw conflict("项目内已有同名仓库");
    const defaultBranch = input.defaultBranch ?? p.defaultBranch ?? "main";
    const id = newId("rep");
    let url = input.url ?? "";
    let externalId = input.externalId ?? "";
    if (input.provider === "local") {
      const root = resolve(d.config.dirs.localScm);
      if (!url) {
        url = resolve(root, ctx.tenantId, `${p.key.toLowerCase()}-${input.name}.git`);
        await createLocalBareRepo(url, { defaultBranch, seedDir: input.seedDir, files: input.files });
      } else {
        // Only paths under LOCAL_SCM_DIR may be bound: never arbitrary host directories.
        url = resolve(url);
        if (!url.startsWith(root + sep)) throw invalid("本地仓库必须位于 LOCAL_SCM_DIR 之下", [{ path: "/url", message: "路径不允许" }]);
        if (!existsSync(url)) throw invalid("本地仓库不存在", [{ path: "/url", message: "不存在" }]);
        await installGuard(url, [defaultBranch]);
      }
      externalId = url.split(sep).slice(-1)[0] ?? input.name;
    } else {
      if (!input.url || !input.token) throw invalid("GitLab 需要项目地址和令牌", [{ path: "/token", message: "必填" }]);
      if (!input.url.startsWith("https://") && d.config.isProd) throw invalid("生产环境只允许 https 的 GitLab 地址", [{ path: "/url", message: "需要 https" }]);
      await d.outbound?.check(input.url);
      externalId = externalId || new URL(input.url).pathname.replace(/^\/|\.git$/g, "");
    }
    const settings: RepoSettings = { testCommand: input.testCommand ?? "bun test", ...(input.image ? { image: input.image } : {}) };
    const webhookSecret = randomBytes(24).toString("base64url");
    await db.tx(async (q) => {
      const credentialId = input.token ? await storeSecret(ctx, `${p.key}/${input.name} 令牌`, input.token, projectId) : null;
      const caCertRef = input.caCert ? await storeSecret(ctx, `${p.key}/${input.name} CA`, input.caCert, projectId) : null;
      const webhookSecretRef = input.provider === "gitlab" ? await storeSecret(ctx, `${p.key}/${input.name} webhook`, webhookSecret, projectId) : null;
      await q.insert(repo).values({
        id,
        tenantId: ctx.tenantId,
        projectId,
        name: input.name,
        provider: input.provider,
        externalId,
        url,
        defaultBranch,
        credentialId,
        caCertRef,
        webhookSecretRef,
        settings: settings as Record<string, unknown>,
      });
    });
    const [row] = await db.root.select().from(repo).where(eq(repo.id, id));
    const check = await runCheck(row!);
    const next: RepoSettings = { ...settings, botUserId: check.botUserId, lastCheck: { ...check, at: new Date().toISOString() } };
    await db.tx(async (q) => {
      await q
        .update(repo)
        .set({ settings: next as Record<string, unknown>, status: check.ok ? "ok" : /令牌|权限/.test(check.detail) ? "credential_invalid" : "unreachable", updatedAt: new Date() })
        .where(eq(repo.id, id));
      await d.events.emit(ctx, { type: "repo.bound", aggregateType: "repo", aggregateId: id, payload: { projectId, repoId: id, provider: input.provider, ok: check.ok } });
      await d.audit.write(ctx, {
        action: "repo.bind",
        resourceType: "repo",
        resourceId: id,
        projectId,
        after: { name: input.name, provider: input.provider, url: input.provider === "gitlab" ? url : "(local)", warnings: check.warnings, hasToken: Boolean(input.token) },
      });
    });
    const [fresh] = await db.root.select().from(repo).where(eq(repo.id, id));
    return {
      repo: present(fresh!, input.token ? input.token.slice(-4) : null),
      check,
      // Shown once so the maintainer can configure the GitLab webhook; never readable again (ADM-补1).
      webhook: input.provider === "gitlab" ? { url: `${d.config.publicUrl}/api/v1/webhooks/gitlab/${id}`, secret: webhookSecret } : null,
    };
  }

  async function recheck(ctx: Ctx, id: string) {
    const r = await load(ctx, id);
    await d.identity.require(ctx, "repo.bind", { projectId: r.projectId });
    const check = await runCheck(r);
    const s: RepoSettings = { ...settingsOf(r), ...(check.botUserId ? { botUserId: check.botUserId } : {}), lastCheck: { ...check, at: new Date().toISOString() } };
    await db.tx(async (q) => {
      await q
        .update(repo)
        .set({ settings: s as Record<string, unknown>, status: check.ok ? "ok" : r.status === "ok" ? "unreachable" : r.status, updatedAt: new Date() })
        .where(eq(repo.id, id));
      await d.audit.write(ctx, { action: "repo.check", resourceType: "repo", resourceId: id, projectId: r.projectId, after: { ok: check.ok, warnings: check.warnings } });
    });
    return check;
  }

  async function updateSettings(ctx: Ctx, id: string, patch: { testCommand?: string; image?: string | null; token?: string }) {
    const r = await load(ctx, id);
    await d.identity.require(ctx, "repo.bind", { projectId: r.projectId });
    if (patch.image && !/^[a-z0-9./_:@-]+$/i.test(patch.image)) throw invalid("镜像名不合法", [{ path: "/image", message: "格式错误" }]);
    const s: RepoSettings = { ...settingsOf(r) };
    if (patch.testCommand !== undefined) s.testCommand = patch.testCommand;
    if (patch.image !== undefined) s.image = patch.image ?? undefined;
    await db.tx(async (q) => {
      // Token replacement only (write-only, ADM-补1); the old ciphertext row stays for audit.
      const credentialId = patch.token ? await storeSecret(ctx, `${r.name} 令牌`, patch.token, r.projectId) : r.credentialId;
      await q
        .update(repo)
        .set({ settings: s as Record<string, unknown>, credentialId, status: patch.token ? "ok" : r.status, updatedAt: new Date() })
        .where(eq(repo.id, id));
      await d.audit.write(ctx, {
        action: "repo.update",
        resourceType: "repo",
        resourceId: id,
        projectId: r.projectId,
        after: { testCommand: s.testCommand, image: s.image ?? null, tokenReplaced: Boolean(patch.token) },
      });
      if (patch.token) await d.events.emit(ctx, { type: "credential.changed", aggregateType: "repo", aggregateId: id, payload: { projectId: r.projectId, repoId: id } });
    });
    return present((await db.root.select().from(repo).where(eq(repo.id, id)))[0]!, patch.token?.slice(-4));
  }

  /** Webhook auth: X-Gitlab-Token compared in constant time with the stored secret. */
  async function verifyWebhook(repoId: string, token: string | null) {
    const [r] = await db.root.select().from(repo).where(eq(repo.id, repoId));
    if (!r || r.provider !== "gitlab" || !token) return null;
    const s = await secret(r.webhookSecretRef);
    if (!s || !safeEqual(s.value, token)) {
      log.warn("webhook.bad_token", { repoId });
      return null;
    }
    return r;
  }

  async function projectRepos(projectId: string) {
    return db.root.select().from(repo).where(eq(repo.projectId, projectId)).orderBy(asc(repo.createdAt));
  }
  async function byId(id: string) {
    return (await db.root.select().from(repo).where(eq(repo.id, id)))[0] ?? null;
  }
  async function projectKey(projectId: string) {
    return (await db.root.select({ key: project.key }).from(project).where(eq(project.id, projectId)))[0]?.key ?? "T";
  }

  return { list, bind, preflight, recheck, updateSettings, scmFor, localScm, onAuthError, verifyWebhook, projectRepos, byId, load, settingsOf, projectKey, present };
}
export type Repos = ReturnType<typeof createRepos>;
