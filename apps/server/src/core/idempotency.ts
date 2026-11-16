import { and, eq, gt, lt } from "drizzle-orm";
import type { Database } from "../db";
import { idempotencyRecord } from "../db/schema";
import { sha256Hex } from "./crypto";
import { DomainError } from "./errors";

const TTL_MS = 24 * 3600 * 1000;

/** Idempotency-Key handling (§10.3, INV-16): same actor + key within 24h returns the first result. */
export function createIdempotency(db: Database) {
  return {
    async run<T>(actorPrincipalId: string, key: string | undefined | null, request: unknown, fn: () => Promise<{ status: number; body: T }>): Promise<{ status: number; body: T; replayed: boolean }> {
      if (!key) return { ...(await fn()), replayed: false };
      if (key.length > 200) throw new DomainError("invalid", "Idempotency-Key 过长");
      const hash = sha256Hex(JSON.stringify(request ?? null));
      const [existing] = await db.root
        .select()
        .from(idempotencyRecord)
        .where(and(eq(idempotencyRecord.actorPrincipalId, actorPrincipalId), eq(idempotencyRecord.key, key), gt(idempotencyRecord.expiresAt, new Date())));
      if (existing) {
        if (existing.requestHash !== hash) throw new DomainError("conflict", "同一 Idempotency-Key 对应了不同的请求体");
        return { status: existing.statusCode, body: existing.response as T, replayed: true };
      }
      const res = await fn();
      if (res.status < 500) {
        await db.root
          .insert(idempotencyRecord)
          .values({ actorPrincipalId, key, requestHash: hash, response: res.body as unknown as Record<string, unknown>, statusCode: res.status, expiresAt: new Date(Date.now() + TTL_MS) })
          .onConflictDoNothing();
      }
      return { ...res, replayed: false };
    },
    async purgeExpired() {
      await db.root.delete(idempotencyRecord).where(lt(idempotencyRecord.expiresAt, new Date()));
    },
  };
}
export type Idempotency = ReturnType<typeof createIdempotency>;
