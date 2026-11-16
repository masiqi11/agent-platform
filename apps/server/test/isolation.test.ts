import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signupGrant } from "../src/auth";
import { eq } from "drizzle-orm";
import { decision, modelProvider, question, repo, session, tenant } from "../src/db/schema";
import { newId } from "../src/core/ids";
import { createTestApp, type TestApp } from "./helpers";

/**
 * INV-11 framework (§9.7 / S1): enumerate every route that takes an id, call it with tenant B's
 * session using ids that belong to tenant A, and require 404/403 — never data. New routes are
 * picked up automatically; a route whose param has no fixture fails the test so it can't be skipped.
 */
let t: TestApp;
const PW = "Correct-Horse-42";
let tokenB = "";
const fixtures: Record<string, string> = {};

/** Routes that are intentionally public or token-addressed (the token itself is the secret). */
// Webhooks authenticate with their own per-repo secret (X-Gitlab-Token); covered by s5-scm.test.ts.
const PUBLIC = new Set(["POST /api/v1/invitations/:token/accept", "GET /api/v1/attachments/:id/raw", "POST /api/v1/webhooks/gitlab/:id"]);

/** `:id` resolves by the collection segment before it (e.g. /groups/:id → a group of tenant A). */
function fixtureFor(path: string, param: string): string | undefined {
  if (param !== "id") return fixtures[param];
  const seg = path.split("/");
  const i = seg.indexOf(":id");
  return fixtures[seg[i - 1]!];
}

beforeAll(async () => {
  t = await createTestApp("isolation");
  const a = await t.req("POST", "/api/v1/setup", { body: { tenantName: "A", email: "a@a.test", name: "A", password: PW } });
  const meA = (await t.req("GET", "/api/v1/me", { token: a.body.token })).body;
  fixtures.users = meA.userId;
  fixtures.principalId = meA.principalId;
  const proj = await t.req("POST", "/api/v1/projects", { token: a.body.token, body: { key: "ISO", name: "隔离" } });
  fixtures.projects = proj.body.id;
  fixtures.groups = proj.body.mainGroupId;
  fixtures.agents = proj.body.captainAgentId;
  const msg = await t.req("POST", `/api/v1/groups/${proj.body.mainGroupId}/messages`, { token: a.body.token, body: { body: "机密" } });
  fixtures.messages = msg.body.message.id;
  const fd = new FormData();
  fd.append("file", new File(["secret"], "s.txt", { type: "text/plain" }));
  const up = await t.app.handle(new Request(`http://localhost/api/v1/groups/${proj.body.mainGroupId}/attachments`, { method: "POST", headers: { authorization: `Bearer ${a.body.token}` }, body: fd }));
  fixtures.attachments = ((await up.json()) as { id: string }).id;
  const tk = await t.req("POST", "/api/v1/tasks", { token: a.body.token, body: { projectId: proj.body.id, title: "机密任务" } });
  fixtures.tasks = tk.body.id;
  const sys = await t.s.identity.systemCtx(meA.tenant.id);
  const prp = await t.s.proposals.create(sys, {
    projectId: proj.body.id,
    groupId: proj.body.mainGroupId,
    kind: "create_task",
    payload: { title: "机密提议" },
    sourceMessageIds: [msg.body.message.id],
  });
  fixtures.proposals = prp.id;
  const apv = await t.req("POST", `/api/v1/tasks/${tk.body.id}/approvals`, { token: a.body.token, body: { kind: "budget" } });
  fixtures.approvals = apv.body.id;
  // S4: decisions, questions, sessions, model providers.
  const tA = meA.tenant.id as string;
  fixtures.decisions = newId("dcs");
  await t.s.db.root.insert(decision).values({ id: fixtures.decisions, tenantId: tA, projectId: proj.body.id, groupId: proj.body.mainGroupId, text: "机密决策" });
  fixtures.action = "confirm";
  fixtures.questions = newId("qst");
  await t.s.db.root.insert(question).values({ id: fixtures.questions, tenantId: tA, groupId: proj.body.mainGroupId, text: "机密问题", deadlineAt: new Date(Date.now() + 3600_000) });
  fixtures.sessions = newId("ses");
  await t.s.db.root
    .insert(session)
    .values({ id: fixtures.sessions, tenantId: tA, agentId: proj.body.captainAgentId, projectId: proj.body.id, scopeType: "resident", scopeId: proj.body.mainGroupId, agentConfigVersion: 1 });
  await t.s.llm.ensureDefaults(tA);
  fixtures.providers = (await t.s.db.root.select().from(modelProvider).where(eq(modelProvider.tenantId, tA)))[0]!.id;
  // S5: a repo of tenant A (row only; no files needed for the isolation check).
  fixtures.repos = newId("rep");
  await t.s.db.root.insert(repo).values({ id: fixtures.repos, tenantId: tA, projectId: proj.body.id, name: "iso", provider: "local", externalId: "iso.git", url: "/nonexistent/iso.git" });
  // Tenant B (second tenant created directly; self-host normally has one).
  const tb = newId("ten");
  await t.s.db.root.insert(tenant).values({ id: tb, name: "B", domain: "b.test" });
  await signupGrant.run({ tenantId: tb, tenantRole: "owner" }, () => t.s.auth.api.signUpEmail({ body: { email: "b@b.test", name: "B", password: PW } }));
  tokenB = await t.s.identity.signIn("b@b.test", PW);
  // Seed audit rows in A so list endpoints have something to leak.
  await t.req("POST", "/api/v1/invitations", { token: a.body.token, body: { tenantRole: "member" } });
});
afterAll(async () => t?.close());

describe("INV-11 tenant isolation (route enumeration)", () => {
  test("every id-bearing route rejects cross-tenant access", async () => {
    const routes = (t.app as unknown as { routes: Array<{ method: string; path: string }> }).routes.filter((r) => r.path.includes(":") && r.path.startsWith("/api/v1"));
    expect(routes.length).toBeGreaterThan(0);
    const checked: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.path}`;
      if (PUBLIC.has(key)) continue;
      const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => m[1]!);
      for (const p of params) if (!fixtureFor(r.path, p)) throw new Error(`no isolation fixture for param :${p} in ${key}`);
      const path = r.path.replace(/:(\w+)/g, (_, p: string) => fixtureFor(r.path, p)!);
      const res = await t.req(r.method, path, { token: tokenB, body: r.method === "GET" ? undefined : {} });
      if (![400, 403, 404].includes(res.status)) console.log("LEAK?", key, res.status, JSON.stringify(res.body).slice(0, 200));
      expect([400, 403, 404]).toContain(res.status);
      if (res.status === 400) expect(res.body.error).toBe("invalid"); // body validation ran before lookup; still no data
      checked.push(key);
    }
    expect(checked.length).toBeGreaterThan(0);
  });

  test("tenant-scoped lists never include other tenants' rows", async () => {
    const users = await t.req("GET", "/api/v1/users", { token: tokenB });
    expect(users.status).toBe(200);
    expect(users.body.map((u: { email: string }) => u.email)).toEqual(["b@b.test"]);
    const audit = await t.req("GET", "/api/v1/audit?limit=200", { token: tokenB });
    expect(audit.body.items.every((x: { action: string }) => x.action !== "invitation.create")).toBe(true);
  });
});
