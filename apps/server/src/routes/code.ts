import { Elysia, t } from "elysia";
import { base } from "../http";
import { Ok } from "../schemas";
import type { Services } from "../services";

const P = t.Object({ id: t.String() });
const Check = t.Object({ ok: t.Boolean(), defaultBranch: t.String(), defaultBranchProtected: t.Boolean(), canPush: t.Boolean(), warnings: t.Array(t.String()), detail: t.String() });
const RepoSchema = t.Object({
  id: t.String(),
  projectId: t.String(),
  name: t.String(),
  provider: t.String(),
  url: t.String(),
  externalId: t.String(),
  defaultBranch: t.String(),
  status: t.String(),
  testCommand: t.Union([t.String(), t.Null()]),
  image: t.Union([t.String(), t.Null()]),
  tokenLast4: t.Union([t.String(), t.Null()]),
  lastCheck: t.Union([t.Object({ ok: t.Boolean(), defaultBranchProtected: t.Boolean(), canPush: t.Boolean(), warnings: t.Array(t.String()), detail: t.String(), at: t.String() }), t.Null()]),
  createdAt: t.String(),
});
const BindBody = t.Object({
  provider: t.Union([t.Literal("local"), t.Literal("gitlab")]),
  name: t.String({ minLength: 1, maxLength: 63 }),
  url: t.Optional(t.String({ maxLength: 500 })),
  externalId: t.Optional(t.String({ maxLength: 200 })),
  defaultBranch: t.Optional(t.String({ maxLength: 100 })),
  token: t.Optional(t.String({ maxLength: 500 })),
  caCert: t.Optional(t.String({ maxLength: 20_000 })),
  testCommand: t.Optional(t.String({ maxLength: 500 })),
  image: t.Optional(t.String({ maxLength: 300 })),
});
const Workspace = t.Object({
  id: t.String(),
  repoId: t.String(),
  repoName: t.String(),
  provider: t.String(),
  branch: t.String(),
  baseCommit: t.Union([t.String(), t.Null()]),
  headCommit: t.Union([t.String(), t.Null()]),
  mrRef: t.Union([t.String(), t.Null()]),
  mrUrl: t.Union([t.String(), t.Null()]),
  ci: t.Union([t.Record(t.String(), t.Unknown()), t.Null()]),
  diffStat: t.Union([t.Record(t.String(), t.Unknown()), t.Null()]),
  status: t.String(),
  updatedAt: t.String(),
});
const CodeView = t.Object({
  workspaces: t.Array(Workspace),
  artifacts: t.Array(t.Object({ id: t.String(), kind: t.String(), name: t.String(), size: t.Number(), sha256: t.String(), createdAt: t.String() })),
  cost: t.Object({
    tokens: t.Number(),
    costUsd: t.Number(),
    calls: t.Number(),
    sessions: t.Array(t.Object({ id: t.String(), agentId: t.String(), status: t.String(), stopReason: t.Union([t.String(), t.Null()]), steps: t.Number(), updatedAt: t.String() })),
  }),
  takenOverBy: t.Union([t.String(), t.Null()]),
});

