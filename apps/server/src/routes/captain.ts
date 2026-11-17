import { Elysia, t } from "elysia";
import { base } from "../http";
import type { Services } from "../services";

const P = t.Object({ id: t.String() });
const Item = t.Object({ text: t.String({ minLength: 1, maxLength: 300 }), seqs: t.Array(t.Number(), { maxItems: 50 }), decisionId: t.Optional(t.String()), taskId: t.Optional(t.String()) });
const SummaryBody = t.Object({
  decisions: t.Array(Item, { maxItems: 50 }),
  constraints: t.Array(Item, { maxItems: 50 }),
  openQuestions: t.Array(Item, { maxItems: 50 }),
  taskGraph: t.Array(Item, { maxItems: 50 }),
  risks: t.Array(Item, { maxItems: 50 }),
});

/** Captain, summaries, decisions, questions, sessions, models & budgets (S4). */
export const captainRoutes = (s: Services) =>
  new Elysia({ prefix: "/api/v1" })
    .use(base(s))
    .get("/groups/:id/summary", { params: P }, async ({ auth, params }) => s.captain.getSummary(await auth(), params.id))
    .post("/groups/:id/summary/refresh", { params: P }, async ({ auth, params }) => s.captain.refreshSummary(await auth(), params.id))
    .post("/groups/:id/summary/corrections", { params: P, body: t.Object({ content: SummaryBody, note: t.Optional(t.String({ maxLength: 500 })) }) }, async ({ auth, params, body }) =>
      s.captain.correctSummary(await auth(), params.id, body),
    )
    .get("/groups/:id/decisions", { params: P }, async ({ auth, params }) => s.captain.listDecisions(await auth(), params.id))
    .post(
      "/decisions/:id/:action",
      {
        params: t.Object({ id: t.String(), action: t.Union([t.Literal("confirm"), t.Literal("reject"), t.Literal("revoke")]) }),
        body: t.Object({ reason: t.Optional(t.String({ maxLength: 1000 })) }),
      },
      async ({ auth, params, body }) => s.captain.decide(await auth(), params.id, params.action, body.reason),
    )
    .get("/groups/:id/questions", { params: P }, async ({ auth, params }) => s.captain.listQuestions(await auth(), params.id))
    .post(
      "/questions/:id/answer",
      { params: P, body: t.Object({ option: t.Optional(t.String({ maxLength: 200 })), text: t.Optional(t.String({ maxLength: 2000 })) }) },
      async ({ auth, params, body }) => s.captain.answerQuestion(await auth(), params.id, body),
    )
    .post("/captain/ask", { body: t.Object({ question: t.String({ minLength: 1, maxLength: 500 }) }) }, async ({ auth, body }) => s.captain.askGlobal(await auth(), body))
    .get("/projects/:id/sessions", { params: P }, async ({ auth, params }) => s.runtime.listSessions(await auth(), params.id))
    .get("/sessions/:id", { params: P }, async ({ auth, params }) => s.runtime.getSession(await auth(), params.id))
    .get("/admin/models", async ({ auth }) => s.llm.listProviders(await auth()))
    .post(
      "/admin/models/providers",
      {
        body: t.Object({
          name: t.String({ minLength: 1, maxLength: 80 }),
          baseUrl: t.String({ minLength: 8, maxLength: 300 }),
          dialect: t.Union([t.Literal("openai"), t.Literal("ollama")]),
          isExternal: t.Boolean(),
          apiKey: t.Optional(t.String({ maxLength: 500 })),
          models: t.Array(
            t.Object({
              name: t.String({ minLength: 1, maxLength: 120 }),
              contextWindow: t.Optional(t.Number({ minimum: 512, maximum: 2_000_000 })),
              supportsTools: t.Optional(t.Boolean()),
              supportsJson: t.Optional(t.Boolean()),
              thinkOff: t.Optional(t.Boolean()),
              tier: t.Optional(t.Union([t.Literal("small"), t.Literal("large")])),
              inputPrice: t.Optional(t.Number({ minimum: 0 })),
              outputPrice: t.Optional(t.Number({ minimum: 0 })),
              embeddingDim: t.Optional(t.Number({ minimum: 1, maximum: 8192 })),
            }),
            { minItems: 1, maxItems: 20 },
          ),
        }),
      },
      async ({ auth, body }) => s.llm.createProvider(await auth(), body),
    )
    .post("/admin/models/providers/:id/test", { params: P }, async ({ auth, params }) => s.llm.testProvider(await auth(), params.id))
    .put("/admin/models/default", { body: t.Object({ name: t.String({ minLength: 1 }) }) }, async ({ auth, body }) => s.llm.setDefaultModel(await auth(), body.name))
    // §8.7: switching the embedding model rebuilds every knowledge index (queries keep using the old one until the alias switches).
    .put("/admin/models/embedding", { body: t.Object({ name: t.Union([t.String({ minLength: 1 }), t.Null()]) }) }, async ({ auth, body }) => {
      const ctx = await auth();
      const r = await s.llm.setEmbeddingModel(ctx, body.name);
      return { ...r, rebuildQueued: r.changed ? await s.knowledge.rebuildTenant(ctx.tenantId) : 0 };
    })
    .get("/admin/usage", { query: t.Object({ days: t.Optional(t.Numeric({ minimum: 1, maximum: 90 })) }) }, async ({ auth, query }) => s.llm.usage(await auth(), query.days))
    .put(
      "/admin/budgets",
      {
        body: t.Object({
          scopeType: t.Union([t.Literal("tenant"), t.Literal("project"), t.Literal("task")]),
          scopeId: t.String({ minLength: 1 }),
          limitTokens: t.Optional(t.Union([t.Number({ minimum: 0 }), t.Null()])),
          limitCost: t.Optional(t.Union([t.Number({ minimum: 0 }), t.Null()])),
        }),
      },
      async ({ auth, body }) => {
        const r = await s.llm.setBudget(await auth(), body);
        return { id: r.id, status: r.status };
      },
    )
    .post("/admin/agents/pause", { body: t.Object({ paused: t.Boolean() }) }, async ({ auth, body }) => s.runtime.setPaused(await auth(), body.paused))
    .get("/admin/agents/pause", async ({ auth }) => {
      const ctx = await auth();
      return { paused: await s.runtime.paused(ctx.tenantId) };
    });
