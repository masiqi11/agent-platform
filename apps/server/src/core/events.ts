import type { AggregateType, DomainEvent, EventType } from "@ap/shared";
import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db";
import { deadLetter, event, eventConsumer } from "../db/schema";
import type { Ctx } from "./context";
import { newId } from "./ids";
import { log } from "./logger";

export interface EmitInput {
  type: EventType;
  aggregateType: AggregateType;
  aggregateId: string;
  /** Identifiers and small structured fields only (INV-13). */
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
}

const MAX_PAYLOAD_STRING = 200;

/** Guards INV-13 at runtime: no long free text in payloads. */
function assertIdsOnly(payload: Record<string, unknown>) {
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === "string" && v.length > MAX_PAYLOAD_STRING) throw new Error(`event payload field ${k} too long (INV-13: ids only)`);
    if (k === "body" || k === "content" || k === "text") throw new Error(`event payload must not carry body text (INV-13): ${k}`);
  }
}

export type EventRow = typeof event.$inferSelect;
export const toDomainEvent = (r: EventRow): DomainEvent => ({
  id: r.id,
  tenantId: r.tenantId,
  type: r.type as EventType,
  aggregateType: r.aggregateType as AggregateType,
  aggregateId: r.aggregateId,
  actorPrincipalId: r.actorPrincipalId,
  occurredAt: r.occurredAt.toISOString(),
  seq: r.seq,
  payload: r.payload,
  traceId: r.traceId,
  idempotencyKey: r.idempotencyKey ?? undefined,
});

export function createEvents(db: Database) {
  /** Writes an event in the ambient transaction (INV-15). NOTIFY is transactional: delivered on commit. */
  async function emit(ctx: Ctx, input: EmitInput): Promise<EventRow> {
    const payload = input.payload ?? {};
    assertIdsOnly(payload);
    return db.tx(async (q) => {
      // Outbox ordering: holding this lock until commit makes seq order equal commit order, so a
      // consumer that has seen seq N can never later miss a smaller seq (holes are rollbacks only).
      await q.execute(sql`select pg_advisory_xact_lock(727275)`);
      const [row] = await q
        .insert(event)
        .values({
          id: newId("evt"),
          tenantId: ctx.tenantId,
          type: input.type,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          actorPrincipalId: ctx.actor.principalId,
          payload,
          traceId: ctx.traceId,
          idempotencyKey: input.idempotencyKey ?? null,
        })
        .returning();
      await q.execute(sql`select pg_notify('ap_events', ${String(row!.seq)})`);
      return row!;
    });
  }
  return { emit };
}
export type Events = ReturnType<typeof createEvents>;

export interface Consumer {
  name: string;
  types?: readonly EventType[] | "*";
  handle(e: DomainEvent): Promise<void>;
}

/**
 * At-least-once event consumers with per-consumer offset + lease (§11.3, §11.5).
 * Each consumer advances independently so one stuck consumer never blocks others.
 */
export function createConsumerRunner(db: Database, opts: { owner: string; maxAttempts?: number; leaseMs?: number; batch?: number }) {
  const consumers: Consumer[] = [];
  const maxAttempts = opts.maxAttempts ?? 5;
  const leaseMs = opts.leaseMs ?? 30_000;
  const batch = opts.batch ?? 100;
  const busy = new Set<string>();

  async function ensureRow(name: string) {
    await db.root.insert(eventConsumer).values({ name, offsetSeq: 0 }).onConflictDoNothing();
  }

  async function acquire(name: string): Promise<number | null> {
    const until = new Date(Date.now() + leaseMs);
    const rows = await db.root
      .update(eventConsumer)
      .set({ leaseOwner: opts.owner, leaseUntil: until })
      .where(and(eq(eventConsumer.name, name), or(isNull(eventConsumer.leaseUntil), lt(eventConsumer.leaseUntil, new Date()), eq(eventConsumer.leaseOwner, opts.owner))))
      .returning({ offset: eventConsumer.offsetSeq });
    return rows[0]?.offset ?? null;
  }

  async function runOne(c: Consumer): Promise<number> {
    if (busy.has(c.name)) return 0;
    busy.add(c.name);
    try {
      const offset = await acquire(c.name);
      if (offset === null) return 0;
      const wants = (t: string) => !c.types || c.types === "*" || (c.types as readonly string[]).includes(t);
      const rows = await db.root.select().from(event).where(gt(event.seq, offset)).orderBy(asc(event.seq)).limit(batch);
      let processed = 0;
      let prev = offset;
      for (const r of rows) {
        prev = r.seq;
        let ok = true;
        let attempt = 0;
        let lastErr = "";
        if (wants(r.type)) {
          ok = false;
          while (attempt < maxAttempts && !ok) {
            attempt++;
            try {
              await c.handle(toDomainEvent(r));
              ok = true;
            } catch (e) {
              lastErr = (e as Error).stack ?? String(e);
              log.warn("event.consumer_failed", { consumer: c.name, seq: r.seq, attempt, err: (e as Error).message });
              await Bun.sleep(Math.min(20 * 2 ** attempt, 500));
            }
          }
          if (!ok) {
            await db.root.insert(deadLetter).values({
              id: newId("dlq"),
              tenantId: r.tenantId,
              source: "event",
              refId: r.id,
              consumer: c.name,
              payload: { seq: r.seq, type: r.type },
              error: lastErr.slice(0, 4000),
              attempts: attempt,
            });
          }
          processed++;
        }
        await db.root
          .update(eventConsumer)
          .set({ offsetSeq: r.seq, lastError: ok ? null : lastErr.slice(0, 500), updatedAt: new Date(), leaseUntil: new Date(Date.now() + leaseMs) })
          .where(eq(eventConsumer.name, c.name));
      }
      return prev > offset ? Math.max(processed, 1) : 0;
    } finally {
      busy.delete(c.name);
    }
  }

  return {
    register(c: Consumer) {
      consumers.push(c);
    },
    consumers,
    async init() {
      for (const c of consumers) await ensureRow(c.name);
    },
    /** Processes all consumers until no consumer made progress. Returns total processed. */
    async drain(maxRounds = 50): Promise<number> {
      let total = 0;
      for (let i = 0; i < maxRounds; i++) {
        let n = 0;
        for (const c of consumers) n += await runOne(c);
        total += n;
        if (n === 0) break;
      }
      return total;
    },
    async tick(): Promise<number> {
      let n = 0;
      await Promise.all(consumers.map(async (c) => (n += await runOne(c))));
      return n;
    },
    async release() {
      await db.root.update(eventConsumer).set({ leaseOwner: null, leaseUntil: null }).where(eq(eventConsumer.leaseOwner, opts.owner));
    },
  };
}
export type ConsumerRunner = ReturnType<typeof createConsumerRunner>;
