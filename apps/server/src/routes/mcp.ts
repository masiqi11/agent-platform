import { Elysia, t } from "elysia";
import { DomainError } from "../core/errors";
import { traceIdOf } from "../http";
import type { Services } from "../services";

/**
 * Platform tools for external harnesses over MCP streamable HTTP (ADR-0010), JSON responses only.
 * Only the session token of an agent whose harness is running is accepted; the role's tool set and
 * every permission check are enforced server-side, whatever the harness's own config says.
 */
export const mcpRoutes = (s: Services) =>
  new Elysia()
    .post("/mcp", { body: t.Unknown() }, async ({ request, body }) => {
      let ctx;
      try {
        ctx = await s.identity.authenticate(request.headers, traceIdOf(request));
      } catch (e) {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: e instanceof DomainError ? e.message : "未认证" } }, { status: 401 });
      }
      const out = await s.harness.mcp(ctx, body);
      return out ? Response.json(out) : new Response(null, { status: 202 });
    })
    // No server-initiated stream: clients that probe GET for SSE fall back to POST only.
    .get("/mcp", () => new Response(null, { status: 405, headers: { allow: "POST" } }));
