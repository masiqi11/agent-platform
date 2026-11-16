/**
 * Starts a throwaway server for Playwright: recreates the e2e database, then runs the app
 * (serving apps/web/dist) on E2E_PORT. Uses TEST_DATABASE_URL's server; no secrets printed.
 */
import pg from "pg";

const base = process.env.TEST_DATABASE_URL;
if (!base) throw new Error("TEST_DATABASE_URL is required");
const name = process.env.E2E_DB ?? "agent_platform_e2e";
const admin = new pg.Client({ connectionString: base });
await admin.connect();
await admin.query(`drop database if exists ${name} with (force)`);
await admin.query(`create database ${name}`);
await admin.end();
const u = new URL(base);
u.pathname = `/${name}`;
const port = process.env.E2E_PORT ?? "3100";
const p = Bun.spawn(["bun", "src/main.ts"], {
  cwd: ".",
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: u.toString(),
    PORT: port,
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    LOG_LEVEL: "warn",
    AUTH_SIGNUP_MODE: "invite",
    ...(process.env.E2E_EXTRA ? JSON.parse(process.env.E2E_EXTRA) : {}),
  },
});
process.on("SIGTERM", () => p.kill());
process.on("SIGINT", () => p.kill());
await p.exited;
