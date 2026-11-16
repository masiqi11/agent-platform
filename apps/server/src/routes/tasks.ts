import { Elysia, t } from "elysia";
import { base } from "../http";
import { Ok } from "../schemas";
import type { Services } from "../services";

const StatusLit = t.Union([
  t.Literal("backlog"),
  t.Literal("ready"),
  t.Literal("in_progress"),
  t.Literal("blocked"),
  t.Literal("in_review"),
  t.Literal("testing"),
  t.Literal("done"),
  t.Literal("cancelled"),
]);
const Priority = t.Union([t.Literal("P0"), t.Literal("P1"), t.Literal("P2"), t.Literal("P3")]);
const TaskType = t.Union([t.Literal("feature"), t.Literal("bug"), t.Literal("hotfix"), t.Literal("chore")]);
const Criterion = t.Object({ id: t.String(), text: t.String(), verdict: t.Optional(t.Union([t.Literal("met"), t.Literal("unmet"), t.Literal("na")])), note: t.Optional(t.String()) });
const PersonRef = t.Object({ principalId: t.String(), name: t.String() });
export const TaskSchema = t.Object({
  id: t.String(),
  projectId: t.String(),
  ref: t.String(),
  number: t.Number(),
  title: t.String(),
  description: t.String(),
  type: t.String(),
  priority: t.String(),
  status: StatusLit,
  assignee: t.Union([t.Object({ id: t.String(), name: t.String(), status: t.String(), principalId: t.String() }), t.Null()]),
  owners: t.Array(PersonRef),
  reviewers: t.Array(PersonRef),
  acceptanceCriteria: t.Array(Criterion),
  testPlan: t.Union([t.Record(t.String(), t.Unknown()), t.Null()]),
  dueAt: t.Union([t.String(), t.Null()]),
  groupId: t.Union([t.String(), t.Null()]),
  sourceMessageIds: t.Array(t.String()),
  followUpOf: t.Union([t.String(), t.Null()]),
  blockedReason: t.Union([t.String(), t.Null()]),
  blockedNeeds: t.Union([t.String(), t.Null()]),
  issueRef: t.Union([t.String(), t.Null()]),
  issueUrl: t.Union([t.String(), t.Null()]),
  version: t.Number(),
  reworkReviewCount: t.Number(),
  reworkTestCount: t.Number(),
  createdAt: t.String(),
  updatedAt: t.String(),
});
const Facts = t.Object({
  hasTitle: t.Boolean(),
  hasAcceptanceCriteria: t.Boolean(),
  hasAssignee: t.Boolean(),
  hasHumanOwner: t.Boolean(),
  workspaceReady: t.Boolean(),
  mrOpened: t.Boolean(),
  ciPassed: t.Boolean(),
  evidenceComplete: t.Boolean(),
  reviewApproved: t.Boolean(),
  testPlanExists: t.Boolean(),
  testPassed: t.Boolean(),
  merged: t.Boolean(),
  issueClosed: t.Boolean(),
  mergeApproved: t.Boolean(),
  mergeApprovalRequired: t.Boolean(),
  openBlockers: t.Number(),
});
const TaskDetail = t.Object({
  ...TaskSchema.properties,
  facts: Facts,
  myRoles: t.Array(t.String()),
  allowed: t.Array(t.Object({ to: t.String(), ok: t.Boolean(), reason: t.Union([t.String(), t.Null()]), missing: t.Array(t.String()) })),
});
const P = t.Object({ id: t.String() });
const Editable = {
  title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
  description: t.Optional(t.String({ maxLength: 20_000 })),
  type: t.Optional(TaskType),
  priority: t.Optional(Priority),
  dueAt: t.Optional(t.Union([t.String(), t.Null()])),
  assigneeAgentId: t.Optional(t.Union([t.String(), t.Null()])),
};

