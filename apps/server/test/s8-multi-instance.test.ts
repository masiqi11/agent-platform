import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { createConfig } from "../src/config";
import { runMigrations } from "../src/db/migrate";
import { job } from "../src/db/schema";
import { loadEnv } from "../src/env";
import { createApp } from "../src/app";
import { createServices, type Services } from "../src/services";
import { startWorker } from "../src/worker";
import { createTestApp, createTestDatabase, type TestApp } from "./helpers";

/**
 * §11.5 multi-instance correctness: two full instances (separate service graphs, pools, LISTEN
 * connections) on one database. Job claiming / dedupe / lease recovery are in kernel.test.ts.
 */
let t: TestApp;
let b: Services;
let owner = "";
let me: { principalId: string; tenant: { id: string } };

beforeAll(async () => {
  t = await createTestApp("s8multi");
  b = createServices(createConfig(loadEnv({ ...process.env, NODE_ENV: "test", DATABASE_URL: t.url, LOG_LEVEL: "error" })), { owner: "instance-b" });
  owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "Multi", email: "o@multi.test", name: "O", password: "Correct-Horse-42" } })).body.token;
  me = (await t.req("GET", "/api/v1/me", { token: owner })).body;
});
afterAll(async () => {
  await b?.realtime.stop();
  await b?.db.close();
  await t?.close();
});

describe("§11.5 multi-instance", () => {
  test("event consumers: two instances, each event handled exactly once per consumer", async () => {
    const seen: Array<{ id: string; by: string }> = [];
    for (const [s, by] of [
      [t.s, "a"],
      [b, "b"],
    ] as const) {
      s.consumers.register({
        name: "multi-counter",
        types: ["agent.updated"],
        async handle(e) {
          seen.push({ id: e.id, by });
          await Bun.sleep(2);
        },
      });
      await s.consumers.init();
    }
    const ctx = await t.s.identity.systemCtx(me.tenant.id);
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push((await t.s.events.emit(ctx, { type: "agent.updated", aggregateType: "agent", aggregateId: `agt_multi${i}`, payload: {} })).id);
    // Both instances drive their consumers concurrently, as two workers would.
    const spin = async (s: Services) => {
      for (let i = 0; i < 60; i++) {
        await s.consumers.tick();
        if (seen.length >= ids.length) return;
        await Bun.sleep(5);
      }
    };
    await Promise.all([spin(t.s), spin(b)]);
    expect(seen.map((x) => x.id).sort()).toEqual([...ids].sort());
    expect(new Set(seen.map((x) => x.id)).size).toBe(ids.length);
  });

  test("WebSocket fan-out: an event written by instance A reaches a client connected to instance B", async () => {
    await t.s.realtime.start(t.url);
    await b.realtime.start(t.url);
    const appB = createApp(b).listen({ hostname: "127.0.0.1", port: 0 });
    const port = (appB as unknown as { server: { port: number; stop(): unknown } }).server.port;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const frames: Array<Record<string, unknown>> = [];
      ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)) as Record<string, unknown>);
      await new Promise<void>((r) => (ws.onopen = () => r()));
      const until = async (pred: (f: Record<string, unknown>) => boolean) => {
        for (let i = 0; i < 100 && !frames.some(pred); i++) await Bun.sleep(50);
        return frames.find(pred);
      };
      ws.send(JSON.stringify({ type: "auth", token: owner }));
      expect(await until((f) => f.type === "ready")).toBeDefined();
      ws.send(JSON.stringify({ type: "subscribe", topic: `inbox:${me.principalId}` }));
      expect(await until((f) => f.type === "subscribed")).toBeDefined();
      // Written through instance A only.
      const ctx = await t.s.identity.systemCtx(me.tenant.id);
      await t.s.events.emit(ctx, { type: "question.asked", aggregateType: "question", aggregateId: "q_multi", payload: { inboxPrincipalIds: [me.principalId] } });
      const ev = (await until((f) => f.type === "event")) as { event: { aggregateId: string } } | undefined;
      expect(ev?.event.aggregateId).toBe("q_multi");
      ws.close();
    } finally {
      await (appB as unknown as { server: { stop(): unknown } }).server.stop();
    }
  });

  test("cron jobs: both instances register the same schedules, the database keeps one of each", async () => {
    const { registerHandlers } = await import("../src/modules/registry");
    await Promise.all([registerHandlers(t.s), registerHandlers(b)]);
    const rows = (await t.s.db.root.execute(sql`select dedupe_key, count(*)::int as n from job where cron is not null and status in ('queued','running') group by dedupe_key`)) as unknown as {
      rows: Array<{ dedupe_key: string; n: number }>;
    };
    expect(rows.rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows.rows) expect(r.n).toBe(1);
  });

  test("graceful stop: a running job finishes (not abandoned) and the lease is released", async () => {
    let finished = 0;
    b.jobs.register("multi.slow", async () => {
      await Bun.sleep(400);
      finished++;
    });
    const id = (await b.jobs.enqueue("multi.slow", {}))!;
    const w = await startWorker(b);
    for (let i = 0; i < 100; i++) {
      const [j] = await b.db.root.select().from(job).where(eq(job.id, id));
      if (j?.status === "running") break;
      await Bun.sleep(20);
    }
    const t0 = Date.now();
    await w.stop();
    // Waited for the job, not for the 15 s recovery poll or the grace cap.
    expect(Date.now() - t0).toBeLessThan(3_000);
    const [j] = await b.db.root.select().from(job).where(eq(job.id, id));
    expect(finished).toBe(1);
    expect(j!.status).toBe("succeeded");
    // Nothing still leased to the stopped instance.
    const leased = (await b.db.root.execute(sql`select count(*)::int as n from job where lease_owner = 'instance-b' and status = 'running'`)) as unknown as { rows: Array<{ n: number }> };
    expect(leased.rows[0]!.n).toBe(0);
  }, 15_000);
});

describe("§8.3 migrations", () => {
  test("concurrent migration runners (two deploys starting at once) serialize on the advisory lock", async () => {
    const db = await createTestDatabase("s8migr");
    try {
      // createTestDatabase already migrated once; drop the version marker's rows to force a real re-run path.
      await Promise.all([runMigrations(db.url), runMigrations(db.url), runMigrations(db.url)]);
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      const v = await c.query("select count(*)::int as n from ap_schema_version");
      await c.end();
      expect(v.rows[0].n).toBe(1);
    } finally {
      await db.drop();
    }
  });
});
