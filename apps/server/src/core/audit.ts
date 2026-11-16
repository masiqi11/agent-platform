import { canonicalJson } from "@ap/shared";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db";
import { auditAnchor, auditLog } from "../db/schema";
import type { Ctx } from "./context";
import { newId } from "./ids";
import { redactValue } from "./logger";

export interface AuditInput {
  action: string;
  resourceType: string;
  resourceId: string;
  projectId?: string | null;
  before?: unknown;
  after?: unknown;
  policy?: Record<string, unknown>;
  outcome?: "allowed" | "denied";
}

const GENESIS = "0".repeat(64);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Fields that participate in the hash, normalised to canonical JSON (TRAP-02). */
function hashContent(r: { tenantId: string; seq: number; actorPrincipalId: string; action: string; resourceType: string; resourceId: string; before: unknown; after: unknown; policy: unknown; outcome: string; traceId: string; createdAt: Date }) {
  return canonicalJson({
    tenantId: r.tenantId,
    seq: r.seq,
    actorPrincipalId: r.actorPrincipalId,
    action: r.action,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    before: r.before ?? null,
    after: r.after ?? null,
    policy: r.policy ?? {},
    outcome: r.outcome,
    traceId: r.traceId,
    createdAt: r.createdAt.toISOString(),
  });
}

/** Strip/redact secrets before anything enters the audit log (INV-17). */
function scrub(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  const json = JSON.stringify(v, (k, val) => (/(password|secret|token|apiKey|ciphertext|plaintext)/i.test(k) && typeof val === "string" ? "[REDACTED]" : val));
  return JSON.parse(redactValue(json));
}

/** Only this module writes audit_log (§5.2 rule 4). */
export function createAudit(db: Database) {
  async function write(ctx: Ctx, input: AuditInput) {
    return db.tx(async (q) => {
      // Serialise the chain per tenant (TRAP-02).
      await q.execute(sql`select pg_advisory_xact_lock(hashtext(${"audit:" + ctx.tenantId}))`);
      const [last] = await q.select({ seq: auditLog.seq, hash: auditLog.hash }).from(auditLog).where(eq(auditLog.tenantId, ctx.tenantId)).orderBy(desc(auditLog.seq)).limit(1);
      const seq = (last?.seq ?? 0) + 1;
      const prevHash = last?.hash ?? GENESIS;
      const createdAt = new Date();
      const row = {
        tenantId: ctx.tenantId,
        seq,
        actorPrincipalId: ctx.actor.principalId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        before: scrub(input.before),
        after: scrub(input.after),
        policy: (scrub(input.policy ?? {}) ?? {}) as Record<string, unknown>,
        outcome: input.outcome ?? "allowed",
        traceId: ctx.traceId,
        createdAt,
      };
      const hash = sha256(prevHash + hashContent(row));
      await q.insert(auditLog).values({ id: newId("aud"), ...row, projectId: input.projectId ?? null, prevHash, hash });
      return { seq, hash };
    });
  }

  /** Verifies the hash chain (OBS-补1). Returns first broken seq if any. */
  async function verify(tenantId: string): Promise<{ ok: boolean; count: number; brokenAt?: number; head?: string }> {
    let prev = GENESIS;
    let count = 0;
    let lastSeq = 0;
    const pageSize = 1000;
    for (;;) {
      const rows = await db.root.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), sql`${auditLog.seq} > ${lastSeq}`)).orderBy(asc(auditLog.seq)).limit(pageSize);
      if (rows.length === 0) break;
      for (const r of rows) {
        const expected = sha256(prev + hashContent({ ...r, outcome: r.outcome }));
        if (r.prevHash !== prev || r.hash !== expected || r.seq !== lastSeq + 1) return { ok: false, count, brokenAt: r.seq };
        prev = r.hash;
        lastSeq = r.seq;
        count++;
      }
    }
    return { ok: true, count, head: prev };
  }

  /** Exports the chain head as an external anchor (OBS-补1). */
  async function anchor(ctx: Ctx, exportedTo: string | null) {
    const [last] = await db.root.select().from(auditLog).where(eq(auditLog.tenantId, ctx.tenantId)).orderBy(desc(auditLog.seq)).limit(1);
    if (!last) return null;
    const rec = { id: newId("anc"), tenantId: ctx.tenantId, seq: last.seq, hash: last.hash, exportedTo };
    await db.root.insert(auditAnchor).values(rec);
    return rec;
  }

  return { write, verify, anchor };
}
export type Audit = ReturnType<typeof createAudit>;
