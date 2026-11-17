import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { openapi } from "@elysia/openapi";
import { Elysia, NotFound, ParseError, ValidationError, t } from "elysia";
import { websocket } from "elysia/websocket";
import { sql } from "drizzle-orm";
import { expectedMigration } from "./db/migrate";
import { DomainError } from "./core/errors";
import { newId } from "./core/ids";
import { log } from "./core/logger";
import { traceIdOf } from "./http";
import { auditRoutes } from "./routes/audit";
import { identityRoutes } from "./routes/identity";
import { projectRoutes } from "./routes/projects";
import { chatRoutes } from "./routes/chat";
import { taskRoutes } from "./routes/tasks";
import { flowRoutes } from "./routes/flow";
import { agentRoutes } from "./routes/agents";
import { captainRoutes } from "./routes/captain";
import { codeRoutes } from "./routes/code";
import { qualityRoutes } from "./routes/quality";
import { llmProxyRoutes } from "./routes/llm-proxy";
import { knowledgeRoutes } from "./routes/knowledge";
import type { Services } from "./services";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function validationDetails(err: ValidationError): Array<{ path: string; message: string }> {
  const raw = (err as unknown as { all?: unknown[] }).all ?? [];
  const list = Array.isArray(raw) ? raw : [];
  const out = list.slice(0, 20).map((e) => {
    const x = e as { path?: string; instancePath?: string; summary?: string; message?: string };
    return { path: x.path ?? x.instancePath ?? "", message: x.summary ?? x.message ?? "invalid" };
  });
  return out.length ? out : [{ path: "", message: err.message.slice(0, 200) }];
}

/** Builds the HTTP app. Composition only: no business logic here (§5.2). */
export function createApp(s: Services) {
  const webDist = s.config.dirs.webDist;
  const cors = new Set(s.config.trustedOrigins);

  const app = new Elysia()
    .use(websocket())
    .onRequest(({ request, set }) => {
      const traceId = traceIdOf(request);
      set.headers["x-request-id"] = traceId;
      set.headers["x-content-type-options"] = "nosniff";
      set.headers["referrer-policy"] = "strict-origin-when-cross-origin";
      set.headers["x-frame-options"] = "DENY";
      set.headers["content-security-policy"] = CSP;
      const origin = request.headers.get("origin");
      if (origin && cors.has(origin)) {
        set.headers["access-control-allow-origin"] = origin;
        set.headers["access-control-allow-credentials"] = "true";
        set.headers["vary"] = "Origin";
        if (request.method === "OPTIONS") {
          set.headers["access-control-allow-methods"] = "GET,POST,PATCH,PUT,DELETE,OPTIONS";
          set.headers["access-control-allow-headers"] = "authorization,content-type,idempotency-key,if-match,x-request-id";
          return new Response(null, { status: 204, headers: set.headers as Record<string, string> });
        }
      }
    })
    .onError(({ error, request, set }) => {
      const traceId = traceIdOf(request);
      set.headers["x-request-id"] = traceId;
      if (error instanceof DomainError) {
        set.status = error.http;
        if (error.headers) Object.assign(set.headers, error.headers);
        return { error: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}), traceId };
      }
      if (error instanceof ValidationError) {
        // Response validation failures are server bugs, not client input errors.
        if ((error as unknown as { type?: string }).type === "response") {
          log.error("http.response_validation", { traceId, path: new URL(request.url).pathname, err: error.message.slice(0, 500) });
          set.status = 500;
          return { error: "internal", message: "服务器内部错误", traceId };
        }
        set.status = 400;
        return { error: "invalid", message: "入参校验失败", details: validationDetails(error), traceId };
      }
      if (error instanceof ParseError) {
        set.status = 400;
        return { error: "invalid", message: "请求体无法解析", details: [], traceId };
      }
      if (error instanceof NotFound) {
        set.status = 404;
        return { error: "not_found", message: "资源不存在", traceId };
      }
      const e = error as { status?: number; code?: string | number; message?: string };
      if (e.status === 413 || /too large/i.test(String(e.message))) {
        set.status = 413;
        return { error: "too_large", message: "请求体过大", traceId };
      }
      log.error("http.unhandled", { traceId, path: new URL(request.url).pathname, err: String(e.message ?? error).slice(0, 500) });
      set.status = 500;
      return { error: "internal", message: "服务器内部错误", traceId };
    })
    .get("/healthz", { response: t.Object({ ok: t.Boolean() }) }, () => ({ ok: true }))
    .get("/readyz", { response: t.Object({ ok: t.Boolean(), db: t.Boolean(), migration: t.String() }) }, async ({ set }) => {
      try {
        await s.db.root.execute(sql`select 1`);
        const r = (await s.db.root.execute(sql`select name as version from ap_schema_version limit 1`)) as unknown as { rows: Array<{ version: string }> };
        const current = r.rows[0]?.version ?? "none";
        const ok = current === (await expectedMigration());
        if (!ok) set.status = 503;
        return { ok, db: true, migration: current };
      } catch {
        set.status = 503;
        return { ok: false, db: false, migration: "unknown" };
      }
    })
    .all("/api/auth/*", { parse: "none" }, ({ request }) => s.auth.handler(request))
    .use(identityRoutes(s))
    .use(auditRoutes(s))
    .use(projectRoutes(s))
    .use(chatRoutes(s))
    .use(agentRoutes(s))
    .use(taskRoutes(s))
    .use(flowRoutes(s))
    .use(captainRoutes(s))
    .use(codeRoutes(s))
    .use(qualityRoutes(s))
    .use(knowledgeRoutes(s))
    .use(llmProxyRoutes(s))
    .ws("/ws", {
      maxPayloadLength: 64 * 1024,
      idleTimeout: 120,
      open(ws) {
        s.realtime.open({
          id: ws.id,
          send: (d) => ws.send(d),
          close: (code, reason) => ws.close(code, reason),
          buffered: () => (ws as unknown as { raw?: { getBufferedAmount?: () => number } }).raw?.getBufferedAmount?.() ?? 0,
          topics: new Set(),
        });
      },
      async message(ws, message) {
        const c = s.realtime.conns.get(ws.id);
        if (!c) return;
        try {
          await s.realtime.message(c, message, (token) => s.identity.authenticate(new Headers({ authorization: `Bearer ${token}` }), newId("trc")));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", code: "invalid", message: (err as Error).message.slice(0, 200) }));
        }
      },
      close(ws) {
        s.realtime.close(ws.id);
      },
    })
    .use(openapi({ path: "/api/docs", exclude: { paths: [/^\/api\/auth/, "/ws"] }, documentation: { info: { title: "Agent Platform API", version: "1" } } }))
    .get("/*", async ({ request, set }) => {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/") || path === "/ws") {
        set.status = 404;
        return { error: "not_found", message: "资源不存在", traceId: traceIdOf(request) };
      }
      if (!existsSync(webDist)) return new Response("前端未构建：请运行 bun run build 或使用 bun run dev", { headers: { "content-type": "text/plain; charset=utf-8" } });
      const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
      const file = Bun.file(join(webDist, rel));
      if (rel !== "/" && (await file.exists())) {
        const hashed = /\/assets\/.+-[A-Za-z0-9_-]{8,}\./.test(rel);
        return new Response(file, { headers: { "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache" } });
      }
      return new Response(Bun.file(join(webDist, "index.html")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    });
  return app;
}
export type App = ReturnType<typeof createApp>;
