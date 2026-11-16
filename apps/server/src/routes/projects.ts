import { Elysia, t } from "elysia";
import { base, idempotent } from "../http";
import { Ok } from "../schemas";
import type { Services } from "../services";

const Settings = t.Partial(
  t.Object({
    autoAssignPriorities: t.Array(t.Union([t.Literal("P0"), t.Literal("P1"), t.Literal("P2"), t.Literal("P3")])),
    mergePolicy: t.Union([t.Literal("require_approval"), t.Literal("auto")]),
    agentsMayCreateIssues: t.Boolean(),
    localModelsOnly: t.Boolean(),
    sensitivePaths: t.Array(t.String()),
    changeLimits: t.Object({ files: t.Integer({ minimum: 1 }), lines: t.Integer({ minimum: 1 }) }),
    indexExcludes: t.Array(t.String()),
    egressAllowlist: t.Array(t.String()),
    branchPattern: t.String({ maxLength: 80 }),
  }),
);
const ProjectCard = t.Object({
  id: t.String(),
  key: t.String(),
  name: t.String(),
  description: t.String(),
  status: t.String(),
  counts: t.Object({ inProgress: t.Number(), blocked: t.Number(), inReview: t.Number(), total: t.Number() }),
  agents: t.Array(t.Object({ id: t.String(), name: t.String(), role: t.String(), status: t.String() })),
  lastActivityAt: t.Union([t.String(), t.Null()]),
  createdAt: t.String(),
});
const ProjectDetail = t.Object({
  id: t.String(),
  key: t.String(),
  name: t.String(),
  description: t.String(),
  defaultBranch: t.String(),
  status: t.String(),
  settings: t.Record(t.String(), t.Unknown()),
  mainGroupId: t.Union([t.String(), t.Null()]),
  myRole: t.Union([t.String(), t.Null()]),
  canManage: t.Boolean(),
  createdAt: t.String(),
});
const Member = t.Object({
  principalId: t.String(),
  name: t.String(),
  kind: t.String(),
  role: t.String(),
  email: t.Union([t.String(), t.Null()]),
  agentRole: t.Union([t.String(), t.Null()]),
  active: t.Boolean(),
});
const Module = t.Object({
  id: t.String(),
  name: t.String(),
  path: t.String(),
  repoId: t.Union([t.String(), t.Null()]),
  ownerPrincipalId: t.Union([t.String(), t.Null()]),
  dependsOn: t.Array(t.String()),
});
const P = t.Object({ id: t.String() });

export const projectRoutes = (s: Services) =>
  new Elysia({ prefix: "/api/v1/projects" })
    .use(base(s))
    .get("/", { response: t.Array(ProjectCard) }, async ({ auth }) => s.projects.list(await auth()))
    .post(
      "/",
      {
        body: t.Object({
          key: t.String({ minLength: 2, maxLength: 10 }),
          name: t.String({ minLength: 1, maxLength: 80 }),
          description: t.Optional(t.String({ maxLength: 2000 })),
          defaultBranch: t.Optional(t.String({ maxLength: 100 })),
        }),
        response: t.Object({ id: t.String(), key: t.String(), mainGroupId: t.String(), captainAgentId: t.String() }),
      },
      async ({ auth, body, idemKey }) => {
        const ctx = await auth();
        return idempotent(s, ctx, idemKey, body, () => s.projects.create(ctx, body));
      },
    )
    .get("/:id", { params: P, response: ProjectDetail }, async ({ auth, params }) => s.projects.get(await auth(), params.id))
    .patch(
      "/:id",
      {
        params: P,
        body: t.Object({
          name: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
          description: t.Optional(t.String({ maxLength: 2000 })),
          defaultBranch: t.Optional(t.String({ maxLength: 100 })),
          settings: t.Optional(Settings),
        }),
        response: Ok,
      },
      async ({ auth, params, body }) => s.projects.update(await auth(), params.id, body),
    )
    .post("/:id/archive", { params: P, body: t.Object({ reason: t.String({ minLength: 2, maxLength: 500 }) }), response: Ok }, async ({ auth, params, body }) =>
      s.projects.archive(await auth(), params.id, body.reason),
    )
    .get("/:id/members", { params: P, response: t.Array(Member) }, async ({ auth, params }) => s.projects.members(await auth(), params.id))
    .put(
      "/:id/members/:principalId",
      { params: t.Object({ id: t.String(), principalId: t.String() }), body: t.Object({ role: t.Union([t.Literal("maintainer"), t.Literal("member"), t.Literal("viewer")]) }), response: Ok },
      async ({ auth, params, body }) => s.projects.setMember(await auth(), params.id, params.principalId, body.role),
    )
    .delete("/:id/members/:principalId", { params: t.Object({ id: t.String(), principalId: t.String() }), response: Ok }, async ({ auth, params }) =>
      s.projects.setMember(await auth(), params.id, params.principalId, null),
    )
    .get("/:id/modules", { params: P, response: t.Array(Module) }, async ({ auth, params }) => s.projects.listModules(await auth(), params.id))
    .post(
      "/:id/modules",
      {
        params: P,
        body: t.Object({
          id: t.Optional(t.String()),
          name: t.String({ minLength: 1, maxLength: 80 }),
          path: t.String({ minLength: 1, maxLength: 300 }),
          repoId: t.Optional(t.Union([t.String(), t.Null()])),
          ownerPrincipalId: t.Optional(t.Union([t.String(), t.Null()])),
          dependsOn: t.Optional(t.Array(t.String())),
        }),
        response: t.Object({ id: t.String() }),
      },
      async ({ auth, params, body }) => s.projects.upsertModule(await auth(), params.id, body),
    );
