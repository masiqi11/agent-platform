import { Elysia, t } from "elysia";
import { base } from "../http";
import type { Services } from "../services";

const filterProps = {
  actor: t.Optional(t.String()),
  resourceType: t.Optional(t.String()),
  resourceId: t.Optional(t.String()),
  action: t.Optional(t.String()),
  from: t.Optional(t.String()),
  to: t.Optional(t.String()),
  projectId: t.Optional(t.String()),
  cursor: t.Optional(t.String()),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
};
const Filter = t.Object(filterProps);
const Entry = t.Object({
  id: t.String(),
  seq: t.Number(),
  actorPrincipalId: t.String(),
  actorName: t.String(),
  actorKind: t.String(),
  action: t.String(),
  resourceType: t.String(),
  resourceId: t.String(),
  projectId: t.Union([t.String(), t.Null()]),
  before: t.Unknown(),
  after: t.Unknown(),
  policy: t.Record(t.String(), t.Unknown()),
  outcome: t.String(),
  traceId: t.Union([t.String(), t.Null()]),
  hash: t.String(),
  createdAt: t.String(),
});

export const auditRoutes = (s: Services) =>
  new Elysia({ prefix: "/api/v1/audit" })
    .use(base(s))
    .get("/", { query: Filter, response: t.Object({ items: t.Array(Entry), nextCursor: t.Union([t.String(), t.Null()]) }) }, async ({ auth, query }) => s.auditQuery.list(await auth(), query))
    .get("/verify", { response: t.Object({ ok: t.Boolean(), count: t.Number(), brokenAt: t.Union([t.Number(), t.Null()]), head: t.Union([t.String(), t.Null()]), checkedAt: t.String() }) }, async ({ auth }) => s.auditQuery.verify(await auth()))
    .get("/export", { query: t.Object({ ...filterProps, format: t.Optional(t.Union([t.Literal("csv"), t.Literal("jsonl")])) }) }, async ({ auth, query, set }) => {
      const format = query.format ?? "csv";
      const r = await s.auditQuery.exportRows(await auth(), query, format);
      set.headers["content-type"] = format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson";
      set.headers["content-disposition"] = `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.${format}"`;
      set.headers["x-audit-rows"] = String(r.rows);
      set.headers["x-audit-sha256"] = r.fileHash;
      return r.body;
    });
