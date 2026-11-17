import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/** Insecure development defaults. Production validation rejects them (§7.2). */
export const DEV_DEFAULTS = {
  BETTER_AUTH_SECRET: "dev-insecure-better-auth-secret-change-me-0000",
  JWT_SECRET: "dev-insecure-jwt-secret-change-me-000000000000",
  MASTER_KEY: "dev-insecure-master-key-change-me-0000000000000",
} as const;

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

export const serverSchema = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ROLE: z.enum(["all", "api", "worker"]).default("all"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().default(8080),
  PUBLIC_URL: z.string().url().default("http://localhost:8080"),
  TRUSTED_ORIGINS: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().default(10),
  TEST_DATABASE_URL: z.string().optional(),
  DATA_DIR: z.string().default(".data"),
  ARTIFACTS_DIR: z.string().optional(),
  WORKSPACES_DIR: z.string().optional(),
  REPO_CACHE_DIR: z.string().optional(),
  LOCAL_SCM_DIR: z.string().optional(),
  WEB_DIST: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  BETTER_AUTH_SECRET: z.string().default(DEV_DEFAULTS.BETTER_AUTH_SECRET),
  BETTER_AUTH_URL: z.string().optional(),
  AUTH_SIGNUP_MODE: z.enum(["open", "domain", "invite", "closed"]).optional(),
  AUTH_ALLOWED_EMAIL_DOMAINS: z.string().optional(),
  AUTH_DEV_LOGIN: bool.optional(),
  OIDC_ISSUER: z.string().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  JWT_SECRET: z.string().default(DEV_DEFAULTS.JWT_SECRET),
  JWT_SECRET_PREVIOUS: z.string().optional(),
  AGENT_TOKEN_TTL_SEC: z.coerce.number().int().default(3600),
  MASTER_KEY: z.string().default(DEV_DEFAULTS.MASTER_KEY),
  MASTER_KEY_V2: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().default(25),
  SANDBOX: z.enum(["process", "docker"]).optional(),
  SANDBOX_IMAGE: z.string().optional(),
  SANDBOX_RUNTIME: z.string().optional(),
  SANDBOX_TIMEOUT_MS: z.coerce.number().int().default(600000),
  /** SBX-09: comma-separated image prefixes the docker sandbox may run (e.g. "registry.internal/,mirror.gcr.io/oven/"). */
  SANDBOX_IMAGE_ALLOW: z.string().optional(),
  /** Internal docker network whose only reachable host is the platform (external engines, ADR-0010). */
  SANDBOX_NETWORK: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
    .optional(),
  /** Platform URL as seen from that network (default: http://<network gateway>:PORT). */
  HARNESS_SANDBOX_PLATFORM_URL: z.string().url().optional(),
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_EMBEDDING_MODEL: z.string().optional(),
  /** Wire APIs the bootstrap endpoint accepts for the harness proxy, e.g. "chat,responses,messages". */
  LLM_APIS: z.string().optional(),
  /** Record every model completion (purpose, tools, reply — redacted) as JSON lines: replay fixtures (S8-7). */
  LLM_RECORD_FILE: z.string().optional(),
  /** §14.5 SSRF guard on server-side requests (model providers, SCM). Default: on in production. */
  OUTBOUND_GUARD: z.enum(["on", "off"]).optional(),
  /** Internal targets allowed through the guard: hosts, host:port or IPv4 CIDRs, comma-separated. */
  OUTBOUND_ALLOW: z.string().optional(),
  /** Bearer token for GET /metrics (Prometheus). Unset: /metrics is open outside production, off in production. */
  METRICS_TOKEN: z.string().min(16).optional(),
  /** ADR-0010: the platform as seen from inside the sandbox (model proxy + MCP); default http://127.0.0.1:PORT. */
  HARNESS_PLATFORM_URL: z.string().optional(),
  /** Executables for the harness engines (default: the command name on PATH). */
  HARNESS_CLAUDE_CODE_BIN: z.string().optional(),
  HARNESS_CODEX_BIN: z.string().optional(),
  HARNESS_OPENCODE_BIN: z.string().optional(),
  HARNESS_PI_BIN: z.string().optional(),
  /** Comma-separated non-secret env names passed into harness runs (e.g. HTTPS_PROXY,NO_PROXY,NODE_EXTRA_CA_CERTS). */
  HARNESS_PASS_ENV: z.string().optional(),
  DEMO_MODE: bool.default(false),
  /** Retention cleanup (§8.5): off unless explicitly enabled. Periods in days. */
  RETENTION_ENABLED: bool.default(false),
  RETENTION_EVENTS_DAYS: z.coerce.number().int().min(7).default(90),
  RETENTION_JOBS_OK_DAYS: z.coerce.number().int().min(1).default(7),
  RETENTION_JOBS_FAILED_DAYS: z.coerce.number().int().min(7).default(30),
  RETENTION_TRANSCRIPT_DAYS: z.coerce.number().int().min(30).default(180),
  AGENTS_PAUSED: bool.default(false),
  DINGTALK_CLIENT_ID: z.string().optional(),
  DINGTALK_CLIENT_SECRET: z.string().optional(),
  DINGTALK_ROBOT_CODE: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().default(4),
  EVENT_POLL_MS: z.coerce.number().int().default(1000),
  JOB_POLL_MS: z.coerce.number().int().default(1000),
  /** How long a stopping worker lets running jobs finish (keep below the orchestrator's kill timeout). */
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(25_000),
};

export type Env = z.infer<z.ZodObject<typeof serverSchema>>;

/** Validates process.env; on failure lists variable *names* only and exits. */
export function loadEnv(runtimeEnv: Record<string, string | undefined> = process.env): Env {
  const env = createEnv({
    server: serverSchema,
    runtimeEnv,
    emptyStringAsUndefined: true,
    onValidationError: (issues) => {
      const names = [
        ...new Set(issues.map((i) => ((p) => (typeof p === "object" && p !== null && "key" in p ? String(p.key) : typeof p === "string" || typeof p === "number" ? String(p) : "?"))(i.path?.[0]))),
      ];
      // eslint-disable-next-line no-console -- logger not yet initialised at this point
      console.error(`[config] 环境变量校验失败：${names.join(", ")}`);
      throw new Error(`invalid env: ${names.join(", ")}`);
    },
  }) as Env;
  validateProduction(env);
  return env;
}

export function validateProduction(env: Env): void {
  if (env.NODE_ENV !== "production") return;
  const bad: string[] = [];
  for (const k of ["JWT_SECRET", "MASTER_KEY", "BETTER_AUTH_SECRET"] as const) {
    if (!env[k] || env[k] === DEV_DEFAULTS[k]) bad.push(k);
  }
  if (env.AUTH_DEV_LOGIN === true) bad.push("AUTH_DEV_LOGIN");
  if (env.AUTH_SIGNUP_MODE === "open") bad.push("AUTH_SIGNUP_MODE");
  if (env.SANDBOX !== "docker") bad.push("SANDBOX");
  if (!env.PUBLIC_URL.startsWith("https://")) bad.push("PUBLIC_URL");
  const oidc = [env.OIDC_ISSUER, env.OIDC_CLIENT_ID, env.OIDC_CLIENT_SECRET].filter(Boolean).length;
  if (oidc !== 0 && oidc !== 3) bad.push("OIDC_*");
  if (bad.length > 0) {
    // eslint-disable-next-line no-console -- logger not yet initialised at this point
    console.error(`[config] 生产校验失败：${bad.join(", ")}`);
    throw new Error(`production validation failed: ${bad.join(", ")}`);
  }
}
