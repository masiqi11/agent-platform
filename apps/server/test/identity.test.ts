import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestApp, type TestApp } from "./helpers";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp("identity", { AUTH_SIGNUP_MODE: "invite" });
});
afterAll(async () => t?.close());

const PW = "Correct-Horse-42";
let ownerToken = "";

describe("S1 identity", () => {
  test("healthz / readyz / x-request-id", async () => {
    const h = await t.req("GET", "/healthz");
    expect(h.status).toBe(200);
    expect(h.headers.get("x-request-id")).toBeTruthy();
    const r = await t.req("GET", "/readyz");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const echo = await t.req("GET", "/healthz", { headers: { "x-request-id": "my-trace-123" } });
    expect(echo.headers.get("x-request-id")).toBe("my-trace-123");
  });

  test("unauthenticated → 401 with stable error shape", async () => {
    const r = await t.req("GET", "/api/v1/me");
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("unauthenticated");
    expect(r.body.traceId).toBeTruthy();
  });

  test("validation → 400 invalid with details", async () => {
    const r = await t.req("POST", "/api/v1/setup", { body: { tenantName: "", email: "nope", name: "x", password: "short" } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid");
    expect(Array.isArray(r.body.details)).toBe(true);
    expect(r.body.details.length).toBeGreaterThan(0);
  });

  test("setup creates owner, then is closed", async () => {
    const cfg = await t.req("GET", "/api/v1/auth/config");
    expect(cfg.body.needsSetup).toBe(true);
    const r = await t.req("POST", "/api/v1/setup", { body: { tenantName: "演示公司", email: "owner@demo.test", name: "王负责人", password: PW } });
    expect(r.status).toBe(200);
    ownerToken = r.body.token;
    const me = await t.req("GET", "/api/v1/me", { token: ownerToken });
    expect(me.status).toBe(200);
    expect(me.body.tenantRole).toBe("owner");
    expect(me.body.tenant.name).toBe("演示公司");
    const again = await t.req("POST", "/api/v1/setup", { body: { tenantName: "x", email: "x@demo.test", name: "x", password: PW } });
    expect(again.status).toBe(409);
  });

  test("invite-only signup rejects self sign-up", async () => {
    const r = await t.req("POST", "/api/auth/sign-up/email", { body: { email: "rogue@demo.test", name: "r", password: PW }, headers: { origin: "http://localhost:3000" } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const users = await t.req("GET", "/api/v1/users", { token: ownerToken });
    expect(users.body.map((u: any) => u.email)).not.toContain("rogue@demo.test");
  });

  let memberToken = "";
  let memberId = "";
  test("invitation is single use and grants role", async () => {
    const inv = await t.req("POST", "/api/v1/invitations", { token: ownerToken, body: { email: "li@demo.test", tenantRole: "member" } });
    expect(inv.status).toBe(200);
    const acc = await t.req("POST", `/api/v1/invitations/${inv.body.token}/accept`, { body: { email: "li@demo.test", name: "李开发", password: PW } });
    expect(acc.status).toBe(200);
    memberToken = acc.body.token;
    const again = await t.req("POST", `/api/v1/invitations/${inv.body.token}/accept`, { body: { email: "li2@demo.test", name: "x", password: PW } });
    expect(again.status).toBe(404);
    const me = await t.req("GET", "/api/v1/me", { token: memberToken });
    expect(me.body.tenantRole).toBe("member");
    memberId = me.body.userId;
  });

  test("member cannot manage users (403 with required)", async () => {
    const r = await t.req("GET", "/api/v1/users", { token: memberToken });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("forbidden");
    expect(r.body.details.required).toBeTruthy();
  });

  test("disabling a user revokes the session immediately", async () => {
    const r = await t.req("PATCH", `/api/v1/users/${memberId}`, { token: ownerToken, body: { status: "disabled" } });
    expect(r.status).toBe(200);
    const me = await t.req("GET", "/api/v1/me", { token: memberToken });
    expect(me.status).toBe(401);
    const login = await t.req("POST", "/api/v1/auth/sign-in", { body: { email: "li@demo.test", password: PW } });
    // better-auth still accepts the password, but the app refuses disabled users.
    if (login.status === 200) expect((await t.req("GET", "/api/v1/me", { token: login.body.token })).status).toBe(401);
  });

  test("owner cannot disable self", async () => {
    const me = await t.req("GET", "/api/v1/me", { token: ownerToken });
    const r = await t.req("PATCH", `/api/v1/users/${me.body.userId}`, { token: ownerToken, body: { status: "disabled" } });
    expect(r.status).toBe(409);
  });

  test("password reset link works once and kills old sessions", async () => {
    const inv = await t.req("POST", "/api/v1/invitations", { token: ownerToken, body: { email: "zhao@demo.test", tenantRole: "admin" } });
    const acc = await t.req("POST", `/api/v1/invitations/${inv.body.token}/accept`, { body: { email: "zhao@demo.test", name: "赵管理", password: PW } });
    const me = await t.req("GET", "/api/v1/me", { token: acc.body.token });
    const link = await t.req("POST", `/api/v1/users/${me.body.userId}/reset-link`, { token: ownerToken });
    const token = link.body.url.split("/reset/")[1];
    const r = await t.req("POST", "/api/v1/auth/reset", { body: { token, password: "Another-Horse-77" } });
    expect(r.status).toBe(200);
    expect((await t.req("GET", "/api/v1/me", { token: acc.body.token })).status).toBe(401);
    expect((await t.req("POST", "/api/v1/auth/reset", { body: { token, password: "Another-Horse-78" } })).status).toBe(404);
    const login = await t.req("POST", "/api/v1/auth/sign-in", { body: { email: "zhao@demo.test", password: "Another-Horse-77" } });
    expect(login.status).toBe(200);
  });

  test("login rate limit (5 / 15min)", async () => {
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await t.req("POST", "/api/v1/auth/sign-in", { body: { email: "owner@demo.test", password: "wrong-password-x" } })).status;
    expect(last).toBe(429);
  });

  test("audit trail records identity actions and verifies", async () => {
    const a = await t.req("GET", "/api/v1/audit?limit=200", { token: ownerToken });
    expect(a.status).toBe(200);
    const actions = a.body.items.map((x: any) => x.action);
    for (const k of ["tenant.create", "user.create", "invitation.create", "invitation.accept", "user.disable", "user.password_reset", "auth.login_failed"]) expect(actions).toContain(k);
    const v = await t.req("GET", "/api/v1/audit/verify", { token: ownerToken });
    expect(v.body.ok).toBe(true);
    const exp = await t.req("GET", "/api/v1/audit/export?format=csv", { token: ownerToken });
    expect(exp.status).toBe(200);
    expect(exp.headers.get("x-audit-sha256")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("unknown API path → 404 JSON, SPA path → fallback", async () => {
    const r = await t.req("GET", "/api/v1/nope");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not_found");
    const spa = await t.req("GET", "/projects/x");
    expect(spa.status).toBe(200);
  });
});
