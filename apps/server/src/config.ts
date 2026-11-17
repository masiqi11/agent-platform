import { join, resolve } from "node:path";
import type { Env } from "./env";

export interface Config {
  nodeEnv: Env["NODE_ENV"];
  /** Bearer token for GET /metrics. */
  metricsToken?: string;
  /** §8.5 retention (cleanup job off unless enabled). */
  retention: { enabled: boolean; eventsDays: number; jobsOkDays: number; jobsFailedDays: number; transcriptDays: number };
  isProd: boolean;
  role: Env["ROLE"];
  host: string;
  port: number;
  publicUrl: string;
  trustedOrigins: string[];
  databaseUrl: string;
  dbPoolMax: number;
  dirs: { data: string; artifacts: string; workspaces: string; repoCache: string; localScm: string; webDist: string };
  logLevel: Env["LOG_LEVEL"];
  auth: {
    secret: string;
    url: string;
    signupMode: "open" | "domain" | "invite" | "closed";
    allowedDomains: string[];
    devLogin: boolean;
    oidc: { issuer: string; clientId: string; clientSecret: string } | null;
  };
  jwt: { secret: string; previous?: string; ttlSec: number };
  masterKeys: Record<number, string>;
  currentKeyVersion: number;
  s3: { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string } | null;
  maxUploadMb: number;
  sandbox: { kind: "process" | "docker"; image?: string; runtime?: string; timeoutMs: number; network?: string; platformUrl?: string; platformPort: number; imageAllow?: string[] };
  /** External harness engines (ADR-0010). */
  harness: { platformUrl: string; bins: Partial<Record<"claude-code" | "codex" | "opencode" | "pi", string>>; passEnv: Record<string, string>; cacheDir: string };
  llmBootstrap: { baseUrl: string; apiKey?: string; model: string; embeddingModel?: string; apis?: Array<"chat" | "responses" | "messages"> } | null;
  demoMode: boolean;
  agentsPaused: boolean;
  dingtalk: { clientId: string; clientSecret: string; robotCode?: string } | null;
  worker: { concurrency: number; eventPollMs: number; jobPollMs: number };
}

