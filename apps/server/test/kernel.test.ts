import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { createDatabase, type Database } from "../src/db";
import { auditLog, event, job, tenant } from "../src/db/schema";
import { createAudit } from "../src/core/audit";
import { createConsumerRunner, createEvents } from "../src/core/events";
import { createJobs } from "../src/core/jobs";
import { createIdempotency } from "../src/core/idempotency";
import { createVault, hmacHex, safeEqual, sha256Hex } from "../src/core/crypto";
import type { Ctx } from "../src/core/context";
import { createTestDatabase } from "./helpers";

let db: Database;
let drop: () => Promise<void>;
let url: string;
const ctx: Ctx = { tenantId: "ten_kernel", actor: { principalId: "prn_sys", kind: "system", displayName: "sys" }, traceId: "trace_1" };

beforeAll(async () => {
  const t = await createTestDatabase("kernel");
  url = t.url;
  drop = t.drop;
  db = createDatabase(url, 5);
  await db.root.insert(tenant).values({ id: "ten_kernel", name: "K" });
});
afterAll(async () => {
  await db.close();
  await drop();
});

describe("V3 AsyncLocalStorage transactions", () => {
  test("nested tx reuses outer; afterCommit runs once after outermost commit", async () => {
    const calls: string[] = [];
    await db.tx(async (outer) => {
      await db.tx(async (inner) => {
        expect(inner).toBe(outer);
        db.afterCommit(() => void calls.push("hook"));
      });
      expect(calls).toEqual([]);
    });
    expect(calls).toEqual(["hook"]);
  });

  test("a second pool connection inside a transaction is refused (pool deadlock under load, §15.1)", async () => {
    const { sql } = await import("drizzle-orm");
    const err = await db
      .tx(async () => db.root.execute(sql`select 1`))
      .then(
        () => null,
        (e: Error & { cause?: Error }) => e,
      );
    expect(String(err?.cause?.message ?? err?.message)).toContain("second pool connection"); // drizzle wraps it as "Failed query"
    // The ambient executor is the supported way, inside or outside a transaction.
    await expect(db.tx(async () => db.q().execute(sql`select 1`))).resolves.toBeDefined();
    expect(await db.root.execute(sql`select 1`)).toBeDefined();
  });

  test("rollback discards afterCommit hooks", async () => {
    const calls: string[] = [];
    await expect(
      db.tx(async () => {
        db.afterCommit(() => void calls.push("hook"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await Bun.sleep(5);
    expect(calls).toEqual([]);
  });

  test("concurrent requests do not share transaction context", async () => {
    const seen = new Set<unknown>();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        db.tx(async (q) => {
          await Bun.sleep(5);
          expect(db.q()).toBe(q);
          seen.add(q);
        }),
      ),
    );
    expect(seen.size).toBe(5);
  });
});

describe("INV-15 business + event + audit in one transaction", () => {
  test("rollback removes event and audit rows; side effects not fired", async () => {
    const events = createEvents(db);
    const audit = createAudit(db);
    let fired = false;
    const before = await db.root.select({ n: sql<number>`count(*)::int` }).from(event);
    await expect(
      db.tx(async () => {
        await events.emit(ctx, { type: "task.created", aggregateType: "task", aggregateId: "tsk_x" });
        await audit.write(ctx, { action: "task.create", resourceType: "task", resourceId: "tsk_x" });
        db.afterCommit(() => void (fired = true));
        throw new Error("abort");
      }),
    ).rejects.toThrow();
    const after = await db.root.select({ n: sql<number>`count(*)::int` }).from(event);
    expect(after[0]!.n).toBe(before[0]!.n);
    const aud = await db.root.select().from(auditLog).where(eq(auditLog.resourceId, "tsk_x"));
    expect(aud.length).toBe(0);
    expect(fired).toBe(false);
  });

  test("INV-13 event payload rejects body text", async () => {
    const events = createEvents(db);
    await expect(events.emit(ctx, { type: "message.created", aggregateType: "message", aggregateId: "m", payload: { body: "secret text" } })).rejects.toThrow("INV-13");
  });
});

describe("INV-14 audit log append-only with verifiable hash chain", () => {
  test("chain verifies; UPDATE and DELETE are rejected by trigger", async () => {
    const audit = createAudit(db);
    for (let i = 0; i < 5; i++) await audit.write(ctx, { action: "x.do", resourceType: "x", resourceId: `x${i}`, before: { b: 2, a: 1 }, after: { z: [1, { y: 1, x: 2 }] } });
    const v = await audit.verify("ten_kernel");
    expect(v.ok).toBe(true);
    expect(v.count).toBeGreaterThanOrEqual(5);
    await expect((async () => db.root.execute(sql`update audit_log set action = 'tampered'`))()).rejects.toThrow();
    await expect((async () => db.root.execute(sql`delete from audit_log`))()).rejects.toThrow();
  });

  test("TRAP-02 concurrent writers keep chain consistent", async () => {
    const audit = createAudit(db);
    await Promise.all(Array.from({ length: 20 }, (_, i) => audit.write(ctx, { action: "c", resourceType: "c", resourceId: `c${i}` })));
    expect((await audit.verify("ten_kernel")).ok).toBe(true);
  });

  test("tampering (trigger disabled by superuser) is detected", async () => {
    const t = await createTestDatabase("tamper");
    const d2 = createDatabase(t.url, 2);
    const a2 = createAudit(d2);
    const c2 = { ...ctx, tenantId: "ten_t" };
    await d2.root.insert(tenant).values({ id: "ten_t", name: "T" });
    for (let i = 0; i < 3; i++) await a2.write(c2, { action: "a", resourceType: "r", resourceId: `r${i}` });
    await d2.root.execute(sql`alter table audit_log disable trigger audit_log_no_update`);
    await d2.root.execute(sql`update audit_log set action = 'evil' where seq = 2`);
    const v = await a2.verify("ten_t");
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(2);
    await d2.close();
    await t.drop();
  });

  test("secrets are scrubbed from audit rows (INV-17)", async () => {
    const audit = createAudit(db);
    await audit.write(ctx, {
      action: "cred.create",
      resourceType: "credential",
      resourceId: "cred_1",
      after: { name: "gl", token: "glpat-abcdefghijklmnopqrstuvwx", note: "key sk-abcdefghijklmnopqrstuvwxyz0123" },
    });
    const [row] = await db.root.select().from(auditLog).where(eq(auditLog.resourceId, "cred_1"));
    expect(JSON.stringify(row!.after)).not.toContain("glpat-");
    expect(JSON.stringify(row!.after)).not.toContain("sk-abc");
  });
});

describe("jobs", () => {
  test("dedupe key prevents duplicate active jobs", async () => {
    const jobs = createJobs(db, { owner: "w1" });
    const a = await jobs.enqueue("noop", {}, { dedupeKey: "same" });
    const b = await jobs.enqueue("noop", {}, { dedupeKey: "same" });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    jobs.register("noop", async () => {});
    await jobs.drain();
    expect(await jobs.enqueue("noop", {}, { dedupeKey: "same" })).not.toBeNull();
    await jobs.drain();
  });

  test("SKIP LOCKED: two workers never claim the same job", async () => {
    const w1 = createJobs(db, { owner: "a" });
    const w2 = createJobs(db, { owner: "b" });
    for (let i = 0; i < 20; i++) await w1.enqueue("skip", { i });
    const [c1, c2] = await Promise.all([w1.claim(15), w2.claim(15)]);
    const ids = [...c1, ...c2].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(20);
    await db.root.update(job).set({ status: "succeeded" }).where(eq(job.type, "skip"));
  });

  test("concurrency key: one running job per key", async () => {
    const w = createJobs(db, { owner: "c" });
    await w.enqueue("ck", {}, { concurrencyKey: "repo:1" });
    await w.enqueue("ck", {}, { concurrencyKey: "repo:1" });
    const first = await w.claim(5);
    expect(first.length).toBe(1);
    await db.root.update(job).set({ status: "succeeded" }).where(eq(job.type, "ck"));
  });

  test("killed worker: expired lease is recovered and job completes on another worker", async () => {
    const dead = createJobs(db, { owner: "dead", leaseMs: 50 });
    await dead.enqueue("crash", { n: 1 });
    const claimed = await dead.claim(1);
    expect(claimed.length).toBe(1);
    // the worker "dies" without finishing
    await Bun.sleep(80);
    const alive = createJobs(db, { owner: "alive" });
    let ran = 0;
    alive.register("crash", async () => void ran++);
    expect(await alive.recoverExpired()).toBe(1);
    await alive.drain();
    expect(ran).toBe(1);
  });

  test("failing job retries then goes to dead letter", async () => {
    const w = createJobs(db, { owner: "f" });
    w.register("fail", async () => {
      throw new Error("nope");
    });
    await w.enqueue("fail", {}, { maxAttempts: 2 });
    await w.drain();
    await db.root.execute(sql`update job set run_at = now() where type = 'fail'`);
    await w.drain();
    const [j] = await db.root.select().from(job).where(eq(job.type, "fail"));
    expect(j!.status).toBe("dead");
    const dl = await db.root.execute(sql`select count(*)::int as n from dead_letter where source = 'job'`);
    expect((dl as unknown as { rows: Array<{ n: number }> }).rows[0]!.n).toBeGreaterThan(0);
  });
});

describe("event consumers", () => {
  test("at-least-once, offsets per consumer, failing consumer does not block another; restart resumes", async () => {
    const events = createEvents(db);
    const got: number[] = [];
    let flaky = 0;
    const runner = createConsumerRunner(db, { owner: "r1", maxAttempts: 2 });
    runner.register({ name: "good", types: ["project.created"], handle: async (e) => void got.push(e.seq) });
    runner.register({
      name: "bad",
      types: ["project.created"],
      handle: async () => {
        flaky++;
        throw new Error("always");
      },
    });
    await runner.init();
    for (let i = 0; i < 3; i++) await db.tx(() => events.emit(ctx, { type: "project.created", aggregateType: "project", aggregateId: `p${i}` }));
    await runner.drain();
    expect(got.length).toBe(3);
    expect(flaky).toBe(6);
    await runner.release();
    // a new worker (after crash) continues from the stored offset without redelivery
    const runner2 = createConsumerRunner(db, { owner: "r2" });
    const got2: number[] = [];
    runner2.register({ name: "good", types: ["project.created"], handle: async (e) => void got2.push(e.seq) });
    await db.tx(() => events.emit(ctx, { type: "project.created", aggregateType: "project", aggregateId: "p9" }));
    await runner2.drain();
    expect(got2.length).toBe(1);
  });
});

describe("INV-16 idempotency", () => {
  test("same actor + key returns first result; different body conflicts", async () => {
    const idem = createIdempotency(db);
    let n = 0;
    const fn = async () => ({ status: 201, body: { n: ++n } });
    const a = await idem.run("prn_a", "k1", { x: 1 }, fn);
    const b = await idem.run("prn_a", "k1", { x: 1 }, fn);
    expect(a.body).toEqual({ n: 1 });
    expect(b.body).toEqual({ n: 1 });
    expect(b.replayed).toBe(true);
    await expect(idem.run("prn_a", "k1", { x: 2 }, fn)).rejects.toThrow();
    const c = await idem.run("prn_b", "k1", { x: 1 }, fn);
    expect(c.body).toEqual({ n: 2 });
  });
});

describe("V7 pg driver under Bun", () => {
  test("LISTEN/NOTIFY delivers after commit only", async () => {
    const listener = new pg.Client({ connectionString: url });
    await listener.connect();
    const got: string[] = [];
    listener.on("notification", (m) => got.push(m.payload ?? ""));
    await listener.query("listen ap_events");
    const events = createEvents(db);
    await db.tx(async () => {
      await events.emit(ctx, { type: "project.created", aggregateType: "project", aggregateId: "pn" });
      await Bun.sleep(30);
      expect(got.length).toBe(0);
    });
    await Bun.sleep(50);
    expect(got.length).toBe(1);
    await listener.end();
  });

  test("TRAP-12 idle client terminated by server does not crash the process", async () => {
    const d = createDatabase(url, 2);
    await d.root.execute(sql`select 1`);
    await db.root.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state = 'idle' and application_name = ''`);
    await Bun.sleep(50);
    const r = await d.root.execute(sql`select 1 as ok`);
    expect((r as unknown as { rows: Array<{ ok: number }> }).rows[0]!.ok).toBe(1);
    await d.close();
  });
});

describe("V8 crypto", () => {
  test("AES-256-GCM roundtrip, key versions, tamper detection", () => {
    const v1 = createVault({ 1: "k1-secret-material" }, 1);
    const enc = v1.encrypt("glpat-xyz");
    expect(enc.ciphertext).not.toContain("glpat");
    expect(v1.decrypt(enc.ciphertext, 1)).toBe("glpat-xyz");
    const v2 = createVault({ 1: "k1-secret-material", 2: "k2-new" }, 2);
    expect(v2.decrypt(enc.ciphertext, 1)).toBe("glpat-xyz");
    expect(v2.encrypt("a").keyVersion).toBe(2);
    const parts = enc.ciphertext.split(".");
    parts[2] = Buffer.from("tampered").toString("base64");
    expect(() => v1.decrypt(parts.join("."), 1)).toThrow();
  });
  test("HMAC, SHA-256, constant-time compare, random", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hmacHex("k", "m")).toHaveLength(64);
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "ab")).toBe(false);
    expect(crypto.getRandomValues(new Uint8Array(16)).length).toBe(16);
  });
});
