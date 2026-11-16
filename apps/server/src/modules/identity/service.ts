import { can, type Action, type PermissionContext, type Subject, type TenantRole } from "@ap/shared";
import { and, asc, count, eq, gt, isNull } from "drizzle-orm";
import type { Auth } from "../../auth";
import { signupGrant } from "../../auth";
import type { Config } from "../../config";
import type { Database } from "../../db";
import { agent, appUser, invitation, principal, project, projectMember, task, taskOwner, tenant } from "../../db/schema";
import { looksLikeAgentToken, verifyAgentToken } from "../../core/agent-token";
import type { Audit } from "../../core/audit";
import type { Actor, Ctx } from "../../core/context";
import { hmacHex, sha256Hex } from "../../core/crypto";
import { DomainError, forbidden, notFound } from "../../core/errors";
import type { Events } from "../../core/events";
import { newId, randomToken } from "../../core/ids";
import type { RateLimiter } from "../../core/rate-limit";

export interface IdentityDeps {
  config: Config;
  db: Database;
  audit: Audit;
  events: Events;
  rateLimiter: RateLimiter;
  getAuth: () => Auth;
}

export type AppUserRow = typeof appUser.$inferSelect;

export function createIdentity(d: IdentityDeps) {
  const { db, config } = d;

  async function systemPrincipal(tenantId: string): Promise<string> {
    const [p] = await db
      .q()
      .select()
      .from(principal)
      .where(and(eq(principal.tenantId, tenantId), eq(principal.kind, "system")))
      .limit(1);
    if (p) return p.id;
    const id = newId("prn");
    await db.q().insert(principal).values({ id, tenantId, kind: "system", refId: null, displayName: "系统" });
    return id;
  }

  async function systemCtx(tenantId: string, traceId = newId("trc")): Promise<Ctx> {
    return { tenantId, traceId, actor: { principalId: await systemPrincipal(tenantId), kind: "system", displayName: "系统" } };
  }

  /** §9.2 user.create.after: bind or create app_user + principal in ONE transaction. */
  async function onUserCreated(user: { id: string; email: string; name: string }, grant: { tenantId?: string; tenantRole?: TenantRole; invitationId?: string } | undefined) {
    await db.tx(async (q) => {
      const domain = user.email.split("@")[1] ?? "";
      let tenantId = grant?.tenantId;
      if (!tenantId) {
        const [byDomain] = await q.select().from(tenant).where(eq(tenant.domain, domain)).limit(1);
        const [first] = byDomain ? [byDomain] : await q.select().from(tenant).orderBy(asc(tenant.createdAt)).limit(1);
        tenantId = first?.id;
      }
      if (!tenantId) {
        tenantId = newId("ten");
        await q.insert(tenant).values({ id: tenantId, name: domain || "默认租户", domain });
      }
      const [existing] = await q
        .select()
        .from(appUser)
        .where(and(eq(appUser.tenantId, tenantId), eq(appUser.email, user.email)));
      const sys = await systemCtx(tenantId);
      if (existing) {
        await q.update(appUser).set({ authUserId: user.id, updatedAt: new Date() }).where(eq(appUser.id, existing.id));
        await d.audit.write(sys, { action: "user.bind_auth", resourceType: "user", resourceId: existing.id });
        return;
      }
      const [{ n }] = (await q.select({ n: count() }).from(appUser).where(eq(appUser.tenantId, tenantId))) as [{ n: number }];
      const role: TenantRole = grant?.tenantRole ?? (n === 0 ? "owner" : "member");
      const uid = newId("usr");
      const pid = newId("prn");
      await q.insert(appUser).values({ id: uid, tenantId, authUserId: user.id, email: user.email, name: user.name || user.email, tenantRole: role });
      await q.insert(principal).values({ id: pid, tenantId, kind: "human", refId: uid, displayName: user.name || user.email });
      const ctx: Ctx = { ...sys, actor: { ...sys.actor } };
      await d.events.emit(ctx, { type: "user.created", aggregateType: "user", aggregateId: uid, payload: { principalId: pid, role } });
      await d.audit.write(ctx, { action: "user.create", resourceType: "user", resourceId: uid, after: { email: user.email, role } });
    });
  }

  async function actorForUser(u: AppUserRow): Promise<Actor> {
    const [p] = await db.root
      .select()
      .from(principal)
      .where(and(eq(principal.tenantId, u.tenantId), eq(principal.kind, "human"), eq(principal.refId, u.id)))
      .limit(1);
    if (!p) throw new DomainError("unauthenticated", "账号未初始化");
    return { principalId: p.id, kind: "human", displayName: u.name, userId: u.id, tenantRole: u.tenantRole };
  }

  /** §9.3 request auth chain. */
  async function authenticate(headers: Headers, traceId: string): Promise<Ctx> {
    const authz = headers.get("authorization") ?? "";
    const token = authz.toLowerCase().startsWith("bearer ") ? authz.slice(7).trim() : "";
    if (!token) throw new DomainError("unauthenticated", "请先登录");
    if (looksLikeAgentToken(token)) {
      const p = verifyAgentToken(token, [config.jwt.secret, config.jwt.previous]);
      if (!p) throw new DomainError("unauthenticated", "Agent 令牌无效或已过期");
      const [a] = await db.root
        .select()
        .from(agent)
        .where(and(eq(agent.id, p.agent_id), eq(agent.tenantId, p.tenant_id)));
      if (!a || a.status === "disabled" || a.tokenVersion !== p.token_version) throw new DomainError("unauthenticated", "Agent 已停用或令牌已撤销");
      await d.rateLimiter.hit("agent_token", a.id);
      return {
        tenantId: a.tenantId,
        traceId,
        actor: { principalId: a.principalId, kind: "agent", displayName: a.name, agentId: a.id, agentRole: a.role, projectScope: p.project_scope, toolScope: p.tool_scope, sessionId: p.session_id },
      };
    }
    const session = await d.getAuth().api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
    if (!session) throw new DomainError("unauthenticated", "会话已失效，请重新登录");
    const [u] = await db.root.select().from(appUser).where(eq(appUser.authUserId, session.user.id));
    if (!u) throw new DomainError("unauthenticated", "账号未绑定"); // never implicitly create (§9.3)
    if (u.status !== "active") throw new DomainError("unauthenticated", "账号已停用");
    return { tenantId: u.tenantId, traceId, actor: await actorForUser(u) };
  }

  /** Subject for the permission matrix within a project (undefined project → tenant level). */
  async function subjectFor(ctx: Ctx, projectId?: string | null): Promise<Subject> {
    const a = ctx.actor;
    if (a.kind === "system") return { kind: "system" };
    let pm: { role: "maintainer" | "member" | "viewer" } | undefined;
    if (projectId) {
      [pm] = await db
        .q()
        .select({ role: projectMember.role })
        .from(projectMember)
        .where(and(eq(projectMember.projectId, projectId), eq(projectMember.principalId, a.principalId), eq(projectMember.tenantId, ctx.tenantId)));
    }
    if (a.kind === "agent") {
      const inScope = !projectId || !a.projectScope || a.projectScope.includes(projectId);
      return { kind: "agent", agentRole: a.agentRole!, isProjectMember: Boolean(pm) && inScope };
    }
    return { kind: "human", tenantRole: a.tenantRole!, projectRole: pm?.role };
  }

  /** Default-deny authorization; denials throw 403 with the required role (and are not silent). */
  async function require(ctx: Ctx, action: Action, opts: { projectId?: string | null } & PermissionContext = {}) {
    const subject = await subjectFor(ctx, opts.projectId);
    const dec = can(subject, action, opts);
    if (!dec.allowed) throw forbidden(dec.required);
    return dec;
  }

  async function check(ctx: Ctx, action: Action, opts: { projectId?: string | null } & PermissionContext = {}) {
    return can(await subjectFor(ctx, opts.projectId), action, opts);
  }

  /** Project in caller's tenant, else 404 (INV-11). */
  async function projectInTenant(ctx: Ctx, projectId: string) {
    const [p] = await db
      .q()
      .select()
      .from(project)
      .where(and(eq(project.id, projectId), eq(project.tenantId, ctx.tenantId)));
    if (!p) throw notFound("项目");
    return p;
  }

  async function me(ctx: Ctx) {
    const [t] = await db.root.select().from(tenant).where(eq(tenant.id, ctx.tenantId));
    const [u] = ctx.actor.userId ? await db.root.select().from(appUser).where(eq(appUser.id, ctx.actor.userId)) : [];
    return {
      principalId: ctx.actor.principalId,
      kind: ctx.actor.kind,
      displayName: ctx.actor.displayName,
      userId: ctx.actor.userId ?? null,
      email: u?.email ?? null,
      tenantRole: ctx.actor.tenantRole ?? null,
      tenant: { id: t!.id, name: t!.name, timezone: t!.timezone, locale: t!.locale },
    };
  }

  async function hasAnyUser() {
    const [r] = (await db.root.select({ n: count() }).from(appUser)) as [{ n: number }];
    return r.n > 0;
  }

  async function signUpInternal(grant: { tenantId?: string; tenantRole?: TenantRole; invitationId?: string }, email: string, name: string, password: string) {
    return signupGrant.run(grant, () => d.getAuth().api.signUpEmail({ body: { email, name, password } }));
  }

  async function signIn(email: string, password: string): Promise<string> {
    const res = await d.getAuth().api.signInEmail({ body: { email, password }, asResponse: true });
    const token = res.headers.get("set-auth-token");
    if (!res.ok || !token) throw new DomainError("unauthenticated", "账号或密码错误");
    return token;
  }

  /** First-run bootstrap, only when the database has no users (§9.4). */
  async function setup(input: { tenantName: string; domain?: string; timezone?: string; email: string; name: string; password: string }) {
    if (await hasAnyUser()) throw new DomainError("conflict", "系统已初始化，引导不可再用");
    const tenantId = newId("ten");
    await db.tx(async (q) => {
      await q.insert(tenant).values({ id: tenantId, name: input.tenantName, domain: input.domain ?? input.email.split("@")[1], timezone: input.timezone ?? "Asia/Shanghai" });
      const sys = await systemCtx(tenantId);
      await d.audit.write(sys, { action: "tenant.create", resourceType: "tenant", resourceId: tenantId, after: { name: input.tenantName } });
    });
    await signUpInternal({ tenantId, tenantRole: "owner" }, input.email.toLowerCase(), input.name, input.password);
    return { tenantId, token: await signIn(input.email.toLowerCase(), input.password) };
  }

  async function createInvitation(ctx: Ctx, input: { email?: string; tenantRole: TenantRole; projectId?: string; projectRole?: "maintainer" | "member" | "viewer"; ttlHours?: number }) {
    await require(ctx, "admin.users");
    if (input.tenantRole === "owner" && ctx.actor.tenantRole !== "owner") throw forbidden("Tenant Owner");
    if (input.projectId) await projectInTenant(ctx, input.projectId);
    const token = randomToken(24);
    const id = newId("inv");
    const expiresAt = new Date(Date.now() + (input.ttlHours ?? 72) * 3600_000);
    await db.tx(async (q) => {
      await q.insert(invitation).values({
        id,
        tenantId: ctx.tenantId,
        email: input.email?.toLowerCase() ?? null,
        tenantRole: input.tenantRole,
        projectId: input.projectId ?? null,
        projectRole: input.projectRole ?? null,
        tokenHash: sha256Hex(token),
        expiresAt,
        createdBy: ctx.actor.principalId,
      });
      await d.events.emit(ctx, { type: "invitation.created", aggregateType: "invitation", aggregateId: id });
      await d.audit.write(ctx, { action: "invitation.create", resourceType: "invitation", resourceId: id, after: { email: input.email, tenantRole: input.tenantRole, projectId: input.projectId } });
    });
    return { id, token, url: `${config.publicUrl}/invite/${token}`, expiresAt: expiresAt.toISOString() };
  }

  async function acceptInvitation(token: string, input: { email: string; name: string; password: string }) {
    const [inv] = await db.root
      .select()
      .from(invitation)
      .where(and(eq(invitation.tokenHash, sha256Hex(token)), eq(invitation.kind, "invite"), isNull(invitation.usedAt), gt(invitation.expiresAt, new Date())));
    if (!inv) throw new DomainError("not_found", "邀请链接无效或已过期");
    const email = input.email.toLowerCase();
    if (inv.email && inv.email !== email) throw new DomainError("forbidden", "邀请邮箱不匹配", { required: inv.email });
    // Mark used first (single use even under concurrent accepts).
    const used = await db.root
      .update(invitation)
      .set({ usedAt: new Date() })
      .where(and(eq(invitation.id, inv.id), isNull(invitation.usedAt)))
      .returning();
    if (used.length === 0) throw new DomainError("conflict", "邀请已被使用");
    await signUpInternal({ tenantId: inv.tenantId, tenantRole: inv.tenantRole as TenantRole, invitationId: inv.id }, email, input.name, input.password);
    const [u] = await db.root
      .select()
      .from(appUser)
      .where(and(eq(appUser.tenantId, inv.tenantId), eq(appUser.email, email)));
    const sys = await systemCtx(inv.tenantId);
    const actor = await actorForUser(u!);
    await db.tx(async (q) => {
      if (inv.projectId && inv.projectRole) {
        await q
          .insert(projectMember)
          .values({ tenantId: inv.tenantId, projectId: inv.projectId, principalId: actor.principalId, role: inv.projectRole as "member" })
          .onConflictDoNothing();
      }
      const ctx = { ...sys, actor };
      await d.events.emit(ctx, { type: "invitation.accepted", aggregateType: "invitation", aggregateId: inv.id, payload: { userId: u!.id } });
      await d.audit.write(ctx, { action: "invitation.accept", resourceType: "invitation", resourceId: inv.id, after: { userId: u!.id } });
    });
    return { token: await signIn(email, input.password) };
  }

  async function listUsers(ctx: Ctx) {
    await require(ctx, "admin.users");
    const rows = await db.root.select().from(appUser).where(eq(appUser.tenantId, ctx.tenantId)).orderBy(asc(appUser.createdAt));
    const prins = await db.root
      .select()
      .from(principal)
      .where(and(eq(principal.tenantId, ctx.tenantId), eq(principal.kind, "human")));
    return rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      tenantRole: u.tenantRole,
      status: u.status,
      principalId: prins.find((p) => p.refId === u.id)?.id ?? null,
      createdAt: u.createdAt.toISOString(),
    }));
  }

  /** Change role / disable. Disabling revokes all sessions immediately (§9.4). */
  async function updateUser(ctx: Ctx, userId: string, patch: { tenantRole?: TenantRole; status?: "active" | "disabled"; successorPrincipalId?: string; reason?: string }) {
    await require(ctx, "admin.users");
    const [u] = await db.root
      .select()
      .from(appUser)
      .where(and(eq(appUser.id, userId), eq(appUser.tenantId, ctx.tenantId)));
    if (!u) throw notFound("用户");
    if (patch.tenantRole === "owner" && ctx.actor.tenantRole !== "owner") throw forbidden("Tenant Owner");
    if (u.id === ctx.actor.userId && patch.status === "disabled") throw new DomainError("conflict", "不能停用自己");
    const actor = await actorForUser(u);
    const orphanTasks: string[] = [];
    await db.tx(async (q) => {
      if (patch.status === "disabled") {
        // TSK-补6 / §9.4: tasks where this user is the only human owner need a successor.
        const owned = await q
          .select({ taskId: taskOwner.taskId })
          .from(taskOwner)
          .innerJoin(task, eq(task.id, taskOwner.taskId))
          .where(and(eq(taskOwner.principalId, actor.principalId), eq(taskOwner.role, "owner"), eq(task.tenantId, ctx.tenantId)));
        for (const o of owned) {
          const others = await q
            .select()
            .from(taskOwner)
            .innerJoin(principal, eq(principal.id, taskOwner.principalId))
            .where(and(eq(taskOwner.taskId, o.taskId), eq(taskOwner.role, "owner"), eq(principal.kind, "human")));
          if (others.filter((x) => x.task_owner.principalId !== actor.principalId).length === 0) {
            if (patch.successorPrincipalId) {
              await q.insert(taskOwner).values({ taskId: o.taskId, principalId: patch.successorPrincipalId, role: "owner" }).onConflictDoNothing();
            } else orphanTasks.push(o.taskId);
          }
        }
        if (orphanTasks.length > 0) throw new DomainError("conflict", `该用户是 ${orphanTasks.length} 个任务的唯一 owner，请先指定继任者`, { taskIds: orphanTasks });
      }
      await q
        .update(appUser)
        .set({ tenantRole: patch.tenantRole ?? u.tenantRole, status: patch.status ?? u.status, sessionVersion: u.sessionVersion + (patch.status === "disabled" ? 1 : 0), updatedAt: new Date() })
        .where(eq(appUser.id, u.id));
      await d.events.emit(ctx, { type: "user.updated", aggregateType: "user", aggregateId: u.id, payload: { status: patch.status ?? null, tenantRole: patch.tenantRole ?? null } });
      await d.audit.write(ctx, {
        action: patch.status === "disabled" ? "user.disable" : "user.update",
        resourceType: "user",
        resourceId: u.id,
        before: { tenantRole: u.tenantRole, status: u.status },
        after: patch,
      });
    });
    if (patch.status === "disabled" && u.authUserId) {
      const c = await d.getAuth().$context;
      await c.internalAdapter.deleteUserSessions(u.authUserId);
    }
    return { ok: true };
  }

  async function resetLink(ctx: Ctx, userId: string) {
    await require(ctx, "admin.users");
    const [u] = await db.root
      .select()
      .from(appUser)
      .where(and(eq(appUser.id, userId), eq(appUser.tenantId, ctx.tenantId)));
    if (!u) throw notFound("用户");
    const token = randomToken(24);
    const id = newId("inv");
    await db.tx(async (q) => {
      await q.insert(invitation).values({
        id,
        tenantId: ctx.tenantId,
        email: u.email,
        tenantRole: u.tenantRole,
        kind: "password_reset",
        targetUserId: u.id,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + 24 * 3600_000),
        createdBy: ctx.actor.principalId,
      });
      await d.audit.write(ctx, { action: "user.reset_link", resourceType: "user", resourceId: u.id });
    });
    return { url: `${config.publicUrl}/reset/${token}` };
  }

  async function resetPassword(token: string, password: string) {
    if (password.length < 10) throw new DomainError("invalid", "密码至少 10 位", [{ path: "/password", message: "至少 10 位" }]);
    const [inv] = await db.root
      .select()
      .from(invitation)
      .where(and(eq(invitation.tokenHash, sha256Hex(token)), eq(invitation.kind, "password_reset"), isNull(invitation.usedAt), gt(invitation.expiresAt, new Date())));
    if (!inv?.targetUserId) throw new DomainError("not_found", "重置链接无效或已过期");
    const [u] = await db.root.select().from(appUser).where(eq(appUser.id, inv.targetUserId));
    if (!u?.authUserId) throw new DomainError("not_found", "用户不存在");
    const c = await d.getAuth().$context;
    await c.internalAdapter.updatePassword(u.authUserId, await c.password.hash(password));
    await c.internalAdapter.deleteUserSessions(u.authUserId);
    await db.root.update(invitation).set({ usedAt: new Date() }).where(eq(invitation.id, inv.id));
    await d.audit.write(await systemCtx(u.tenantId), { action: "user.password_reset", resourceType: "user", resourceId: u.id });
    return { ok: true };
  }

  /** §9.5 dev one-click login: real better-auth user, normal sign-in flow. Never registered in production. */
  async function devLogin(email: string, name?: string, tenantRole?: TenantRole) {
    if (!config.auth.devLogin || config.isProd) throw notFound();
    const password = `dev-${hmacHex(config.auth.secret, email).slice(0, 24)}`;
    const [existing] = await db.root.select().from(appUser).where(eq(appUser.email, email.toLowerCase()));
    if (!existing) {
      const [first] = await db.root.select().from(tenant).orderBy(asc(tenant.createdAt)).limit(1);
      await signUpInternal({ tenantId: first?.id, tenantRole }, email.toLowerCase(), name ?? email.split("@")[0]!, password);
    }
    return { token: await signIn(email.toLowerCase(), password) };
  }

  async function onLogin(authUserId: string, ok: boolean, email: string, ip: string) {
    const [u] = ok ? await db.root.select().from(appUser).where(eq(appUser.authUserId, authUserId)) : await db.root.select().from(appUser).where(eq(appUser.email, email)).limit(1);
    if (!u) return;
    const ctx = await systemCtx(u.tenantId);
    const actor = await actorForUser(u).catch(() => ctx.actor);
    await d.audit.write({ ...ctx, actor }, { action: ok ? "auth.login" : "auth.login_failed", resourceType: "user", resourceId: u.id, outcome: ok ? "allowed" : "denied", policy: { ip } });
    if (ok) await d.rateLimiter.reset("login", `${email}|${ip}`);
  }

  return {
    onUserCreated,
    onLogin,
    rateLimitLogin: (email: string, ip: string) => d.rateLimiter.hit("login", `${email}|${ip}`),
    authenticate,
    actorForUser,
    subjectFor,
    require,
    check,
    projectInTenant,
    systemCtx,
    systemPrincipal,
    me,
    hasAnyUser,
    setup,
    signIn,
    createInvitation,
    acceptInvitation,
    listUsers,
    updateUser,
    resetLink,
    resetPassword,
    devLogin,
    authConfig: async () => ({ oidc: Boolean(config.auth.oidc), devLogin: config.auth.devLogin && !config.isProd, signupMode: config.auth.signupMode, needsSetup: !(await hasAnyUser()) }),
  };
}
export type Identity = ReturnType<typeof createIdentity>;
