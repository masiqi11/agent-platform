import { and, count, desc, eq, inArray, isNull, max, min, or, sql } from "drizzle-orm";
import type { Audit } from "../../core/audit";
import type { Ctx } from "../../core/context";
import { conflict, notFound } from "../../core/errors";
import { metrics } from "../../core/metrics";
import type { Database } from "../../db";
import { expectedMigration } from "../../db/migrate";
import { auditLog, deadLetter, event, eventConsumer, job, llmCall, modelProvider, session } from "../../db/schema";
import type { Identity } from "../identity/service";
import type { Sandbox } from "../sandbox/service";
import type { Workspaces } from "../workspaces/service";

/** System status page (ADM-补3): db, migration, consumer lag, job backlog, dead letters, sandbox, providers, disk. */
export function createSystem(d: {
  db: Database;
  identity: Identity;
  audit: Audit;
  sandbox: Sandbox;
  workspaces: Workspaces;
  jobs: { counts(): Promise<Record<string, number>> };
  consumers: { replayOne(consumer: string, eventId: string): Promise<void> };
}) {
  const open = and(isNull(deadLetter.replayedAt), isNull(deadLetter.discardedBy));
  async function status(ctx: Ctx) {
    await d.identity.require(ctx, "admin.system");
    const t0 = Date.now();
    let dbOk = true;
    let migration = "";
    try {
      const r = (await d.db.root.execute(sql`select name from ap_schema_version limit 1`)) as unknown as { rows: Array<{ name: string }> };
      migration = r.rows[0]?.name ?? "";
    } catch {
      dbOk = false;
    }
    const dbLatencyMs = Date.now() - t0;
    const [head] = await d.db.root.select({ seq: max(event.seq) }).from(event);
    const consumers = await d.db.root.select().from(eventConsumer);
    const [low] = await d.db.root.select({ seq: min(eventConsumer.offsetSeq) }).from(eventConsumer);
    const [dl] = await d.db.root.select({ n: count() }).from(deadLetter).where(open);
    const jobs = await d.jobs.counts();
    const sb = await d.sandbox.available();
    const providers = await d.db.root
      .select({ name: modelProvider.name, kind: modelProvider.kind, status: modelProvider.status, circuit: modelProvider.circuitState })
      .from(modelProvider)
      .where(eq(modelProvider.tenantId, ctx.tenantId));
    const disk = await d.workspaces.diskUsage();
    return {
      db: { ok: dbOk, latencyMs: dbLatencyMs },
      migration: { current: migration || "none", expected: await expectedMigration() },
      events: {
        headSeq: head?.seq ?? 0,
        lag: Math.max(0, (head?.seq ?? 0) - (low?.seq ?? 0)),
        consumers: consumers.map((c) => ({ name: c.name, offset: c.offsetSeq, lag: Math.max(0, (head?.seq ?? 0) - c.offsetSeq), lastError: c.lastError ? c.lastError.slice(0, 200) : null })),
      },
      jobs: { queued: jobs.queued ?? 0, running: jobs.running ?? 0, dead: jobs.dead ?? 0 },
      deadLetters: dl?.n ?? 0,
      sandbox: { kind: d.sandbox.kind, ok: sb.ok, detail: sb.detail },
      providers: providers.map((p) => ({ name: p.name, kind: p.kind, status: p.status, circuit: p.circuit.state })),
      disk,
      checkedAt: new Date().toISOString(),
    };
  }
  /* ───────────── dead letters (ADM-补4) ───────────── */

  const dlState = (r: typeof deadLetter.$inferSelect) => (r.discardedBy ? "discarded" : r.replayedAt ? "replayed" : "open");
  const ownDl = (ctx: Ctx) => or(eq(deadLetter.tenantId, ctx.tenantId), isNull(deadLetter.tenantId));

  async function deadLetters(ctx: Ctx, o: { state?: "open" | "all"; limit?: number }) {
    await d.identity.require(ctx, "admin.system");
    const rows = await d.db.root
      .select()
      .from(deadLetter)
      .where(o.state === "all" ? ownDl(ctx) : and(ownDl(ctx), open))
      .orderBy(desc(deadLetter.createdAt))
      .limit(Math.min(o.limit ?? 100, 500));
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      refId: r.refId,
      consumer: r.consumer,
      // Payload is ids and types only (events are ids-only; job payloads are ids + options).
      summary: r.source === "job" ? String((r.payload as { type?: string }).type ?? "") : String((r.payload as { type?: string }).type ?? ""),
      error: r.error.split("\n")[0]!.slice(0, 300),
      attempts: r.attempts,
      state: dlState(r),
      createdAt: r.createdAt.toISOString(),
      replayedAt: r.replayedAt?.toISOString() ?? null,
    }));
  }

  async function loadDl(ctx: Ctx, id: string) {
    const [r] = await d.db.root
      .select()
      .from(deadLetter)
      .where(and(eq(deadLetter.id, id), ownDl(ctx)));
    if (!r) throw notFound("死信");
    if (dlState(r) !== "open") throw conflict(`这条死信已${dlState(r) === "replayed" ? "重放" : "丢弃"}`);
    return r;
  }

  /** Replays a dead letter: a job is requeued from scratch; an event is re-run through its consumer now. */
  async function replay(ctx: Ctx, id: string) {
    await d.identity.require(ctx, "admin.system");
    const r = await loadDl(ctx, id);
    if (r.source === "job") {
      await d.db.root.update(job).set({ status: "queued", attempts: 0, runAt: new Date(), lastError: null, leaseOwner: null, leaseUntil: null, updatedAt: new Date() }).where(eq(job.id, r.refId));
    } else if (r.source === "event" && r.consumer) {
      try {
        await d.consumers.replayOne(r.consumer, r.refId);
      } catch (e) {
        await d.db.root
          .update(deadLetter)
          .set({ error: ((e as Error).stack ?? String(e)).slice(0, 4000), attempts: r.attempts + 1 })
          .where(eq(deadLetter.id, id));
        await d.audit.write(ctx, { action: "dead_letter.replay", resourceType: "dead_letter", resourceId: id, outcome: "allowed", after: { ok: false } });
        throw conflict(`重放仍然失败：${(e as Error).message.slice(0, 200)}`);
      }
    } else throw conflict("这类死信不能在这里重放");
    await d.db.root.update(deadLetter).set({ replayedAt: new Date() }).where(eq(deadLetter.id, id));
    await d.audit.write(ctx, { action: "dead_letter.replay", resourceType: "dead_letter", resourceId: id, outcome: "allowed", after: { ok: true, source: r.source, refId: r.refId } });
    return { ok: true as const };
  }

  /** Discards a dead letter: it stays on record, with who and why in the audit log (§14 留痕). */
  async function discard(ctx: Ctx, id: string, reason: string) {
    await d.identity.require(ctx, "admin.system");
    const r = await loadDl(ctx, id);
    await d.db.root.update(deadLetter).set({ discardedBy: ctx.actor.principalId }).where(eq(deadLetter.id, id));
    await d.audit.write(ctx, { action: "dead_letter.discard", resourceType: "dead_letter", resourceId: id, outcome: "allowed", after: { reason, source: r.source, refId: r.refId } });
    return { ok: true as const };
  }

  /* ───────────── trace lookup (FR-OBS-02) ───────────── */

  /** The whole chain behind a trace id, or behind every trace that touched a task. */
  async function trace(ctx: Ctx, q: { traceId?: string; taskId?: string }) {
    await d.identity.require(ctx, "admin.system");
    const ids = new Set<string>(q.traceId ? [q.traceId] : []);
    if (q.taskId) {
      const evs = await d.db.root
        .selectDistinct({ t: event.traceId })
        .from(event)
        .where(and(eq(event.tenantId, ctx.tenantId), or(eq(event.aggregateId, q.taskId), sql`${event.payload}->>'taskId' = ${q.taskId}`)));
      for (const e of evs) ids.add(e.t);
    }
    const list = [...ids].slice(0, 200);
    if (!list.length) return { traceIds: [], items: [] };
    const [evs, jobs, calls, audits] = await Promise.all([
      d.db.root
        .select()
        .from(event)
        .where(and(eq(event.tenantId, ctx.tenantId), inArray(event.traceId, list)))
        .orderBy(event.seq)
        .limit(1000),
      d.db.root.select().from(job).where(inArray(job.traceId, list)).limit(1000),
      d.db.root
        .select()
        .from(llmCall)
        .where(and(eq(llmCall.tenantId, ctx.tenantId), inArray(llmCall.traceId, list)))
        .limit(1000),
      d.db.root
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, ctx.tenantId), inArray(auditLog.traceId, list)))
        .limit(1000),
    ]);
    const items = [
      ...evs.map((e) => ({ at: e.occurredAt.toISOString(), traceId: e.traceId, kind: "event" as const, name: e.type, ref: e.aggregateId, status: null as string | null })),
      ...jobs
        .filter((j) => !j.tenantId || j.tenantId === ctx.tenantId)
        .map((j) => ({ at: j.createdAt.toISOString(), traceId: j.traceId ?? "", kind: "job" as const, name: j.type, ref: j.id, status: j.status as string | null })),
      ...calls.map((c) => ({ at: c.createdAt.toISOString(), traceId: c.traceId ?? "", kind: "llm" as const, name: `${c.purpose} · ${c.model}`, ref: c.id, status: c.status as string | null })),
      ...audits.map((a) => ({ at: a.createdAt.toISOString(), traceId: a.traceId, kind: "audit" as const, name: a.action, ref: a.resourceId, status: a.outcome as string | null })),
    ].sort((x, y) => x.at.localeCompare(y.at));
    return { traceIds: list, items };
  }

  /* ───────────── /metrics (§16.1) ───────────── */

  /** Prometheus text: this process's counters plus database-derived gauges (shared by all instances). */
  async function metricsText() {
    const q = <T>(x: unknown) => (x as { rows: T[] }).rows;
    const [head] = await d.db.root.select({ seq: max(event.seq) }).from(event);
    const consumers = await d.db.root.select({ name: eventConsumer.name, offset: eventConsumer.offsetSeq }).from(eventConsumer);
    const jobs = q<{ status: string; n: number }>(await d.db.root.execute(sql`select status, count(*)::int as n from job where status in ('queued','running','dead') group by status`));
    const failed1h = q<{ n: number }>(await d.db.root.execute(sql`select count(*)::int as n from job where last_error is not null and updated_at > now() - interval '1 hour'`))[0]?.n ?? 0;
    const [dl] = await d.db.root.select({ n: count() }).from(deadLetter).where(open);
    const sessions = await d.db.root
      .select({ status: session.status, n: count() })
      .from(session)
      .where(inArray(session.status, ["running", "queued"]))
      .groupBy(session.status);
    const llm = q<{ status: string; fallback: boolean; n: number; tin: number; tout: number; cost: number }>(
      await d.db.root.execute(
        sql`select status, used_fallback as fallback, count(*)::int as n, coalesce(sum(tokens_in),0)::bigint as tin, coalesce(sum(tokens_out),0)::bigint as tout, coalesce(sum(cost),0)::float as cost from llm_call group by status, used_fallback`,
      ),
    );
    const lat = q<{ p50: number | null; p95: number | null }>(
      await d.db.root.execute(
        sql`select percentile_cont(0.5) within group (order by latency_ms) as p50, percentile_cont(0.95) within group (order by latency_ms) as p95 from llm_call where created_at > now() - interval '1 hour'`,
      ),
    )[0];
    const mq = q<{ n: number; oldest: number | null }>(
      await d.db.root.execute(
        sql`select count(*)::int as n, extract(epoch from now() - min(enqueued_at))::float as oldest from merge_queue_item where status not in ('merged','failed','needs_human')`,
      ),
    )[0];
    const h = head?.seq ?? 0;
    const sum = (f: (r: (typeof llm)[number]) => number) => llm.reduce((n, r) => n + Number(f(r)), 0);
    return metrics.render({
      ap_event_consumer_lag: { help: "Events not yet processed per consumer (head seq - offset)", samples: consumers.map((c) => ({ labels: { consumer: c.name }, value: Math.max(0, h - c.offset) })) },
      ap_jobs: { help: "Jobs by status (queued, running, dead)", samples: ["queued", "running", "dead"].map((st) => ({ labels: { status: st }, value: jobs.find((j) => j.status === st)?.n ?? 0 })) },
      ap_jobs_failed_last_hour: { help: "Job attempts that failed in the last hour", samples: [{ value: failed1h }] },
      ap_dead_letters_open: { help: "Dead letters neither replayed nor discarded", samples: [{ value: dl?.n ?? 0 }] },
      ap_sessions_active: { help: "Agent sessions running or queued", samples: ["running", "queued"].map((st) => ({ labels: { status: st }, value: sessions.find((x) => x.status === st)?.n ?? 0 })) },
      ap_llm_calls: {
        help: "Model calls recorded, by status",
        samples: [...new Set(llm.map((r) => r.status))].map((st) => ({ labels: { status: st }, value: llm.filter((r) => r.status === st).reduce((n, r) => n + r.n, 0) })),
      },
      ap_llm_fallback_calls: { help: "Model calls served by a fallback model (degraded)", samples: [{ value: llm.filter((r) => r.fallback).reduce((n, r) => n + r.n, 0) }] },
      ap_llm_tokens: {
        help: "Model tokens recorded, by direction",
        samples: [
          { labels: { direction: "in" }, value: sum((r) => r.tin) },
          { labels: { direction: "out" }, value: sum((r) => r.tout) },
        ],
      },
      ap_llm_cost_usd: { help: "Model cost recorded (USD, at configured prices)", samples: [{ value: sum((r) => r.cost) }] },
      ap_llm_latency_seconds: {
        help: "Model call latency over the last hour",
        samples: [
          { labels: { quantile: "0.5" }, value: (lat?.p50 ?? 0) / 1000 },
          { labels: { quantile: "0.95" }, value: (lat?.p95 ?? 0) / 1000 },
        ],
      },
      ap_merge_queue_length: { help: "Merge queue items still in progress", samples: [{ value: mq?.n ?? 0 }] },
      ap_merge_queue_oldest_wait_seconds: { help: "Age of the oldest in-progress merge queue item", samples: [{ value: mq?.oldest ?? 0 }] },
    });
  }

  return { status, deadLetters, replay, discard, trace, metricsText };
}
export type System = ReturnType<typeof createSystem>;
