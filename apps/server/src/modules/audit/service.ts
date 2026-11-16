import { and, desc, eq, gte, lte, lt, type SQL } from "drizzle-orm";
import type { Database } from "../../db";
import { auditLog, principal } from "../../db/schema";
import type { Audit } from "../../core/audit";
import type { Ctx } from "../../core/context";
import { sha256Hex } from "../../core/crypto";
import type { Identity } from "../identity/service";

export interface AuditFilter {
  actor?: string;
  resourceType?: string;
  resourceId?: string;
  action?: string;
  from?: string;
  to?: string;
  projectId?: string;
  cursor?: string;
  limit?: number;
}

export function createAuditQuery(d: { db: Database; audit: Audit; identity: Identity }) {
  async function scope(ctx: Ctx, projectId?: string) {
    // Maintainers may only see their own project's audit (§9.7).
    const t = ctx.actor.tenantRole;
    if (t === "owner" || t === "admin" || t === "auditor") return projectId;
    if (!projectId) {
      const { forbidden } = await import("../../core/errors");
      throw forbidden("Auditor / Admin（Maintainer 需指定项目）");
    }
    await d.identity.require(ctx, "audit.view", { projectId });
    return projectId;
  }

  function where(ctx: Ctx, f: AuditFilter, projectId?: string): SQL {
    const c: SQL[] = [eq(auditLog.tenantId, ctx.tenantId)];
    if (projectId) c.push(eq(auditLog.projectId, projectId));
    if (f.actor) c.push(eq(auditLog.actorPrincipalId, f.actor));
    if (f.resourceType) c.push(eq(auditLog.resourceType, f.resourceType));
    if (f.resourceId) c.push(eq(auditLog.resourceId, f.resourceId));
    if (f.action) c.push(eq(auditLog.action, f.action));
    if (f.from) c.push(gte(auditLog.createdAt, new Date(f.from)));
    if (f.to) c.push(lte(auditLog.createdAt, new Date(f.to)));
    if (f.cursor) c.push(lt(auditLog.seq, Number(f.cursor)));
    return and(...c)!;
  }

  async function list(ctx: Ctx, f: AuditFilter) {
    const pid = await scope(ctx, f.projectId);
    const limit = Math.min(f.limit ?? 50, 200);
    const rows = await d.db.root.select({ a: auditLog, actorName: principal.displayName, actorKind: principal.kind }).from(auditLog).leftJoin(principal, eq(principal.id, auditLog.actorPrincipalId)).where(where(ctx, f, pid)).orderBy(desc(auditLog.seq)).limit(limit + 1);
    const items = rows.slice(0, limit).map(({ a, actorName, actorKind }) => ({
      id: a.id,
      seq: a.seq,
      actorPrincipalId: a.actorPrincipalId,
      actorName: actorName ?? a.actorPrincipalId,
      actorKind: (actorKind ?? "system") as string,
      action: a.action,
      resourceType: a.resourceType,
      resourceId: a.resourceId,
      projectId: a.projectId,
      before: a.before as unknown,
      after: a.after as unknown,
      policy: a.policy as Record<string, unknown>,
      outcome: a.outcome,
      traceId: a.traceId,
      hash: a.hash,
      createdAt: a.createdAt.toISOString(),
    }));
    return { items, nextCursor: rows.length > limit ? String(items[items.length - 1]!.seq) : null };
  }

  /** CSV/JSONL export with exporter, range, row count and file hash; the export itself is audited (OBS-补5). */
  async function exportRows(ctx: Ctx, f: AuditFilter, format: "csv" | "jsonl") {
    await d.identity.require(ctx, "audit.export", { projectId: f.projectId });
    const pid = await scope(ctx, f.projectId);
    const rows = await d.db.root.select().from(auditLog).where(where(ctx, { ...f, cursor: undefined }, pid)).orderBy(desc(auditLog.seq)).limit(100_000);
    let body: string;
    if (format === "jsonl") body = rows.map((r) => JSON.stringify(r)).join("\n");
    else {
      const esc = (v: unknown) => `"${String(typeof v === "object" && v !== null ? JSON.stringify(v) : (v ?? "")).replace(/"/g, '""')}"`;
      const cols = ["seq", "createdAt", "actorPrincipalId", "action", "resourceType", "resourceId", "outcome", "traceId", "hash"] as const;
      body = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(c === "createdAt" ? r.createdAt.toISOString() : r[c])).join(","))].join("\n");
    }
    const fileHash = sha256Hex(body);
    await d.audit.write(ctx, { action: "audit.export", resourceType: "audit", resourceId: ctx.tenantId, after: { rows: rows.length, format, from: f.from ?? null, to: f.to ?? null, fileHash } });
    return { body, rows: rows.length, fileHash };
  }

  async function verify(ctx: Ctx) {
    await d.identity.require(ctx, "audit.view");
    const r = await d.audit.verify(ctx.tenantId);
    return { ok: r.ok, count: r.count, brokenAt: r.brokenAt ?? null, head: r.head ?? null, checkedAt: new Date().toISOString() };
  }

  return { list, exportRows, verify };
}