/** Pure: derives paths/defaults from validated env (§7.1). */
export function createConfig(env: Env, cwd = process.cwd()): Config {
  const isProd = env.NODE_ENV === "production";
  const data = resolve(cwd, env.DATA_DIR);
  const sub = (v: string | undefined, name: string) => (v ? resolve(cwd, v) : resolve(data, name));
  const masterKeys: Record<number, string> = { 1: env.MASTER_KEY };
  if (env.MASTER_KEY_V2) masterKeys[2] = env.MASTER_KEY_V2;
  return {
    nodeEnv: env.NODE_ENV,
    isProd,
    metricsToken: env.METRICS_TOKEN,
    retention: {
      enabled: env.RETENTION_ENABLED,
      eventsDays: env.RETENTION_EVENTS_DAYS,
      jobsOkDays: env.RETENTION_JOBS_OK_DAYS,
      jobsFailedDays: env.RETENTION_JOBS_FAILED_DAYS,
      transcriptDays: env.RETENTION_TRANSCRIPT_DAYS,
    },
    role: env.ROLE,
    host: env.HOST,
    port: env.PORT,
    publicUrl: env.PUBLIC_URL,
    trustedOrigins: (env.TRUSTED_ORIGINS ?? env.PUBLIC_URL)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    databaseUrl: env.DATABASE_URL,
    dbPoolMax: env.DB_POOL_MAX,
    dirs: {
      data,
      artifacts: sub(env.ARTIFACTS_DIR, "artifacts"),
      workspaces: sub(env.WORKSPACES_DIR, "workspaces"),
      repoCache: sub(env.REPO_CACHE_DIR, "repo-cache"),
      localScm: sub(env.LOCAL_SCM_DIR, "local-scm"),
      webDist: env.WEB_DIST ? resolve(cwd, env.WEB_DIST) : resolve(import.meta.dir, "../../web/dist"),
    },
    logLevel: env.LOG_LEVEL,
    auth: {
      secret: env.BETTER_AUTH_SECRET,
      url: env.BETTER_AUTH_URL ?? env.PUBLIC_URL,
      signupMode: env.AUTH_SIGNUP_MODE ?? (isProd ? "invite" : "open"),
      allowedDomains: (env.AUTH_ALLOWED_EMAIL_DOMAINS ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      devLogin: isProd ? false : (env.AUTH_DEV_LOGIN ?? true),
      oidc: env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET ? { issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET } : null,
    },
    jwt: { secret: env.JWT_SECRET, previous: env.JWT_SECRET_PREVIOUS, ttlSec: env.AGENT_TOKEN_TTL_SEC },
    masterKeys,
    currentKeyVersion: env.MASTER_KEY_V2 ? 2 : 1,
    s3:
      env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY && env.S3_SECRET_KEY
        ? { endpoint: env.S3_ENDPOINT, region: env.S3_REGION ?? "us-east-1", bucket: env.S3_BUCKET, accessKey: env.S3_ACCESS_KEY, secretKey: env.S3_SECRET_KEY }
        : null,
    maxUploadMb: env.MAX_UPLOAD_MB,
    sandbox: {
      kind: env.SANDBOX ?? (isProd ? "docker" : "process"),
      image: env.SANDBOX_IMAGE,
      runtime: env.SANDBOX_RUNTIME,
      timeoutMs: env.SANDBOX_TIMEOUT_MS,
      network: env.SANDBOX_NETWORK,
      platformUrl: env.HARNESS_SANDBOX_PLATFORM_URL,
      platformPort: env.PORT,
      imageAllow: env.SANDBOX_IMAGE_ALLOW?.split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    },
    harness: {
      platformUrl: env.HARNESS_PLATFORM_URL ?? `http://127.0.0.1:${env.PORT}`,
      bins: Object.fromEntries(
        (
          [
            ["claude-code", env.HARNESS_CLAUDE_CODE_BIN],
            ["codex", env.HARNESS_CODEX_BIN],
            ["opencode", env.HARNESS_OPENCODE_BIN],
            ["pi", env.HARNESS_PI_BIN],
          ] as const
        ).filter(([, v]) => Boolean(v)),
      ) as Partial<Record<"claude-code" | "codex" | "opencode" | "pi", string>>,
      passEnv: Object.fromEntries(
        (env.HARNESS_PASS_ENV ?? "")
          .split(",")
          .map((k) => k.trim())
          .filter((k) => k && process.env[k] !== undefined)
          .map((k) => [k, process.env[k]!]),
      ),
      cacheDir: join(data, "harness-cache"),
    },
    llmBootstrap:
      env.LLM_BASE_URL && env.LLM_MODEL
        ? {
            baseUrl: env.LLM_BASE_URL,
            apiKey: env.LLM_API_KEY,
            model: env.LLM_MODEL,
            embeddingModel: env.LLM_EMBEDDING_MODEL,
            apis: env.LLM_APIS
              ? (env.LLM_APIS.split(",")
                  .map((x) => x.trim())
                  .filter((x) => x === "chat" || x === "responses" || x === "messages") as Array<"chat" | "responses" | "messages">)
              : undefined,
          }
        : null,
    demoMode: env.DEMO_MODE,
    agentsPaused: env.AGENTS_PAUSED,
    dingtalk: env.DINGTALK_CLIENT_ID && env.DINGTALK_CLIENT_SECRET ? { clientId: env.DINGTALK_CLIENT_ID, clientSecret: env.DINGTALK_CLIENT_SECRET, robotCode: env.DINGTALK_ROBOT_CODE } : null,
    worker: { concurrency: env.WORKER_CONCURRENCY, eventPollMs: env.EVENT_POLL_MS, jobPollMs: env.JOB_POLL_MS },
  };
}
