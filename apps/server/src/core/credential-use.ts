import type { Audit } from "./audit";
import type { Ctx } from "./context";

/**
 * §14.3 / §14.7 credential use in the audit log — never the value. One entry per credential and
 * user per window: a provider key is used on every model call and an SCM token on every poll,
 * so a row per use would bury the audit log. `credential.last_used_at` stays exact; model calls
 * are additionally one `llm_call` row each, with the provider.
 */
export function createCredentialUseAudit(d: { audit: Audit; systemCtx(tenantId: string): Promise<Ctx> }, windowMs = 10 * 60_000) {
  const last = new Map<string, number>();
  return async (c: { id: string; tenantId: string; kind: string }, usedBy: string) => {
    const k = `${c.id}|${usedBy}`;
    const now = Date.now();
    if ((last.get(k) ?? 0) > now - windowMs) return;
    last.set(k, now);
    const ctx = await d.systemCtx(c.tenantId);
    await d.audit.write(ctx, { action: "credential.use", resourceType: "credential", resourceId: c.id, outcome: "allowed", after: { kind: c.kind, usedBy } });
  };
}
