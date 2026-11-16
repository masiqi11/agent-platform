import { Elysia, t } from "elysia";
import { base } from "../http";
import type { Services } from "../services";

const P = t.Object({ id: t.String() });
const Route = t.Object({ route: t.String(), score: t.Number(), rank: t.Number() });
const Hit = t.Object({
  id: t.String(),
  projectId: t.String(),
  projectKey: t.String(),
  repoId: t.Union([t.String(), t.Null()]),
  repoName: t.Union([t.String(), t.Null()]),
  sourceKind: t.String(),
  path: t.String(),
  symbol: t.Union([t.String(), t.Null()]),
  commit: t.String(),
  startLine: t.Number(),
  endLine: t.Number(),
  text: t.String(),
  score: t.Number(),
  routes: t.Array(Route),
  stale: t.Boolean(),
});
const RouteReport = t.Object({ enabled: t.Boolean(), candidates: t.Number(), note: t.Optional(t.String()), projects: t.Array(t.String()) });
const Citation = t.Object({ projectId: t.String(), repoId: t.String(), path: t.String(), commit: t.String(), lines: t.Optional(t.Tuple([t.Number(), t.Number()])) });

/** S7 knowledge routes: search (explainable routes), ask the project captain, index status, citation file view, catalog, eval. */
export const knowledgeRoutes = (s: Services) =>
  new Elysia({ prefix: "/api/v1" })
    .use(base(s))
    .get(
      "/projects/:id/knowledge/search",
      {
        params: P,
        query: t.Object({ q: t.String({ minLength: 1, maxLength: 500 }), routes: t.Optional(t.String()), limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20 })) }),
        response: t.Object({ results: t.Array(Hit), routes: t.Object({ bm25: RouteReport, sag2: RouteReport, vector: RouteReport }) }),
      },
      async ({ auth, params, query }) => {
        const ctx = await auth();
        await s.identity.projectInTenant(ctx, params.id);
        await s.identity.require(ctx, "project.view", { projectId: params.id });
        const sel = query.routes ? new Set(query.routes.split(",")) : null;
        const r = await s.knowledge.search(ctx, {
          query: query.q,
          projectIds: [params.id],
          limit: query.limit,
          routes: sel ? { bm25: sel.has("bm25"), sag2: sel.has("sag2"), vector: sel.has("vector") } : undefined,
        });
        return { results: r.results, routes: r.routes };
      },
    )
    .post(
      "/projects/:id/knowledge/ask",
      {
        params: P,
        body: t.Object({ question: t.String({ minLength: 1, maxLength: 500 }) }),
        response: t.Object({
          answer: t.String(),
          citations: t.Array(Citation),
          confidence: t.String(),
          stale: t.Boolean(),
          followUp: t.Optional(t.String()),
          hits: t.Array(Hit),
          model: t.Union([t.String(), t.Null()]),
        }),
      },
      async ({ auth, params, body }) => s.knowledge.askProjectCaptain(await auth(), { projectId: params.id, question: body.question }),
    )
    .get(
      "/projects/:id/knowledge/status",
      {
        params: P,
        response: t.Object({
          embeddingModel: t.Union([t.String(), t.Null()]),
          chunks: t.Number(),
          indexes: t.Array(
            t.Object({
              repoId: t.Union([t.String(), t.Null()]),
              name: t.String(),
              version: t.Number(),
              commit: t.Union([t.String(), t.Null()]),
              status: t.String(),
              stale: t.Boolean(),
              embeddingModel: t.Union([t.String(), t.Null()]),
              stats: t.Record(t.String(), t.Unknown()),
              updatedAt: t.Union([t.String(), t.Null()]),
            }),
          ),
        }),
      },
      async ({ auth, params }) => s.knowledge.status(await auth(), params.id),
    )
    .post(
      "/projects/:id/knowledge/reindex",
      { params: P, body: t.Object({ full: t.Optional(t.Boolean()) }), response: t.Object({ ok: t.Literal(true), queued: t.Number() }) },
      async ({ auth, params, body }) => s.knowledge.reindex(await auth(), params.id, Boolean(body.full)),
    )
    .get(
      "/projects/:id/knowledge/file",
      {
        params: P,
        query: t.Object({ repoId: t.String(), path: t.String({ maxLength: 1000 }), commit: t.String({ maxLength: 64 }) }),
        response: t.Object({ repoName: t.String(), path: t.String(), commit: t.String(), headCommit: t.String(), stale: t.Boolean(), content: t.String() }),
      },
      async ({ auth, params, query }) => s.knowledge.file(await auth(), params.id, query),
    )
    .get(
      "/projects/:id/catalog",
      {
        params: P,
        response: t.Object({
          project: t.Object({ id: t.String(), key: t.String(), name: t.String(), description: t.String(), defaultBranch: t.String() }),
          repos: t.Array(t.Object({ id: t.String(), name: t.String(), provider: t.String(), defaultBranch: t.String(), lastIndexedCommit: t.Union([t.String(), t.Null()]) })),
          modules: t.Array(
            t.Object({ id: t.String(), name: t.String(), path: t.String(), repoId: t.Union([t.String(), t.Null()]), owner: t.Union([t.String(), t.Null()]), dependsOn: t.Array(t.String()) }),
          ),
          maintainers: t.Array(t.String()),
          agents: t.Array(t.String()),
        }),
      },
      async ({ auth, params }) => s.knowledge.catalog(await auth(), params.id),
    )
    .post(
      "/projects/:id/knowledge/eval",
      {
        params: P,
        response: t.Object({
          k: t.Number(),
          total: t.Number(),
          recall: t.Number(),
          results: t.Array(t.Object({ question: t.String(), expected: t.Array(t.String()), found: t.Array(t.String()), hit: t.Boolean() })),
        }),
      },
      async ({ auth, params }) => {
        const ctx = await auth();
        await s.identity.projectInTenant(ctx, params.id);
        await s.identity.require(ctx, "project.view", { projectId: params.id });
        return s.knowledge.evaluate(ctx, params.id);
      },
    );
