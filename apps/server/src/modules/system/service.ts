import { count, eq, isNull, max, min, sql } from "drizzle-orm";
import type { Ctx } from "../../core/context";
import type { Database } from "../../db";
import { expectedMigration } from "../../db/migrate";
import { deadLetter, event, eventConsumer, modelProvider } from "../../db/schema";
import type { Identity } from "../identity/service";
import type { Sandbox } from "../sandbox/service";
import type { Workspaces } from "../workspaces/service";

/** System status page (ADM-补3): db, migration, consumer lag, job backlog, dead letters, sandbox, providers, disk. */
export function createSystem(d: { db: Database; identity: Identity; sandbox: Sandbox; workspaces: Workspaces; jobs: { counts(): Promise<Record<string, number>> } }) {
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
    const [dl] = await d.db.root.select({ n: count() }).from(deadLetter).where(isNull(deadLetter.replayedAt));
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
  return { status };
}
export type System = ReturnType<typeof createSystem>;
