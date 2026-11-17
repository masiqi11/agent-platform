import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../db";
import { deadLetter, job } from "../db/schema";
import { newId } from "./ids";
import { log } from "./logger";

export interface EnqueueOptions {
  runAt?: Date;
  dedupeKey?: string;
  concurrencyKey?: string;
  maxAttempts?: number;
  tenantId?: string | null;
  traceId?: string;
  /** "every:<ms>" — recurring job scheduled from the same table (§11.4). */
  cron?: string;
}

export type JobRow = typeof job.$inferSelect;
export type JobHandler = (
  payload: Record<string, unknown>,
  ctx: {
    job: JobRow;
    heartbeat: () => Promise<void>;
    /** Aborted when the job times out or this worker lost its lease (#8): stop before the next side effect. */
    signal: AbortSignal;
  },
) => Promise<void>;

/** Thrown by a handler that noticed `signal` was aborted. */
export class JobAborted extends Error {}

export class RetryLater extends Error {
  constructor(
    readonly delayMs: number,
    message = "retry later",
  ) {
    super(message);
  }
}

/** Postgres job queue: SKIP LOCKED claiming, leases, heartbeats, dedupe & concurrency keys (§11.4). */
export function createJobs(db: Database, opts: { owner: string; leaseMs?: number }) {
  const handlers = new Map<string, { fn: JobHandler; timeoutMs: number }>();
  const leaseMs = opts.leaseMs ?? 60_000;

  /** Enqueue in the ambient transaction; deduped while an identical job is queued/running. */
  async function enqueue(type: string, payload: Record<string, unknown>, o: EnqueueOptions = {}): Promise<string | null> {
    const id = newId("job");
    const res = await db.q().execute(sql`
      insert into job (id, tenant_id, type, payload, status, run_at, max_attempts, dedupe_key, concurrency_key, cron, trace_id)
      values (${id}, ${o.tenantId ?? null}, ${type}, ${JSON.stringify(payload)}::jsonb, 'queued', ${(o.runAt ?? new Date()).toISOString()}::timestamptz,
              ${o.maxAttempts ?? 5}, ${o.dedupeKey ?? null}, ${o.concurrencyKey ?? null}, ${o.cron ?? null}, ${o.traceId ?? null})
      on conflict (dedupe_key) where status in ('queued','running') and dedupe_key is not null do nothing
      returning id`);
    const inserted = (res as unknown as { rows: Array<{ id: string }> }).rows[0]?.id ?? null;
    if (inserted) await db.q().execute(sql`select pg_notify('ap_jobs', ${type})`);
    return inserted;
  }

  async function claim(limit: number): Promise<JobRow[]> {
    const until = new Date(Date.now() + leaseMs).toISOString();
    // Candidates are locked with SKIP LOCKED; the window keeps at most one job per concurrency key,
    // and the claim-wide advisory lock stops two workers from each starting a job of the same key.
    const res = await db.root.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ap_job_claim'))`);
      return tx.execute(sql`
        with cand as (
          select j.id, j.run_at, j.concurrency_key from job j
          where j.status = 'queued' and j.run_at <= now()
            and (j.concurrency_key is null or not exists (
              select 1 from job r where r.concurrency_key = j.concurrency_key and r.status = 'running'))
          order by j.run_at
          limit ${limit * 4}
          for update skip locked),
        pick as (
          select id from (select id, run_at, row_number() over (partition by coalesce(concurrency_key, id) order by run_at) rn from cand) x
          where rn = 1 order by run_at limit ${limit})
        update job set status = 'running', lease_owner = ${opts.owner}, lease_token = gen_random_uuid()::text, lease_until = ${until}::timestamptz,
          heartbeat_at = now(), attempts = attempts + 1, updated_at = now()
        where id in (select id from pick)
        returning *`);
    });
    return ((res as unknown as { rows: Record<string, unknown>[] }).rows ?? []).map(rowToJob);
  }

  function rowToJob(r: Record<string, unknown>): JobRow {
    return {
      id: r.id as string,
      tenantId: (r.tenant_id as string) ?? null,
      type: r.type as string,
      payload: (r.payload as Record<string, unknown>) ?? {},
      status: r.status as JobRow["status"],
      runAt: new Date(r.run_at as string),
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
      dedupeKey: (r.dedupe_key as string) ?? null,
      concurrencyKey: (r.concurrency_key as string) ?? null,
      leaseOwner: (r.lease_owner as string) ?? null,
      leaseToken: (r.lease_token as string) ?? null,
      leaseUntil: r.lease_until ? new Date(r.lease_until as string) : null,
      heartbeatAt: r.heartbeat_at ? new Date(r.heartbeat_at as string) : null,
      lastError: (r.last_error as string) ?? null,
      cron: (r.cron as string) ?? null,
      traceId: (r.trace_id as string) ?? null,
      createdAt: new Date(r.created_at as string),
      updatedAt: new Date(r.updated_at as string),
    };
  }

  /**
   * Runs one claimed job. Its lease is renewed automatically while the handler runs; every write
   * back is fenced by the claim's token (#8), so a worker that lost the job (lease expired and
   * another worker took it, or it timed out) can no longer change its state. The handler's
   * `signal` aborts at that moment and on timeout, so it can stop before its next side effect.
   */
  async function runJob(j: JobRow) {
    const h = handlers.get(j.type);
    const ac = new AbortController();
    const mine = () => and(eq(job.id, j.id), eq(job.status, "running"), j.leaseToken ? eq(job.leaseToken, j.leaseToken) : eq(job.leaseOwner, opts.owner));
    const heartbeat = async () => {
      if (ac.signal.aborted) return;
      const rows = await db.root
        .update(job)
        .set({ heartbeatAt: new Date(), leaseUntil: new Date(Date.now() + leaseMs) })
        .where(mine())
        .returning({ id: job.id });
      if (!rows.length) {
        log.warn("job.lease_lost", { jobId: j.id, type: j.type, owner: opts.owner });
        ac.abort(new JobAborted("lease lost"));
      }
    };
    const renew = setInterval(() => void heartbeat().catch(() => undefined), Math.max(20, Math.floor(leaseMs / 3)));
    /** Fenced write: false when this worker no longer holds the job. */
    const settle = async (set: Partial<typeof job.$inferInsert>) =>
      (
        await db.root
          .update(job)
          .set({ ...set, leaseOwner: null, leaseUntil: null, leaseToken: null, updatedAt: new Date() })
          .where(mine())
          .returning({ id: job.id })
      ).length > 0;
    try {
      if (!h) throw new Error(`no handler for job type ${j.type}`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        h.fn(j.payload, { job: j, heartbeat, signal: ac.signal }),
        new Promise((_, rej) => {
          timer = setTimeout(() => {
            const e = new Error(`job timeout after ${h.timeoutMs}ms`);
            ac.abort(e);
            rej(e);
          }, h.timeoutMs);
        }),
        // Lost the lease: stop waiting for the handler; whatever it still does can't settle the job.
        new Promise((_, rej) => ac.signal.addEventListener("abort", () => rej(ac.signal.reason as Error), { once: true })),
      ]).finally(() => clearTimeout(timer));
      clearInterval(renew);
      if (!(await settle({ status: "succeeded" }))) {
        log.warn("job.settle_fenced", { jobId: j.id, type: j.type, outcome: "succeeded" });
        return;
      }
      if (j.cron?.startsWith("every:")) {
        const every = Number(j.cron.slice(6));
        await enqueue(j.type, j.payload, {
          runAt: new Date(Date.now() + every),
          dedupeKey: j.dedupeKey ?? undefined,
          cron: j.cron,
          tenantId: j.tenantId,
          concurrencyKey: j.concurrencyKey ?? undefined,
        });
      }
    } catch (e) {
      clearInterval(renew);
      const err = e as Error;
      if (err instanceof JobAborted) {
        // Lease lost: the job belongs to someone else now (or is back in the queue). Nothing to write.
        log.warn("job.abandoned", { jobId: j.id, type: j.type, reason: err.message });
        return;
      }
      if (!ac.signal.aborted) ac.abort(err);
      if (err instanceof RetryLater) {
        // Not a failure: reschedule without consuming an attempt.
        await settle({ status: "queued", attempts: Math.max(0, j.attempts - 1), runAt: new Date(Date.now() + err.delayMs), lastError: err.message });
        return;
      }
      const dead = j.attempts >= j.maxAttempts;
      log.warn("job.failed", { jobId: j.id, type: j.type, attempt: j.attempts, dead, err: err.message });
      const backoff = Math.min(1000 * 2 ** j.attempts, 5 * 60_000) * (0.75 + Math.random() * 0.5);
      const wrote = await settle({ status: dead ? "dead" : "queued", runAt: new Date(Date.now() + backoff), lastError: (err.stack ?? err.message).slice(0, 2000) });
      if (wrote && dead)
        await db.root.insert(deadLetter).values({
          id: newId("dlq"),
          tenantId: j.tenantId,
          source: "job",
          refId: j.id,
          payload: { type: j.type, payload: j.payload },
          error: (err.stack ?? err.message).slice(0, 4000),
          attempts: j.attempts,
        });
    }
  }

  /** Requeue jobs whose lease expired (crash recovery, §5.4). */
  async function recoverExpired(): Promise<number> {
    const rows = await db.root
      .update(job)
      .set({ status: "queued", leaseOwner: null, leaseUntil: null, leaseToken: null, updatedAt: new Date() })
      .where(and(eq(job.status, "running"), lt(job.leaseUntil, new Date())))
      .returning({ id: job.id });
    return rows.length;
  }

  return {
    register(type: string, fn: JobHandler, timeoutMs = 10 * 60_000) {
      handlers.set(type, { fn, timeoutMs });
    },
    enqueue,
    claim,
    runJob,
    recoverExpired,
    /** Claims and runs jobs until the queue has nothing runnable (tests / drain). */
    async drain(maxRounds = 200, concurrency = 4): Promise<number> {
      let total = 0;
      for (let i = 0; i < maxRounds; i++) {
        const js = await claim(concurrency);
        if (js.length === 0) break;
        await Promise.all(js.map(runJob));
        total += js.length;
      }
      return total;
    },
    async releaseOwned() {
      await db.root
        .update(job)
        .set({ status: "queued", leaseOwner: null, leaseUntil: null, leaseToken: null })
        .where(and(eq(job.status, "running"), eq(job.leaseOwner, opts.owner)));
    },
    async counts() {
      const rows = await db.root
        .select({ status: job.status, n: sql<number>`count(*)::int` })
        .from(job)
        .where(inArray(job.status, ["queued", "running", "dead", "failed"]))
        .groupBy(job.status);
      return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
    },
  };
}
export type Jobs = ReturnType<typeof createJobs>;
