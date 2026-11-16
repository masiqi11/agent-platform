import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

/** Expected latest migration folder name, used by /readyz to detect version mismatch. */
export async function expectedMigration(): Promise<string> {
  const dirs = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return dirs[dirs.length - 1] ?? "";
}

/** Runs all migrations under an advisory lock so concurrent runners are safe (§8.3). */
export async function runMigrations(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(727274)");
    // The vector type is referenced by generated DDL, so the extension must exist first.
    await client.query("create extension if not exists vector");
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    await client.query("create table if not exists ap_schema_version (id int primary key default 1, name text not null, applied_at timestamptz not null default now())");
    await client.query("insert into ap_schema_version (id, name) values (1, $1) on conflict (id) do update set name = excluded.name, applied_at = now()", [await expectedMigration()]);
  } finally {
    await client.query("select pg_advisory_unlock(727274)").catch(() => {});
    await client.end();
  }
}
