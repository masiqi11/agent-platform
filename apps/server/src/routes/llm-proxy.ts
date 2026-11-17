import { Elysia, t } from "elysia";
import { DomainError } from "../core/errors";
import { traceIdOf } from "../http";
import type { HarnessApi } from "../modules/llm/service";
import type { Services } from "../services";

const Body = t.Record(t.String(), t.Unknown());

/**
 * Model proxy for external harnesses (ADR-0010). Only agent session tokens are accepted — as
 * `Authorization: Bearer` (OpenAI-style clients) or `x-api-key` (Anthropic-style clients).
 */
export const llmProxyRoutes = (s: Services) => {
  async function handle(request: Request, body: Record<string, unknown>, api: HarnessApi) {
    const raw = request.headers.get("authorization")?.replace(/^bearer\s+/i, "") || request.headers.get("x-api-key") || "";
    let ctx;
    try {
      ctx = await s.identity.authenticate(new Headers({ authorization: `Bearer ${raw}` }), traceIdOf(request));
    } catch (e) {
      return Response.json({ error: { type: "platform_proxy_error", message: e instanceof DomainError ? e.message : "未认证" } }, { status: 401 });
    }
    return s.llm.proxyForAgent(ctx, api, body, request.headers);
  }
  return new Elysia({ prefix: "/llm/v1" })
    .post("/chat/completions", { body: Body }, ({ request, body }) => handle(request, body, "chat"))
    .post("/responses", { body: Body }, ({ request, body }) => handle(request, body, "responses"))
    .post("/messages", { body: Body }, ({ request, body }) => handle(request, body, "messages"));
};
