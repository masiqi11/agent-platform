import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog, deadLetter, job } from "../src/db/schema";
import { createTestApp, type TestApp } from "./helpers";

/** S8 ops (§16.1, ADM-补4, FR-OBS-02): /metrics, dead-letter replay / discard, trace lookup. */
let t: TestApp;
let owner = "";
let member = "";
const METRICS_TOKEN = "metrics-token-for-tests-0001";
let jobFails = true;
let consumerFails = true;

beforeAll(async () => {
  t = await createTestApp("s8ops", { METRICS_TOKEN });
  owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "Ops", email: "o@ops.test", name: "O", password: "Correct-Horse-42" } })).body.token;
  const inv = await t.req("POST", "/api/v1/invitations", { token: owner, body: { email: "m@ops.test", tenantRole: "member" } });
  const acc = await t.req("POST", `/api/v1/invitations/${inv.body.token}/accept`, { body: { email: "m@ops.test", name: "M", password: "Correct-Horse-42" } });
  member = acc.body.token;
  t.s.jobs.register("test.flaky", async () => {
    if (jobFails) throw new Error("upstream down");
  });
  t.s.consumers.register({
    name: "test-flaky-consumer",
    types: ["project.created"],
    async handle() {
      if (consumerFails) throw new Error("consumer bug");
    },
  });
  await t.s.consumers.init();
});
afterAll(async () => {
  await t?.close();
});

const metrics = (token?: string) => t.app.handle(new Request("http://localhost/metrics", { headers: token ? { authorization: `Bearer ${token}` } : {} }));

describe("S8 /metrics", () => {
  test("requires the metrics token", async () => {
    expect((await metrics()).status).toBe(401);
    expect((await metrics("wrong-token-of-same-size-01")).status).toBe(401);
  });
  test("exposes request counters by route template plus database gauges", async () => {
    await t.req("GET", "/api/v1/projects", { token: owner });
    const r = await metrics(METRICS_TOKEN);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");
    const text = await r.text();
    expect(text).toMatch(/ap_http_requests_total\{method="GET",route="\/api\/v1\/projects",status="200"\} \d+/);
    expect(text).toContain("ap_http_request_duration_seconds_bucket");
    for (const name of ["ap_event_consumer_lag", 'ap_jobs{status="dead"}', "ap_dead_letters_open", "ap_sessions_active", "ap_llm_tokens", "ap_merge_queue_length"]) expect(text).toContain(name);
    // Raw ids never become label values.
    expect(text).not.toMatch(/route="[^"]*[a-z]{3}_[0-9a-z]{10,}/);
    expect(text).toContain('route="/api/v1/invitations/:token/accept"');
  });
});