/** S5 routes: repos & binding wizard, GitLab webhooks, task code view, human controls, agent load, system status. */
export const codeRoutes = (s: Services) =>
  new Elysia({ prefix: "/api/v1" })
    .use(base(s))
    .get("/projects/:id/repos", { params: P, response: t.Array(RepoSchema) }, async ({ auth, params }) => s.repos.list(await auth(), params.id))
    .post("/projects/:id/repos/preflight", { params: P, body: BindBody, response: Check }, async ({ auth, params, body }) => s.repos.preflight(await auth(), params.id, body))
    .post(
      "/projects/:id/repos",
      { params: P, body: BindBody, response: t.Object({ repo: RepoSchema, check: Check, webhook: t.Union([t.Object({ url: t.String(), secret: t.String() }), t.Null()]) }) },
      async ({ auth, params, body }) => {
        const r = await s.repos.bind(await auth(), params.id, body);
        return {
          repo: r.repo,
          check: {
            ok: r.check.ok,
            defaultBranch: r.check.defaultBranch,
            defaultBranchProtected: r.check.defaultBranchProtected,
            canPush: r.check.canPush,
            warnings: r.check.warnings,
            detail: r.check.detail,
          },
          webhook: r.webhook,
        };
      },
    )
    .post("/repos/:id/check", { params: P, response: Check }, async ({ auth, params }) => {
      const c = await s.repos.recheck(await auth(), params.id);
      return { ok: c.ok, defaultBranch: c.defaultBranch, defaultBranchProtected: c.defaultBranchProtected, canPush: c.canPush, warnings: c.warnings, detail: c.detail };
    })
    .patch(
      "/repos/:id",
      {
        params: P,
        body: t.Object({
          testCommand: t.Optional(t.String({ maxLength: 500 })),
          image: t.Optional(t.Union([t.String({ maxLength: 300 }), t.Null()])),
          token: t.Optional(t.String({ maxLength: 500 })),
        }),
        response: RepoSchema,
      },
      async ({ auth, params, body }) => s.repos.updateSettings(await auth(), params.id, body),
    )
    // Unauthenticated by design: verified by X-Gitlab-Token against the per-repo secret (§10.5).
    .post("/webhooks/gitlab/:id", { params: P }, async ({ params, request, body, set }) => {
      const r = await s.delivery.handleWebhook(params.id, request.headers, body);
      set.status = r.status;
      return r.body;
    })
    .get("/tasks/:id/code", { params: P, response: CodeView }, async ({ auth, params }) => {
      const ctx = await auth();
      const tk = await s.tasks.load(ctx, params.id);
      await s.identity.require(ctx, "project.view", { projectId: tk.projectId });
      const v = await s.workspaces.view(tk);
      return { ...v, cost: await s.devAgent.taskCost(tk.id), takenOverBy: tk.takenOverBy };
    })
    .post("/tasks/:id/takeover", { params: P, body: t.Object({ reason: t.String({ minLength: 1, maxLength: 500 }) }), response: Ok }, async ({ auth, params, body }) =>
      s.devAgent.takeover(await auth(), params.id, body.reason),
    )
    .post("/tasks/:id/handback", { params: P, response: Ok }, async ({ auth, params }) => s.devAgent.handback(await auth(), params.id))
    .post("/sessions/:id/cancel", { params: P, body: t.Object({ reason: t.Optional(t.String({ maxLength: 500 })) }), response: Ok }, async ({ auth, params, body }) =>
      s.devAgent.cancelSession(await auth(), params.id, body.reason ?? ""),
    )
    .get(
      "/projects/:id/agents/load",
      {
        params: P,
        response: t.Array(
          t.Object({
            agentId: t.String(),
            maxConcurrency: t.Number(),
            running: t.Number(),
            queued: t.Number(),
            activeTasks: t.Number(),
            recentTasks: t.Array(t.Object({ id: t.String(), ref: t.String(), title: t.String(), status: t.String() })),
          }),
        ),
      },
      async ({ auth, params }) => s.devAgent.load(await auth(), params.id),
    )
    .get(
      "/admin/system",
      {
        response: t.Object({
          db: t.Object({ ok: t.Boolean(), latencyMs: t.Number() }),
          migration: t.Object({ current: t.String(), expected: t.String() }),
          events: t.Object({
            headSeq: t.Number(),
            lag: t.Number(),
            consumers: t.Array(t.Object({ name: t.String(), offset: t.Number(), lag: t.Number(), lastError: t.Union([t.String(), t.Null()]) })),
          }),
          jobs: t.Object({ queued: t.Number(), running: t.Number(), dead: t.Number() }),
          deadLetters: t.Number(),
          sandbox: t.Object({ kind: t.String(), ok: t.Boolean(), detail: t.String(), warning: t.Union([t.String(), t.Null()]) }),
          providers: t.Array(t.Object({ name: t.String(), kind: t.String(), status: t.String(), circuit: t.String() })),
          disk: t.Union([t.Object({ totalBytes: t.Number(), freeBytes: t.Number(), usedRatio: t.Number() }), t.Null()]),
          checkedAt: t.String(),
        }),
      },
      async ({ auth }) => s.system.status(await auth()),
    );
