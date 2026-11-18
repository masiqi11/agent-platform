import { and, eq, lt } from "drizzle-orm";
import type { Database } from "../db";
import { idempotencyRecord } from "../db/schema";
import { sha256Hex } from "./crypto";
import { DomainError } from "./errors";

const TTL_MS = 24 * 3600 * 1000;
/** statusCode of a key reserved by a request still running. */
const PENDING = 0;
/** How long a concurrent duplicate waits for the first request's result. */
const WAIT_MS = 15_000;

/** Idempotency-Key handling (§10.3, INV-16): same actor + key within 24h returns the first result. */
export function createIdempotency(db: Database) {
  const self = {
    async run<T>(actorPrincipalId: string, key: string | undefined | null, request: unknown, fn: () => Promise<{ status: number; body: T }>): Promise<{ status: number; body: T; replayed: boolean }> {
      if (!key) return { ...(await fn()), replayed: false };
      if (key.length > 200) throw new DomainError("invalid", "Idempotency-Key 过长");
      const hash = sha256Hex(JSON.stringify(request ?? null));
      const where = and(eq(idempotencyRecord.actorPrincipalId, actorPrincipalId), eq(idempotencyRecord.key, key));
      // #8: reserve the key BEFORE running the business logic. Exactly one concurrent request wins
      // the insert; the others wait for its stored result instead of executing a second time.
      await db.root.delete(idempotencyRecord).where(and(where, lt(idempotencyRecord.expiresAt, new Date())));
      const [won] = await db.root
        .insert(idempotencyRecord)
        .values({ actorPrincipalId, key, requestHash: hash, response: null, statusCode: PENDING, expiresAt: new Date(Date.now() + TTL_MS) })
        .onConflictDoNothing()
        .returning({ key: idempotencyRecord.key });
      if (!won) {
        const deadline = Date.now() + WAIT_MS;
        for (;;) {
          const [existing] = await db.root.select().from(idempotencyRecord).where(where);
          if (!existing) return self.run(actorPrincipalId, key, request, fn); // the first attempt failed and released the key
          if (existing.requestHash !== hash) throw new DomainError("conflict", "同一 Idempotency-Key 对应了不同的请求体");
          if (existing.statusCode !== PENDING) return { status: existing.statusCode, body: existing.response as T, replayed: true };
          if (Date.now() > deadline) throw new DomainError("conflict", "同一 Idempotency-Key 的请求仍在处理中，请稍后重试");
          await Bun.sleep(50);
        }
      }
      let res: { status: number; body: T };
      try {
        res = await fn();
      } catch (e) {
        await db.root.delete(idempotencyRecord).where(and(where, eq(idempotencyRecord.statusCode, PENDING)));
        throw e;
      }
      if (res.status < 500)
        await db.root
          .update(idempotencyRecord)
          .set({ response: res.body as unknown as Record<string, unknown>, statusCode: res.status })
          .where(where);
      else await db.root.delete(idempotencyRecord).where(and(where, eq(idempotencyRecord.statusCode, PENDING)));
      return { ...res, replayed: false };
    },
    async purgeExpired() {
      await db.root.delete(idempotencyRecord).where(lt(idempotencyRecord.expiresAt, new Date()));
    },
  };
  return self;
}
export type Idempotency = ReturnType<typeof createIdempotency>;
