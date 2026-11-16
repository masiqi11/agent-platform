import { createHmac } from "node:crypto";
import { safeEqual } from "./crypto";
import { randomToken } from "./ids";

/** Agent scoped token payload (§9.6). Self-signed HS256 JWT; only for agents, never for users. */
export interface AgentTokenPayload {
  tenant_id: string;
  agent_id: string;
  session_id?: string;
  project_scope: string[];
  tool_scope: string[];
  token_version: number;
  exp: number;
  iat: number;
  jti: string;
  typ: "agent";
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("base64url");

export function signAgentToken(secret: string, p: Omit<AgentTokenPayload, "iat" | "jti" | "typ" | "exp">, ttlSec: number, now = Date.now()): string {
  const payload: AgentTokenPayload = { ...p, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttlSec, jti: randomToken(12), typ: "agent" };
  const head = b64({ alg: "HS256", typ: "JWT", kid: "agent" });
  const body = b64(payload);
  return `${head}.${body}.${sign(secret, `${head}.${body}`)}`;
}

export const looksLikeAgentToken = (t: string) => t.split(".").length === 3 && t.startsWith("eyJ");

/** Verifies signature against current and previous secret (rotation window) and expiry. */
export function verifyAgentToken(token: string, secrets: Array<string | undefined>, now = Date.now()): AgentTokenPayload | null {
  const [h, b, s] = token.split(".");
  if (!h || !b || !s) return null;
  const ok = secrets.filter(Boolean).some((sec) => safeEqual(sign(sec!, `${h}.${b}`), s));
  if (!ok) return null;
  try {
    const p = JSON.parse(Buffer.from(b, "base64url").toString()) as AgentTokenPayload;
    if (p.typ !== "agent" || typeof p.exp !== "number" || p.exp * 1000 < now) return null;
    return p;
  } catch {
    return null;
  }
}
