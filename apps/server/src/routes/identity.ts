import { Elysia, t } from "elysia";
import { base } from "../http";
import { Ok } from "../schemas";
import type { Services } from "../services";

const TenantRole = t.Union([t.Literal("owner"), t.Literal("admin"), t.Literal("member"), t.Literal("viewer"), t.Literal("auditor")]);
const ProjectRole = t.Union([t.Literal("maintainer"), t.Literal("member"), t.Literal("viewer")]);
const Token = t.Object({ token: t.String() });
const Me = t.Object({
  principalId: t.String(),
  kind: t.String(),
  displayName: t.String(),
  userId: t.Union([t.String(), t.Null()]),
  email: t.Union([t.String(), t.Null()]),
  tenantRole: t.Union([t.String(), t.Null()]),
  tenant: t.Object({ id: t.String(), name: t.String(), timezone: t.String(), locale: t.String() }),
});
const User = t.Object({ id: t.String(), email: t.String(), name: t.String(), tenantRole: t.String(), status: t.String(), principalId: t.Union([t.String(), t.Null()]), createdAt: t.String() });
const Password = t.String({ minLength: 10, maxLength: 128 });
const Email = t.String({ format: "email", maxLength: 200 });

export const identityRoutes = (s: Services) =>
  new Elysia({ prefix: "/api/v1" })
    .use(base(s))
    .get("/auth/config", { response: t.Object({ oidc: t.Boolean(), devLogin: t.Boolean(), signupMode: t.String(), needsSetup: t.Boolean() }) }, () => s.identity.authConfig())
    .post(
      "/auth/sign-in",
      { body: t.Object({ email: Email, password: t.String({ minLength: 1, maxLength: 128 }) }), response: Token },
      async ({ body }) => ({ token: await s.identity.signIn(body.email.toLowerCase(), body.password) }),
    )
    .post("/auth/sign-out", { response: Ok }, async ({ request }) => {
      await s.auth.api.signOut({ headers: request.headers }).catch(() => {});
      return { ok: true };
    })
    .post(
      "/setup",
      { body: t.Object({ tenantName: t.String({ minLength: 1, maxLength: 80 }), domain: t.Optional(t.String({ maxLength: 120 })), timezone: t.Optional(t.String({ maxLength: 60 })), email: Email, name: t.String({ minLength: 1, maxLength: 60 }), password: Password }), response: t.Object({ tenantId: t.String(), token: t.String() }) },
      ({ body }) => s.identity.setup(body),
    )
    .post("/auth/dev-login", { body: t.Object({ email: Email, name: t.Optional(t.String({ maxLength: 60 })), tenantRole: t.Optional(TenantRole) }), response: Token }, ({ body }) => s.identity.devLogin(body.email, body.name, body.tenantRole))
    .get("/me", { response: Me }, async ({ auth }) => s.identity.me(await auth()))
    .get("/users", { response: t.Array(User) }, async ({ auth }) => s.identity.listUsers(await auth()))
    .patch(
      "/users/:id",
      { params: t.Object({ id: t.String() }), body: t.Object({ tenantRole: t.Optional(TenantRole), status: t.Optional(t.Union([t.Literal("active"), t.Literal("disabled")])), successorPrincipalId: t.Optional(t.String()) }), response: Ok },
      async ({ auth, params, body }) => s.identity.updateUser(await auth(), params.id, body),
    )
    .post("/users/:id/reset-link", { params: t.Object({ id: t.String() }), response: t.Object({ url: t.String() }) }, async ({ auth, params }) => s.identity.resetLink(await auth(), params.id))
    .post("/auth/reset", { body: t.Object({ token: t.String({ minLength: 10 }), password: Password }), response: Ok }, ({ body }) => s.identity.resetPassword(body.token, body.password))
    .post(
      "/invitations",
      { body: t.Object({ email: t.Optional(Email), tenantRole: TenantRole, projectId: t.Optional(t.String()), projectRole: t.Optional(ProjectRole), ttlHours: t.Optional(t.Integer({ minimum: 1, maximum: 720 })) }), response: t.Object({ id: t.String(), token: t.String(), url: t.String(), expiresAt: t.String() }) },
      async ({ auth, body }) => s.identity.createInvitation(await auth(), body),
    )
    .post(
      "/invitations/:token/accept",
      { params: t.Object({ token: t.String() }), body: t.Object({ email: Email, name: t.String({ minLength: 1, maxLength: 60 }), password: Password }), response: Token },
      ({ params, body }) => s.identity.acceptInvitation(params.token, body),
    );