describe("S8 dead letters (ADM-补4)", () => {
  test("a job that keeps failing lands in the dead letters; replay requeues it and it then succeeds", async () => {
    const id = (await t.s.jobs.enqueue("test.flaky", {}, { maxAttempts: 1 }))!;
    await t.s.jobs.drain();
    expect((await t.s.db.root.select().from(job).where(eq(job.id, id)))[0]!.status).toBe("dead");
    const list = await t.req("GET", "/api/v1/admin/dead-letters", { token: owner });
    const dl = (list.body as Array<{ id: string; refId: string; summary: string; error: string; state: string }>).find((x) => x.refId === id)!;
    expect(dl).toMatchObject({ summary: "test.flaky", state: "open" });
    expect(dl.error).toContain("upstream down");
    // Members cannot see or act on dead letters.
    expect((await t.req("GET", "/api/v1/admin/dead-letters", { token: member })).status).toBe(403);
    expect((await t.req("POST", `/api/v1/admin/dead-letters/${dl.id}/replay`, { token: member })).status).toBe(403);

    jobFails = false;
    expect((await t.req("POST", `/api/v1/admin/dead-letters/${dl.id}/replay`, { token: owner })).status).toBe(200);
    await t.s.jobs.drain();
    expect((await t.s.db.root.select().from(job).where(eq(job.id, id)))[0]!.status).toBe("succeeded");
    // Replayed once: a second replay is refused.
    expect((await t.req("POST", `/api/v1/admin/dead-letters/${dl.id}/replay`, { token: owner })).status).toBe(409);
    expect((await t.req("GET", "/api/v1/admin/dead-letters", { token: owner })).body.some((x: { id: string }) => x.id === dl.id)).toBe(false);
  });

  test("an event a consumer can't handle: replay fails while the bug is there, succeeds after; discard is audited", async () => {
    await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "OPS", name: "运维" } });
    await t.s.consumers.drain();
    const rows = await t.s.db.root.select().from(deadLetter).where(eq(deadLetter.consumer, "test-flaky-consumer"));
    expect(rows).toHaveLength(1);
    const r1 = await t.req("POST", `/api/v1/admin/dead-letters/${rows[0]!.id}/replay`, { token: owner });
    expect(r1.status).toBe(409);
    expect(r1.body.message).toContain("consumer bug");
    consumerFails = false;
    expect((await t.req("POST", `/api/v1/admin/dead-letters/${rows[0]!.id}/replay`, { token: owner })).status).toBe(200);

    // A second failure, discarded with a reason.
    consumerFails = true;
    await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "OPS2", name: "运维二" } });
    await t.s.consumers.drain();
    const open = (await t.req("GET", "/api/v1/admin/dead-letters", { token: owner })).body as Array<{ id: string }>;
    expect(open).toHaveLength(1);
    expect((await t.req("POST", `/api/v1/admin/dead-letters/${open[0]!.id}/discard`, { token: owner, body: { reason: "已手工补数据" } })).status).toBe(200);
    const [a] = await t.s.db.root.select().from(auditLog).where(eq(auditLog.action, "dead_letter.discard"));
    expect(a!.after).toMatchObject({ reason: "已手工补数据" });
    const all = (await t.req("GET", "/api/v1/admin/dead-letters?state=all", { token: owner })).body as Array<{ id: string; state: string }>;
    expect(all.find((x) => x.id === open[0]!.id)!.state).toBe("discarded");
  });
});

describe("S8 trace lookup (FR-OBS-02)", () => {
  test("a request's trace id finds its events and audit entries; a task id finds every trace that touched it", async () => {
    const res = await t.app.handle(
      new Request("http://localhost/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${owner}`, "x-request-id": "trc_testlookup01" },
        body: JSON.stringify({ key: "TRC", name: "追踪" }),
      }),
    );
    expect(res.headers.get("x-request-id")).toBe("trc_testlookup01");
    const projectId = ((await res.json()) as { id: string }).id;
    const tr = await t.req("GET", "/api/v1/admin/traces?traceId=trc_testlookup01", { token: owner });
    expect(tr.body.items.some((i: { kind: string; name: string }) => i.kind === "event" && i.name === "project.created")).toBe(true);
    expect(tr.body.items.some((i: { kind: string }) => i.kind === "audit")).toBe(true);

    const tk = await t.req("POST", "/api/v1/tasks", { token: owner, body: { projectId, title: "追踪链路" } });
    await t.req("PATCH", `/api/v1/tasks/${tk.body.id}`, { token: owner, body: { title: "追踪链路（改）" }, headers: { "if-match": String(tk.body.version) } });
    const byTask = await t.req("GET", `/api/v1/admin/traces?taskId=${tk.body.id}`, { token: owner });
    expect(byTask.body.traceIds.length).toBeGreaterThanOrEqual(2);
    expect(byTask.body.items.filter((i: { kind: string }) => i.kind === "event").length).toBeGreaterThanOrEqual(2);
  });
});

describe("S8 route labels", () => {
  test("ids, numbers and long tokens collapse to :id; static files are one label", async () => {
    const { routeOf } = await import("../src/app");
    expect(routeOf("/api/v1/tasks/tsk_01a1e82096e3000kybqe1a1/transition")).toBe("/api/v1/tasks/:id/transition");
    expect(routeOf("/api/v1/projects/prj_01a1e8/agents")).toBe("/api/v1/projects/prj_01a1e8/agents"); // too short to be an id: kept
    expect(routeOf("/api/v1/tasks/42")).toBe("/api/v1/tasks/:id");
    expect(routeOf("/assets/index-abc123.js")).toBe("static");
    expect(routeOf("/metrics")).toBe("/metrics");
  });
});
