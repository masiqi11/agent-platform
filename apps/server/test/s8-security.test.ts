import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createOutboundGuard, isInternalAddress } from "../src/core/outbound";
import { auditLog, modelProvider } from "../src/db/schema";
import { createTestApp, type TestApp } from "./helpers";

/** §14.5 SSRF guard and HSTS; §14.3 credential use audited. */
describe("§14.5 outbound guard (unit)", () => {
  test("internal ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd12::1", "::ffff:10.0.0.1"])
      expect(isInternalAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isInternalAddress(ip)).toBe(false);
  });
  test("enforced: internal refused unless allowlisted (host, host:port, CIDR); metadata refused always", async () => {
    const g = createOutboundGuard({ enforce: true, allow: ["127.0.0.1:11434", "gitlab.internal", "10.20.0.0/16"] });
    await expect(g.check("http://127.0.0.1:5432/")).rejects.toThrow("内网地址");
    await expect(g.check("http://127.0.0.1:11434/v1")).resolves.toBeUndefined();
    await expect(g.check("http://10.20.3.4/api")).resolves.toBeUndefined();
    await expect(g.check("http://10.21.3.4/api")).rejects.toThrow("内网地址");
    await expect(g.check("http://169.254.169.254/latest/meta-data/")).rejects.toThrow("云元数据");
    await expect(g.check("http://localhost:8080/")).rejects.toThrow("内网地址"); // names are resolved
    await expect(g.check("file:///etc/passwd")).rejects.toThrow("协议");
    const open = createOutboundGuard({ enforce: false, allow: [] });
    await expect(open.check("http://127.0.0.1:5432/")).resolves.toBeUndefined();
    await expect(open.check("http://169.254.169.254/")).rejects.toThrow("云元数据"); // even when not enforced
  });
});

describe("§14.5 / §14.3 in the running app", () => {
  let t: TestApp;
  let owner = "";
  let upstream: ReturnType<typeof Bun.serve>;
  let hits = 0;
  beforeAll(async () => {
    upstream = Bun.serve({
      port: 0,
      fetch: () => {
        hits++;
        return Response.json({ choices: [{ message: { role: "assistant", content: "pong" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    t = await createTestApp("s8sec", { OUTBOUND_GUARD: "on", PUBLIC_URL: "https://agents.example.com", TRUSTED_ORIGINS: "https://agents.example.com" });
    owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "Sec", email: "o@sec.test", name: "O", password: "Correct-Horse-42" } })).body.token;
  });
  afterAll(async () => {
    void upstream?.stop(true);
    await t?.close();
  });

  test("HSTS on an https deployment", async () => {
    const r = await t.app.handle(new Request("http://localhost/healthz"));
    expect(r.headers.get("strict-transport-security")).toContain("max-age=");
  });

  test("a provider pointing at an internal address is never called; allowlisting it lets it through; key use is audited", async () => {
    const add = await t.req("POST", "/api/v1/admin/models/providers", {
      token: owner,
      body: { name: "内网", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, dialect: "openai", isExternal: false, apiKey: "sk-internal-provider-key-000001", models: [{ name: "inner" }] },
    });
    expect(add.status).toBe(200);
    const [p] = await t.s.db.root.select().from(modelProvider).where(eq(modelProvider.name, "内网"));
    const r1 = await t.req("POST", `/api/v1/admin/models/providers/${p!.id}/test`, { token: owner });
    expect(JSON.stringify(r1.body)).toContain("内网地址");
    expect(hits).toBe(0);

    t.s.config.outbound.allow.push(`127.0.0.1:${upstream.port}`);
    // The guard captured the list by reference: allowlisting takes effect without a restart.
    const r2 = await t.req("POST", `/api/v1/admin/models/providers/${p!.id}/test`, { token: owner });
    expect(r2.body.ok).toBe(true);
    expect(hits).toBe(1);
    await t.req("POST", `/api/v1/admin/models/providers/${p!.id}/test`, { token: owner });
    const uses = await t.s.db.root
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "credential.use"), eq(auditLog.resourceId, p!.credentialId!)));
    expect(uses).toHaveLength(1); // once per window, never the value
    expect(JSON.stringify(uses[0])).not.toContain("sk-internal-provider-key");
  });

  test("binding a GitLab repo at an internal address is refused before any request", async () => {
    const proj = await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "SEC", name: "安全" } });
    const r = await t.req("POST", `/api/v1/projects/${proj.body.id}/repos/preflight`, {
      token: owner,
      body: { provider: "gitlab", name: "x", url: "http://192.168.10.5/group/x", token: "glpat-xxxxxxxxxxxxxxxxxxxx" },
    });
    expect(r.status).toBe(403);
    expect(r.body.message).toContain("内网地址");
  });
});
