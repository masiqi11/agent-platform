import { Elysia, t } from "elysia";
import { base } from "../http";
import { Ok } from "../schemas";
import type { Services } from "../services";
import { TaskSchema } from "./tasks";

const P = t.Object({ id: t.String() });
const Verdict3 = t.Union([t.Literal("met"), t.Literal("unmet"), t.Literal("na")]);
const ReviewView = t.Object({
  id: t.String(),
  reviewer: t.Object({ principalId: t.String(), name: t.String(), kind: t.String() }),
  headSha: t.String(),
  current: t.Boolean(),
  verdict: t.String(),
  comments: t.Array(t.Object({ path: t.Optional(t.String()), line: t.Optional(t.Number()), body: t.String(), resolved: t.Optional(t.Boolean()) })),
  criteria: t.Record(t.String(), t.String()),
  round: t.Number(),
  createdAt: t.String(),
});
const TestView = t.Object({
  id: t.String(),
  tester: t.Object({ principalId: t.String(), name: t.String() }),
  headSha: t.String(),
  current: t.Boolean(),
  status: t.String(),
  attempt: t.Number(),
  criteriaResults: t.Array(t.Object({ id: t.String(), text: t.String(), verdict: t.String(), evidence: t.Optional(t.String()) })),
  logArtifactId: t.Union([t.String(), t.Null()]),
  reportArtifactId: t.Union([t.String(), t.Null()]),
  durationMs: t.Union([t.Number(), t.Null()]),
  createdAt: t.String(),
});
const QueueItem = t.Object({
  id: t.String(),
  taskId: t.String(),
  ref: t.String(),
  title: t.String(),
  status: t.String(),
  position: t.Number(),
  headSha: t.Union([t.String(), t.Null()]),
  rebasedSha: t.Union([t.String(), t.Null()]),
  mergeSha: t.Union([t.String(), t.Null()]),
  attempts: t.Number(),
  lastError: t.Union([t.String(), t.Null()]),
  conflictFiles: t.Array(t.String()),
  enqueuedAt: t.String(),
  updatedAt: t.String(),
});
const QueueState = t.Object({ paused: t.Boolean(), reason: t.Optional(t.String()), sha: t.Optional(t.String()), at: t.Optional(t.String()), by: t.Optional(t.String()) });

/** S6 routes: reviews (incl. human override), test runs, merge gate, merge queue, release record, rollback. */
export const qualityRoutes = (s: Services) =>
  new Elysia({ prefix: "/api/v1" })
    .use(base(s))
    .get("/tasks/:id/reviews", { params: P, response: t.Array(ReviewView) }, async ({ auth, params }) => s.quality.reviewsOf(await auth(), params.id))
    .post(
      "/tasks/:id/reviews",
      {
        params: P,
        body: t.Object({
          verdict: t.Union([t.Literal("approved"), t.Literal("changes_requested")]),
          summary: t.Optional(t.String({ maxLength: 4000 })),
          comments: t.Optional(
            t.Array(t.Object({ path: t.Optional(t.String({ maxLength: 500 })), line: t.Optional(t.Integer({ minimum: 1 })), body: t.String({ minLength: 1, maxLength: 2000 }) }), { maxItems: 50 }),
          ),
          criteria: t.Optional(t.Record(t.String(), Verdict3)),
        }),
        response: t.Object({ id: t.String(), verdict: t.String(), headSha: t.String(), round: t.Number(), status: t.String(), note: t.Union([t.String(), t.Null()]) }),
      },
      async ({ auth, params, body }) => {
        const r = await s.quality.submitReview(await auth(), params.id, body);
        return { ...r, headSha: r.headSha ?? "" };
      },
    )
    .get("/tasks/:id/tests", { params: P, response: t.Array(TestView) }, async ({ auth, params }) => s.quality.testsOf(await auth(), params.id))
    .get(
      "/tasks/:id/gate",
      {
        params: P,
        response: t.Object({
          ok: t.Boolean(),
          items: t.Array(t.Object({ key: t.String(), label: t.String(), ok: t.Boolean() })),
          missing: t.Array(t.String()),
          merge: t.Union([QueueItem, t.Null()]),
          queue: QueueState,
          release: t.Union([
            t.Object({
              id: t.String(),
              mrRef: t.Union([t.String(), t.Null()]),
              mergeCommit: t.String(),
              testRunId: t.Union([t.String(), t.Null()]),
              approvedBy: t.Union([t.String(), t.Null()]),
              createdAt: t.String(),
            }),
            t.Null(),
          ]),
        }),
      },
      async ({ auth, params }) => {
        const ctx = await auth();
        const tk = await s.tasks.load(ctx, params.id);
        await s.identity.require(ctx, "project.view", { projectId: tk.projectId });
        const g = await s.quality.gate(tk);
        const q = await s.mergeQueue.list(ctx, tk.projectId);
        const rel = await s.mergeQueue.releaseOf(tk.id);
        return {
          ok: g.ok,
          items: g.items,
          missing: g.missing,
          merge: q.items.find((i) => i.taskId === tk.id) ?? null,
          queue: q.state,
          release: rel ? { id: rel.id, mrRef: rel.mrRef, mergeCommit: rel.mergeCommit, testRunId: rel.testRunId, approvedBy: rel.approvedBy, createdAt: rel.createdAt.toISOString() } : null,
        };
      },
    )
    .post("/tasks/:id/merge/retry", { params: P, response: Ok }, async ({ auth, params }) => s.mergeQueue.retry(await auth(), params.id))
    .post("/tasks/:id/rollback", { params: P, response: TaskSchema }, async ({ auth, params }) => s.mergeQueue.rollbackTask(await auth(), params.id))
    .get("/projects/:id/merge-queue", { params: P, response: t.Object({ state: QueueState, items: t.Array(QueueItem) }) }, async ({ auth, params }) => s.mergeQueue.list(await auth(), params.id))
    .post("/projects/:id/merge-queue/resume", { params: P, response: Ok }, async ({ auth, params }) => s.mergeQueue.resume(await auth(), params.id));
