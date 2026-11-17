import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { createConfig } from "../src/config";
import { newId } from "../src/core/ids";
import { auditLog, authSession, authUser, credential, deadLetter, event, eventConsumer, job, session, sessionTurn, task } from "../src/db/schema";
import { loadEnv } from "../src/env";
import { createServices, type Services } from "../src/services";
import { createTestApp, type TestApp } from "./helpers";

/** S8: master key rotation (ADM-补1) and retention cleanup (§8.5). */
let t: TestApp;
let owner = "";
let projectId = "";
const dataDir = mkdtempSync(join(tmpdir(), "ap-s8m-"));
const K1 = "test-master-key-one-0123456789abcdef";
const K2 = "test-master-key-two-0123456789abcdef";
const REAL_KEY = "sk-provider-real-key-rotation-0099";
const extra: Services[] = [];

const servicesWith = (env: Record<string, string>) => {
  const s = createServices(createConfig(loadEnv({ ...process.env, NODE_ENV: "test", DATABASE_URL: t.url, LOG_LEVEL: "error", DATA_DIR: dataDir, ...env })), { owner: `t-${extra.length}` });
  extra.push(s);
  return s;
};

beforeAll(async () => {
  t = await createTestApp("s8maint", { MASTER_KEY: K1, DATA_DIR: dataDir });
  owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "M", email: "o@m.test", name: "O", password: "Correct-Horse-42" } })).body.token;
  projectId = (await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "MT", name: "维护" } })).body.id;
  const prov = await t.req("POST", "/api/v1/admin/models/providers", {
    token: owner,
    body: { name: "供应商", baseUrl: "https://llm.example.com/v1", dialect: "openai", isExternal: true, apiKey: REAL_KEY, models: [{ name: "m1" }] },
  });
  expect(prov.status).toBe(200);
});
afterAll(async () => {
  for (const s of extra) await s.db.close();
  await t?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("S8 master key rotation", () => {
  test("a wrong old key never overwrites a working ciphertext", async () => {
    const bad = servicesWith({ MASTER_KEY: "a-completely-different-master-key-000", MASTER_KEY_V2: K2 });
    const before = await t.s.db.root.select().from(credential);
    const r = await bad.system.rekeyCredentials();
    expect(r.failed.length).toBe(before.length);
    expect(r.rekeyed).toBe(0);
    const after = await t.s.db.root.select().from(credential);
    expect(after.map((c) => c.ciphertext)).toEqual(before.map((c) => c.ciphertext));
  });

  test("V2 added → rekey moves every credential to v2; it still decrypts; a v1-only process can't read it", async () => {
    const s2 = servicesWith({ MASTER_KEY: K1, MASTER_KEY_V2: K2 });
    const r = await s2.system.rekeyCredentials();
    expect(r).toMatchObject({ toVersion: 2, failed: [], remaining: 0 });
    expect(r.rekeyed).toBeGreaterThanOrEqual(1);
    const rows = await t.s.db.root.select().from(credential);
    expect(rows.every((c) => c.keyVersion === 2)).toBe(true);
    const llmCred = rows.find((c) => c.kind === "llm" && c.last4 === REAL_KEY.slice(-4))!;
    expect(s2.vault.decrypt(llmCred.ciphertext, llmCred.keyVersion)).toBe(REAL_KEY);
    expect(() => t.s.vault.decrypt(llmCred.ciphertext, llmCred.keyVersion)).toThrow(); // v1-only config
    // Idempotent; audited.
    expect(await s2.system.rekeyCredentials()).toMatchObject({ rekeyed: 0, remaining: 0 });
    const audits = await t.s.db.root.select().from(auditLog).where(eq(auditLog.action, "credential.rekey"));
    expect(audits.some((a) => (a.after as { rekeyed: number }).rekeyed >= 1)).toBe(true);
  });
});

describe("S8 retention cleanup", () => {
  test("removes only what is past its period; archives events first; keeps open dead letters and unprocessed events; audited", async () => {
    const s = servicesWith({ MASTER_KEY: K1, MASTER_KEY_V2: K2, RETENTION_ENABLED: "true" });
    const tenantId = ((await t.s.db.root.execute(sql`select id from tenant limit 1`)) as unknown as { rows: Array<{ id: string }> }).rows[0]!.id;
    const old = new Date(Date.now() - 400 * 86_400_000);
    const recent = new Date(Date.now() - 86_400_000);

    // Events: two old ones below every consumer offset, one old one above it (not yet processed).
    const evIds = [newId("evt"), newId("evt"), newId("evt")];
    for (const id of evIds)
      await t.s.db.root.insert(event).values({ id, tenantId, type: "test.old", aggregateType: "t", aggregateId: "x", actorPrincipalId: "p", payload: {}, traceId: "trc_ret", occurredAt: old });
    const seqs = (await t.s.db.root.select({ id: event.id, seq: event.seq }).from(event).where(eq(event.type, "test.old"))).sort((a, b) => a.seq - b.seq);
    await t.s.db.root
      .insert(eventConsumer)
      .values({ name: "test-ret-consumer", offsetSeq: seqs[1]!.seq })
      .onConflictDoUpdate({ target: eventConsumer.name, set: { offsetSeq: seqs[1]!.seq } });
    // Every consumer has processed up to the second event, not the third.
    await t.s.db.root.update(eventConsumer).set({ offsetSeq: seqs[1]!.seq });

    // Jobs: old succeeded, recent succeeded, old dead, old recurring.
    const jobRows = [
      { id: newId("job"), status: "succeeded" as const, updatedAt: old },
      { id: newId("job"), status: "succeeded" as const, updatedAt: recent },
      { id: newId("job"), status: "dead" as const, updatedAt: old },
      { id: newId("job"), status: "queued" as const, updatedAt: old, cron: "every:60000" },
    ];
    for (const j of jobRows) await t.s.db.root.insert(job).values({ type: "test.ret", ...j });
    // Dead letters: old handled vs old still open.
    const dlHandled = newId("dlq");
    const dlOpen = newId("dlq");
    await t.s.db.root.insert(deadLetter).values([
      { id: dlHandled, tenantId, source: "job", refId: "j1", payload: {}, error: "x", attempts: 1, createdAt: old, replayedAt: old },
      { id: dlOpen, tenantId, source: "job", refId: "j2", payload: {}, error: "x", attempts: 1, createdAt: old },
    ]);
    // Transcript of a task that ended long ago vs one still open.
    const doneTask = await t.req("POST", "/api/v1/tasks", { token: owner, body: { projectId, title: "早已完成" } });
    const openTask = await t.req("POST", "/api/v1/tasks", { token: owner, body: { projectId, title: "进行中" } });
    await t.s.db.root.update(task).set({ status: "done", updatedAt: old }).where(eq(task.id, doneTask.body.id));
    const agentId = ((await t.s.db.root.execute(sql`select id from agent limit 1`)) as unknown as { rows: Array<{ id: string }> }).rows[0]!.id;
    const sesIds: string[] = [];
    for (const tk of [doneTask.body.id, openTask.body.id]) {
      const id = newId("ses");
      sesIds.push(id);
      await t.s.db.root.insert(session).values({ id, tenantId, agentId, projectId, scopeType: "task", scopeId: tk, agentConfigVersion: 1 });
      await t.s.db.root.insert(sessionTurn).values({ id: newId("trn"), sessionId: id, idx: 0, role: "assistant", content: "转录" });
    }
    // An expired login session.
    const [u] = await t.s.db.root.select().from(authUser).limit(1);
    await t.s.db.root.insert(authSession).values({ id: newId("aus"), userId: u!.id, token: newId("tok"), expiresAt: old, createdAt: old, updatedAt: old });

    const r = await s.system.retention();
    expect(r.events).toBe(2);
    expect(r.jobs).toBe(2);
    expect(r.deadLetters).toBe(1);
    expect(r.transcripts).toBe(1);
    expect(r.authSessions).toBeGreaterThanOrEqual(1);
    // Archived before deletion.
    const file = join(dataDir, "artifacts", r.archive!.replace("local://", ""));
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    // What stays.
    expect((await t.s.db.root.select().from(event).where(eq(event.type, "test.old"))).map((e) => e.id)).toEqual([seqs[2]!.id]);
    const left = await t.s.db.root.select().from(job).where(eq(job.type, "test.ret"));
    expect(left.map((j) => j.id).sort()).toEqual([jobRows[1]!.id, jobRows[3]!.id].sort());
    expect((await t.s.db.root.select().from(deadLetter).where(eq(deadLetter.id, dlOpen))).length).toBe(1);
    expect((await t.s.db.root.select().from(sessionTurn).where(eq(sessionTurn.sessionId, sesIds[1]!))).length).toBe(1);
    expect((await t.s.db.root.select().from(session).where(eq(session.id, sesIds[0]!))).length).toBe(1); // session row (usage) kept
    const [a] = await t.s.db.root
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "retention.cleanup"), eq(auditLog.tenantId, tenantId)));
    expect(a!.after).toMatchObject({ events: 2, jobs: 2 });
    // The audit chain is still intact after the cleanup.
    expect((await t.s.audit.verify(tenantId)).ok).toBe(true);
  });
});
