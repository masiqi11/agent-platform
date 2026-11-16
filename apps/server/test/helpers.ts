import pg from "pg";
import { runMigrations } from "../src/db/migrate";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://agent:agent_dev_pw@127.0.0.1:5432/agent_platform_test";

/** Creates an isolated database (one per test file) on real Postgres 16 + pgvector (§17.2). */
export async function createTestDatabase(label = "t"): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `ap_${label.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 20)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
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
