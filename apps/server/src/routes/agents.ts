import { Elysia, t } from "elysia";
import { base } from "../http";
import { Ok } from "../schemas";
import type { Services } from "../services";

const Role = t.Union([t.Literal("sub_captain"), t.Literal("dev"), t.Literal("reviewer"), t.Literal("tester"), t.Literal("captain")]);
export const AgentSchema = t.Object({
  id: t.String(),
  projectId: t.Union([t.String(), t.Null()]),
  principalId: t.String(),
  name: t.String(),
  role: t.String(),
  instructions: t.String(),
  modelPolicy: t.Record(t.String(), t.Unknown()),
  engine: t.String(),
  toolAllowlist: t.Array(t.String()),
  budget: t.Record(t.String(), t.Unknown()),
  maxConcurrency: t.Number(),
  status: t.String(),
  configVersion: t.Number(),
  createdAt: t.String(),
});
const ModelPolicy = t.Object({
  primary: t.Optional(t.String()),
  fallback: t.Optional(t.String()),
  temperature: t.Optional(t.Number({ minimum: 0, maximum: 2 })),
  maxTokens: t.Optional(t.Integer({ minimum: 1 })),
  /** Reasoning effort, mapped onto each engine's own setting (ADR-0010). */
  reasoning: t.Optional(t.Union([t.Literal("low"), t.Literal("high"), t.Literal("max")])),
});
const Engine = t.Union([t.Literal("builtin"), t.Literal("claude-code"), t.Literal("codex"), t.Literal("opencode"), t.Literal("pi")]);
const Budget = t.Object({
  maxSteps: t.Optional(t.Integer({ minimum: 1 })),
  maxTokens: t.Optional(t.Integer({ minimum: 1 })),
  maxCostUsd: t.Optional(t.Number({ minimum: 0 })),
  wallClockMs: t.Optional(t.Integer({ minimum: 1000 })),
});
const Editable = {
  name: t.String({ minLength: 1, maxLength: 60 }),
  instructions: t.Optional(t.String({ maxLength: 20_000 })),
  modelPolicy: t.Optional(ModelPolicy),
  engine: t.Optional(Engine),
  toolAllowlist: t.Optional(t.Array(t.String())),
  budget: t.Optional(Budget),
  maxConcurrency: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
};

export const agentRoutes = (s: Services) =>
  new Elysia({ prefix: "/api/v1" })
    .use(base(s))
    .get("/projects/:id/agents", { params: t.Object({ id: t.String() }), response: t.Array(AgentSchema) }, async ({ auth, params }) => s.agents.list(await auth(), params.id))
    .post("/projects/:id/agents", { params: t.Object({ id: t.String() }), body: t.Object({ ...Editable, role: Role }), response: AgentSchema }, async ({ auth, params, body }) =>
      s.agents.create(await auth(), params.id, body),
    )
    .get("/agents/:id", { params: t.Object({ id: t.String() }), response: AgentSchema }, async ({ auth, params }) => s.agents.get(await auth(), params.id))
    .patch("/agents/:id", { params: t.Object({ id: t.String() }), body: t.Partial(t.Object(Editable)), response: AgentSchema }, async ({ auth, params, body }) =>
      s.agents.update(await auth(), params.id, body),
    )
    .post(
      "/agents/:id/status",
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({ status: t.Union([t.Literal("active"), t.Literal("paused"), t.Literal("disabled")]), reason: t.Optional(t.String({ maxLength: 500 })) }),
        response: Ok,
      },
      async ({ auth, params, body }) => s.agents.setStatus(await auth(), params.id, body.status, body.reason),
    );
