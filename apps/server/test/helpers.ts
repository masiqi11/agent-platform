import pg from "pg";
import { runMigrations } from "../src/db/migrate";

const BASE = process.env.TEST_DATABASE_URL ?? "";
if (!BASE) throw new Error("TEST_DATABASE_URL is required (see apps/server/.env.example)");

/** Creates an isolated database (one per test file) on real Postgres 16 + pgvector (§17.2). */
export async function createTestDatabase(label = "t"): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `ap_${label
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 20)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const admin = new pg.Client({ connectionString: BASE });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const u = new URL(BASE);
  u.pathname = `/${name}`;
  const url = u.toString();
  await runMigrations(url);
  return {
    url,
    drop: async () => {
      const a = new pg.Client({ connectionString: BASE });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

import { createApp } from "../src/app";
import { createConfig } from "../src/config";
import { loadEnv } from "../src/env";
import { createServices, type Services } from "../src/services";

export interface TestApp {
  s: Services;
  app: ReturnType<typeof createApp>;
  url: string;
  req<T = any>(method: string, path: string, opts?: { body?: unknown; token?: string; headers?: Record<string, string> }): Promise<{ status: number; body: T; headers: Headers }>;
  close(): Promise<void>;
}

/** Full app over an isolated database, driven through `app.handle` (no network). */
export async function createTestApp(label: string, env: Record<string, string> = {}, svc: Omit<import("../src/services").ServiceOptions, "owner"> = {}): Promise<TestApp> {
  const db = await createTestDatabase(label);
  const config = createConfig(loadEnv({ ...process.env, NODE_ENV: "test", DATABASE_URL: db.url, LOG_LEVEL: "error", PUBLIC_URL: "http://localhost:3000", ...env }));
  const s = createServices(config, { owner: `test-${label}`, ...svc });
  const app = createApp(s);
  return {
    s,
    app,
    url: db.url,
    async req(method, path, opts = {}) {
      const headers: Record<string, string> = { ...opts.headers };
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      const res = await app.handle(new Request(`http://localhost${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }));
      const text = await res.text();
      let body: any = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* text */
      }
      return { status: res.status, body, headers: res.headers };
    },
    async close() {
      await s.realtime.stop();
      await s.db.close();
      await db.drop();
    },
  };
}
