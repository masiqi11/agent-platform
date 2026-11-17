import { sql } from "drizzle-orm";
import type { Database } from "../db";
import { DomainError } from "./errors";

export const RATE_LIMITS = {
  login: { limit: 5, windowMs: 15 * 60_000 },
  message: { limit: 60, windowMs: 60_000 },
  search: { limit: 120, windowMs: 60_000 },
  agent_trigger: { limit: 60, windowMs: 60_000 },
  agent_token: { limit: 600, windowMs: 60_000 },
  // IM-补1: bind codes typed into a DM — few tries per IM account.
  im_bind: { limit: 5, windowMs: 15 * 60_000 },
} as const;
export type RateCategory = keyof typeof RATE_LIMITS;

/** Fixed-window limiter stored in Postgres so it is correct across instances (§10.3). */
export function createRateLimiter(db: Database, overrides: Partial<Record<RateCategory, { limit: number; windowMs: number }>> = {}) {
  return {
    async hit(category: RateCategory, subject: string): Promise<void> {
      const cfg = overrides[category] ?? RATE_LIMITS[category];
      const key = `${category}:${subject}`;
      const res = await db.root.execute(sql`
        insert into rate_limit (key, count, window_start) values (${key}, 1, now())
        on conflict (key) do update set
          count = case when rate_limit.window_start < now() - (${cfg.windowMs} || ' milliseconds')::interval then 1 else rate_limit.count + 1 end,
          window_start = case when rate_limit.window_start < now() - (${cfg.windowMs} || ' milliseconds')::interval then now() else rate_limit.window_start end
        returning count, extract(epoch from (window_start + (${cfg.windowMs} || ' milliseconds')::interval - now()))::int as retry`);
      const row = (res as unknown as { rows: Array<{ count: number; retry: number }> }).rows[0];
      if (row && row.count > cfg.limit) throw new DomainError("rate_limited", "请求过于频繁，请稍后再试", { category }, { "Retry-After": String(Math.max(1, row.retry)) });
    },
    async reset(category: RateCategory, subject: string) {
      await db.root.execute(sql`delete from rate_limit where key = ${`${category}:${subject}`}`);
    },
  };
}
export type RateLimiter = ReturnType<typeof createRateLimiter>;