export const taskRoutes = (s: Services) =>
  new Elysia({ prefix: "/api/v1" })
    .use(base(s))
    .get(
      "/projects/:id/tasks",
      {
        params: P,
        query: t.Object({
          status: t.Optional(t.String()),
          assigneeAgentId: t.Optional(t.String()),
          ownerPrincipalId: t.Optional(t.String()),
          priority: t.Optional(t.String()),
          q: t.Optional(t.String()),
          groupId: t.Optional(t.String()),
        }),
        response: t.Array(TaskSchema),
      },
      async ({ auth, params, query }) => s.tasks.list(await auth(), params.id, query),
    )
    .post(
      "/tasks",
      {
        body: t.Object({
          projectId: t.String(),
          ...Editable,
          title: t.String({ minLength: 1, maxLength: 200 }),
          acceptanceCriteria: t.Optional(t.Array(t.String({ maxLength: 1000 }), { maxItems: 30 })),
          ownerPrincipalIds: t.Optional(t.Array(t.String(), { maxItems: 10 })),
          groupId: t.Optional(t.Union([t.String(), t.Null()])),
          sourceMessageIds: t.Optional(t.Array(t.String(), { maxItems: 50 })),
        }),
        response: TaskSchema,
      },
      async ({ auth, body }) => s.tasks.create(await auth(), body),
    )
    .get("/tasks/:id", { params: P, response: TaskDetail }, async ({ auth, params }) => s.tasks.get(await auth(), params.id))
    .patch(
      "/tasks/:id",
      {
        params: P,
        body: t.Object({
          ...Editable,
          acceptanceCriteria: t.Optional(
            t.Array(
              t.Object({
                id: t.Optional(t.String()),
                text: t.String({ maxLength: 1000 }),
                verdict: t.Optional(t.Union([t.Literal("met"), t.Literal("unmet"), t.Literal("na")])),
                note: t.Optional(t.String()),
              }),
              { maxItems: 30 },
            ),
          ),
          testPlan: t.Optional(t.Union([t.Record(t.String(), t.Unknown()), t.Null()])),
        }),
        response: TaskSchema,
      },
      async ({ auth, params, body, ifMatch }) => s.tasks.update(await auth(), params.id, body, ifMatch),
    )
    .post(
      "/tasks/:id/transition",
      {
        params: P,
        body: t.Object({ to: StatusLit, reason: t.Optional(t.String({ maxLength: 2000 })), needs: t.Optional(t.String({ maxLength: 200 })), evidenceArtifactId: t.Optional(t.String()) }),
        response: t.Object({ task: TaskSchema, status: t.String(), label: t.String() }),
      },
      async ({ auth, params, body, ifMatch }) => {
        const { to, ...input } = body;
        return s.tasks.transition(await auth(), params.id, to, input, { ifMatch });
      },
    )
    .get("/tasks/:id/facts", { params: P, response: Facts }, async ({ auth, params }) => {
      const ctx = await auth();
      const tk = await s.tasks.load(ctx, params.id);
      await s.identity.require(ctx, "project.view", { projectId: tk.projectId });
      return s.tasks.facts(tk);
    })
    .get(
      "/tasks/:id/timeline",
      {
        params: P,
        response: t.Array(
          t.Object({
            seq: t.Number(),
            type: t.String(),
            payload: t.Record(t.String(), t.Unknown()),
            actor: t.Object({ principalId: t.String(), name: t.String(), kind: t.String() }),
            createdAt: t.String(),
          }),
        ),
      },
      async ({ auth, params }) => s.tasks.timeline(await auth(), params.id),
    )
    .get(
      "/tasks/:id/comments",
      { params: P, response: t.Array(t.Object({ id: t.String(), body: t.String(), author: t.Object({ principalId: t.String(), name: t.String(), kind: t.String() }), createdAt: t.String() })) },
      async ({ auth, params }) => s.tasks.comments(await auth(), params.id),
    )
    .post("/tasks/:id/comments", { params: P, body: t.Object({ body: t.String({ minLength: 1, maxLength: 20_000 }) }), response: t.Object({ id: t.String() }) }, async ({ auth, params, body }) =>
      s.tasks.comment(await auth(), params.id, body.body),
    )
    .put(
      "/tasks/:id/owners/:principalId",
      { params: t.Object({ id: t.String(), principalId: t.String() }), body: t.Object({ role: t.Optional(t.Union([t.Literal("owner"), t.Literal("reviewer")])) }), response: Ok },
      async ({ auth, params, body }) => s.tasks.setOwner(await auth(), params.id, params.principalId, body.role ?? "owner", true),
    )
    .delete(
      "/tasks/:id/owners/:principalId",
      { params: t.Object({ id: t.String(), principalId: t.String() }), query: t.Object({ role: t.Optional(t.Union([t.Literal("owner"), t.Literal("reviewer")])) }), response: Ok },
      async ({ auth, params, query }) => s.tasks.setOwner(await auth(), params.id, params.principalId, query.role ?? "owner", false),
    )
    .post(
      "/tasks/:id/follow-up",
      { params: P, body: t.Object({ title: t.Optional(t.String({ maxLength: 200 })), description: t.Optional(t.String()) }), response: TaskSchema },
      async ({ auth, params, body }) => s.tasks.followUp(await auth(), params.id, body),
    );
