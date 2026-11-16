import { Elysia } from "elysia";
import type { Ctx } from "./core/context";
import { DomainError } from "./core/errors";
import { newId } from "./core/ids";
import type { Services } from "./services";

const traceIds = new WeakMap<Request, string>();
export function traceIdOf(request: Request): string {
  let t = traceIds.get(request);
  if (!t) {
    const incoming = request.headers.get("x-request-id");
    t = incoming && /^[A-Za-z0-9_-]{6,80}$/.test(incoming) ? incoming : newId("trc");
    traceIds.set(request, t);
  }
  return t;
}

const ctxCache = new WeakMap<Request, Promise<Ctx>>();

/**
 * Per-module base plugin: exposes `auth()` (lazy, cached per request) and `idem`/`trace` helpers.
 * Routes only authenticate, validate and call services (§5.2 rule 3).
 */
export const base = (s: Services) =>
  new Elysia().derive("plugin", ({ request }) => ({
    trace: traceIdOf(request),
    auth: (): Promise<Ctx> => {
      let p = ctxCache.get(request);
      if (!p) {
        p = s.identity.authenticate(request.headers, traceIdOf(request));
        ctxCache.set(request, p);
      }
      return p;
    },
    idemKey: request.headers.get("idempotency-key"),
    ifMatch: request.headers.get("if-match"),
  }));

/** Runs a create-style handler through the idempotency store (§10.3). */
export async function idempotent<T>(s: Services, ctx: Ctx, key: string | null, request: unknown, fn: () => Promise<T>): Promise<T> {
  const r = await s.idempotency.run(ctx.actor.principalId, key, request, async () => ({ status: 200, body: await fn() }));
  return r.body;
}

export { DomainError };
