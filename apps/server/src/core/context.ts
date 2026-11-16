import type { AgentRole, TenantRole } from "@ap/shared";

/** The authenticated actor of a request, job or agent tool call. */
export interface Actor {
  principalId: string;
  kind: "human" | "agent" | "system";
  displayName: string;
  userId?: string;
  tenantRole?: TenantRole;
  agentId?: string;
  agentRole?: AgentRole;
  /** Agent token scopes (9.6). */
  projectScope?: string[];
  toolScope?: string[];
  sessionId?: string;
}

/** Context passed explicitly to every service call. */
export interface Ctx {
  tenantId: string;
  actor: Actor;
  traceId: string;
}

export const systemActor = (principalId: string): Actor => ({ principalId, kind: "system", displayName: "系统" });
