import { Elysia, t } from "elysia";
import { base } from "../http";
import type { Services } from "../services";

const ProposalSchema = t.Object({
  id: t.String(),
  projectId: t.String(),
  groupId: t.Union([t.String(), t.Null()]),
  kind: t.String(),
  payload: t.Record(t.String(), t.Unknown()),
  status: t.String(),
  sourceMessageIds: t.Array(t.String()),
  proposedBy: t.String(),
  decidedBy: t.Union([t.String(), t.Null()]),
  decidedAt: t.Union([t.String(), t.Null()]),
  reason: t.Union([t.String(), t.Null()]),
  messageId: t.Union([t.String(), t.Null()]),
  resultTaskIds: t.Array(t.String()),
  expiresAt: t.String(),
  createdAt: t.String(),
  updatedAt: t.String(),
});
const Person = t.Object({ principalId: t.String(), name: t.Union([t.String(), t.Null()]) });
const ApprovalSchema = t.Object({
  id: t.String(),
  taskId: t.String(),
  kind: t.String(),
  status: t.String(),
  headSha: t.Union([t.String(), t.Null()]),
  requestedBy: Person,
  decidedBy: t.Union([Person, t.Null()]),
  decidedAt: t.Union([t.String(), t.Null()]),
  reason: t.Union([t.String(), t.Null()]),
  rejectTo: t.Union([t.String(), t.Null()]),
  evidence: t.Record(t.String(), t.Unknown()),
  expiresAt: t.String(),
  escalatedAt: t.Union([t.String(), t.Null()]),
  createdAt: t.String(),
});
const InboxSchema = t.Object({
  unread: t.Number(),
  items: t.Array(
    t.Object({
      id: t.String(),
      kind: t.String(),
      refType: t.String(),
      refId: t.String(),
      title: t.String(),
      count: t.Number(),
      projectId: t.Union([t.String(), t.Null()]),
      projectName: t.Union([t.String(), t.Null()]),
      projectKey: t.Union([t.String(), t.Null()]),
      read: t.Boolean(),
      updatedAt: t.String(),
    }),
  ),
});
const P = t.Object({ id: t.String() });

export const flowRoutes = (s: Services) =>
  new Elysia({ prefix: "/api/v1" })
    .use(base(s))
    .get("/projects/:id/proposals", { params: P, query: t.Object({ status: t.Optional(t.String()) }), response: t.Array(ProposalSchema) }, async ({ auth, params, query }) =>
      s.proposals.list(await auth(), params.id, query.status),
    )
    .get("/proposals/:id", { params: P, response: ProposalSchema }, async ({ auth, params }) => s.proposals.get(await auth(), params.id))
    .patch(
      "/proposals/:id",
      {
        params: P,
        body: t.Object({
          title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
          description: t.Optional(t.String({ maxLength: 20_000 })),
          acceptanceCriteria: t.Optional(t.Array(t.String({ maxLength: 1000 }), { maxItems: 30 })),
          priority: t.Optional(t.Union([t.Literal("P0"), t.Literal("P1"), t.Literal("P2"), t.Literal("P3")])),
          assigneeAgentId: t.Optional(t.Union([t.String(), t.Null()])),
        }),
        response: ProposalSchema,
      },
      async ({ auth, params, body }) => s.proposals.edit(await auth(), params.id, body),
    )
    .post("/proposals/:id/accept", { params: P, response: ProposalSchema }, async ({ auth, params }) => s.proposals.accept(await auth(), params.id))
    .post("/proposals/:id/reject", { params: P, body: t.Object({ reason: t.String({ minLength: 1, maxLength: 2000 }) }), response: ProposalSchema }, async ({ auth, params, body }) =>
      s.proposals.reject(await auth(), params.id, body.reason),
    )
    .post(
      "/tasks/:id/approvals",
      {
        params: P,
        body: t.Object({ kind: t.Union([t.Literal("merge"), t.Literal("release"), t.Literal("credential"), t.Literal("budget")]), evidence: t.Optional(t.Record(t.String(), t.Unknown())) }),
        response: ApprovalSchema,
      },
      async ({ auth, params, body }) => s.approvals.request(await auth(), params.id, body),
    )
    .get("/tasks/:id/approvals", { params: P, response: t.Array(ApprovalSchema) }, async ({ auth, params }) => s.approvals.list(await auth(), { taskId: params.id }))
    .get("/approvals", { response: t.Array(ApprovalSchema) }, async ({ auth }) => s.approvals.list(await auth(), { mine: true }))
    .get("/approvals/:id", { params: P, response: ApprovalSchema }, async ({ auth, params }) => s.approvals.get(await auth(), params.id))
    .post(
      "/approvals/:id/decide",
      {
        params: P,
        body: t.Object({
          decision: t.Union([t.Literal("approve"), t.Literal("reject")]),
          reason: t.Optional(t.String({ maxLength: 2000 })),
          rejectTo: t.Optional(t.Union([t.Literal("in_progress"), t.Literal("blocked")])),
        }),
        response: ApprovalSchema,
      },
      async ({ auth, params, body }) => s.approvals.decide(await auth(), params.id, body),
    )
    .get(
      "/inbox",
      { query: t.Object({ kind: t.Optional(t.String()), unread: t.Optional(t.BooleanString()), limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })) }), response: InboxSchema },
      async ({ auth, query }) => s.inbox.list(await auth(), query),
    )
    .post(
      "/inbox/read",
      { body: t.Object({ ids: t.Optional(t.Array(t.String(), { maxItems: 500 })), all: t.Optional(t.Boolean()) }), response: t.Object({ ok: t.Literal(true), updated: t.Number() }) },
      async ({ auth, body }) => s.inbox.markRead(await auth(), body),
    );
