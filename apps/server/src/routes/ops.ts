import { timingSafeEqual } from "node:crypto";
import { Elysia, t } from "elysia";
import { base } from "../http";
import { Ok } from "../schemas";
import type { Services } from "../services";

const P = t.Object({ id: t.String() });
const DeadLetter = t.Object({
  id: t.String(),
  source: t.String(),
  refId: t.String(),
  consumer: t.Union([t.String(), t.Null()]),
  summary: t.String(),
  error: t.String(),
  attempts: t.Number(),
  state: t.String(),
  createdAt: t.String(),
  replayedAt: t.Union([t.String(), t.Null()]),
});

const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Operations (§16.1, ADM-补4, FR-OBS-02): metrics, dead letters, trace lookup. */
export const opsRoutes = (s: Services) =>
  new Elysia()
    // Prometheus scrape: bearer METRICS_TOKEN. Without a token it is open only outside production.
    .get("/metrics", async ({ request, set }) => {
      const want = s.config.metricsToken;
      const got = request.headers.get("authorization")?.replace(/^bearer\s+/i, "") ?? "";
      if (want ? !sameToken(got, want) : s.config.isProd) {
        set.status = want ? 401 : 404;
        return want ? "unauthorized\n" : "not found\n";
      }
      set.headers["content-type"] = "text/plain; version=0.0.4; charset=utf-8";
      return s.system.metricsText();
    })
    .group("/api/v1/admin", (g) =>
      g
        .use(base(s))
        .get("/dead-letters", { query: t.Object({ state: t.Optional(t.Union([t.Literal("open"), t.Literal("all")])) }), response: t.Array(DeadLetter) }, async ({ auth, query }) =>
          s.system.deadLetters(await auth(), { state: query.state }),
        )
        .post("/dead-letters/:id/replay", { params: P, response: Ok }, async ({ auth, params }) => s.system.replay(await auth(), params.id))
        .post("/dead-letters/:id/discard", { params: P, body: t.Object({ reason: t.String({ minLength: 2, maxLength: 500 }) }), response: Ok }, async ({ auth, params, body }) =>
          s.system.discard(await auth(), params.id, body.reason),
        )
        .get(
          "/traces",
          {
            query: t.Object({ traceId: t.Optional(t.String({ maxLength: 100 })), taskId: t.Optional(t.String({ maxLength: 100 })) }),
            response: t.Object({
              traceIds: t.Array(t.String()),
              items: t.Array(t.Object({ at: t.String(), traceId: t.String(), kind: t.String(), name: t.String(), ref: t.String(), status: t.Union([t.String(), t.Null()]) })),
            }),
          },
          async ({ auth, query }) => s.system.trace(await auth(), query),
        ),
    );
