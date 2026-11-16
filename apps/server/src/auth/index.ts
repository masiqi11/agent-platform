import { AsyncLocalStorage } from "node:async_hooks";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { bearer } from "better-auth/plugins/bearer";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import type { Config } from "../config";
import type { Database } from "../db";
import { authAccount, authSession, authUser, authVerification } from "../db/schema";

/** Context for internally initiated sign-ups (setup, invitation, dev login, admin create). */
export interface SignupGrant {
  tenantId?: string;
  tenantRole?: "owner" | "admin" | "member" | "viewer" | "auditor";
  invitationId?: string;
}
export const signupGrant = new AsyncLocalStorage<SignupGrant>();

export interface AuthHooks {
  /** Binds/creates app_user + principal in one transaction (§9.2). */
  onUserCreated(user: { id: string; email: string; name: string }, grant: SignupGrant | undefined, viaOidc: boolean): Promise<void>;
  onLogin(authUserId: string, ok: boolean, email: string, ip: string): Promise<void>;
  rateLimitLogin(email: string, ip: string): Promise<void>;
}

const WEAK = new Set(["password123", "1234567890", "qwertyuiop", "password1234", "abcdefghij", "1111111111", "0000000000", "iloveyou12", "admin12345", "12345678910"]);

export function createAuth(config: Config, db: Database, hooks: AuthHooks) {
  const plugins = [bearer()] as const;
  const oidcPlugin = config.auth.oidc
    ? genericOAuth({
        config: [
          {
            providerId: "oidc",
            clientId: config.auth.oidc.clientId,
            clientSecret: config.auth.oidc.clientSecret,
            discoveryUrl: `${config.auth.oidc.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
            scopes: ["openid", "email", "profile"],
            pkce: true,
          },
        ],
      })
    : null;

  const auth = betterAuth({
    appName: "Agent Platform",
    secret: config.auth.secret,
    baseURL: config.auth.url,
    basePath: "/api/auth",
    trustedOrigins: config.trustedOrigins,
    telemetry: { enabled: false },
    database: drizzleAdapter(db.root, { provider: "pg", schema: { user: authUser, session: authSession, account: authAccount, verification: authVerification } }),
    emailAndPassword: { enabled: true, requireEmailVerification: false, minPasswordLength: 10, maxPasswordLength: 128, autoSignIn: false },
    session: { expiresIn: 12 * 3600, disableSessionRefresh: true },
    account: { accountLinking: { enabled: true, trustedProviders: ["oidc"] } },
    plugins: oidcPlugin ? [...plugins, oidcPlugin] : [...plugins],
    advanced: { database: { generateId: () => crypto.randomUUID() } },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-in/email") {
          const body = (ctx.body ?? {}) as { email?: string };
          const ip = ctx.request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
          await hooks.rateLimitLogin(String(body.email ?? "").toLowerCase(), ip);
        }
        if (ctx.path === "/sign-up/email") {
          const body = (ctx.body ?? {}) as { password?: string; email?: string };
          if (body.password && WEAK.has(body.password.toLowerCase())) throw new APIError("BAD_REQUEST", { message: "密码过于常见，请换一个" });
          // Self sign-up gate (§9.4). better-auth masks errors thrown from DB hooks on this path,
          // so the gate runs here; the DB hook below stays as defence in depth (OIDC path).
          if (!signupGrant.getStore()) {
            const mode = config.auth.signupMode;
            const domain =
              String(body.email ?? "")
                .split("@")[1]
                ?.toLowerCase() ?? "";
            const allowed = mode === "open" || (mode === "domain" && config.auth.allowedDomains.includes(domain));
            if (!allowed) throw new APIError("FORBIDDEN", { message: mode === "invite" ? "当前只能通过邀请链接注册" : "该邮箱域不允许自助注册，请联系管理员" });
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return;
        const body = (ctx.body ?? {}) as { email?: string };
        const ip = ctx.request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
        const newSession = ctx.context.newSession;
        await hooks.onLogin(newSession?.user.id ?? "", Boolean(newSession), String(body.email ?? "").toLowerCase(), ip);
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            const grant = signupGrant.getStore();
            if (grant) return;
            const viaOidc = Boolean(ctx?.path?.includes("callback") || ctx?.path?.includes("oauth"));
            const domain = String(user.email).split("@")[1]?.toLowerCase() ?? "";
            const mode = viaOidc ? "domain" : config.auth.signupMode;
            if (mode === "open") return;
            if (mode === "domain" && config.auth.allowedDomains.includes(domain)) return;
            throw new APIError("FORBIDDEN", { message: mode === "invite" ? "当前只能通过邀请链接注册" : "该邮箱域不允许自助注册，请联系管理员" });
          },
          after: async (user, ctx) => {
            const viaOidc = Boolean(ctx?.path?.includes("callback") || ctx?.path?.includes("oauth"));
            await hooks.onUserCreated({ id: user.id, email: String(user.email).toLowerCase(), name: user.name }, signupGrant.getStore(), viaOidc);
          },
        },
      },
    },
  });
  return auth;
}
export type Auth = ReturnType<typeof createAuth>;
