import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { log } from "../core/logger";

export type Db = NodePgDatabase;
/** The executor type usable for queries: either the root db or a transaction. */
export type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

interface TxContext {
  tx: Executor;
  afterCommit: Array<() => void | Promise<void>>;
  startedAt: number;
}

export interface Database {
  pool: pg.Pool;
  root: Db;
  /** Current executor: the ambient transaction if any, else the root db. */
  q(): Executor;
  /** Runs fn in a transaction; nested calls reuse the outer transaction (V3). */
  tx<T>(fn: (q: Executor) => Promise<T>): Promise<T>;
  /** Registers a side effect run only after the outermost commit (INV-15). Outside a tx it runs immediately (queued). */
  afterCommit(fn: () => void | Promise<void>): void;
  inTx(): boolean;
  close(): Promise<void>;
}

export function createDatabase(url: string, max = 10): Database {
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000 });
  // TRAP-12: without an error listener an idle client killed by the server crashes the process.
  pool.on("error", (err) => log.warn("db.pool.idle_client_error", { err: err.message }));
  const als = new AsyncLocalStorage<TxContext>();
  // A query on the pool while a transaction is open takes a SECOND connection. Under load that
  // deadlocks the pool: every connection is held by a transaction waiting for one more (found by
  // the §15.1 100-task run). Inside a transaction use the ambient executor (db.q()) instead.
  // Tests fail fast on it; elsewhere it is logged once per call site.
  const strict = process.env.NODE_ENV === "test" || process.env.DB_TX_GUARD === "throw";
  const warned = new Set<string>();
  const guard = (arg?: unknown) => {
    if (!als.getStore()) return;
    // The first frames are drizzle / pg internals: report the application's call site.
    const site =
      (new Error().stack ?? "")
        .split("\n")
        .filter((l) => /\/src\//.test(l) && !l.includes("/db/index.ts"))
        .slice(0, 3)
        .map((l) => l.trim().replace(/^at /, ""))
        .join(" <- ") || "unknown";
    if (process.env.DB_TX_GUARD_TRACE) {
      const text = typeof arg === "string" ? arg : ((arg as { text?: string } | undefined)?.text ?? "(connect)");
      console.error(`TXGUARD_SQL ${text.replace(/\s+/g, " ").slice(0, 160)}`);
    }
    if (strict) throw new Error(`second pool connection inside a transaction (use db.q()): ${site}`);
    if (!warned.has(site)) {
      warned.add(site);
      log.warn("db.second_connection_in_tx", { site: site.slice(0, 500) });
    }
  };
  const poolQuery = pool.query.bind(pool) as (...a: unknown[]) => unknown;
  const poolConnect = pool.connect.bind(pool) as (...a: unknown[]) => unknown;
  (pool as unknown as { query: unknown }).query = (...a: unknown[]) => {
    guard(a[0]);
    return poolQuery(...a);
  };
  (pool as unknown as { connect: unknown }).connect = (...a: unknown[]) => {
    guard();
    return poolConnect(...a);
  };
  const root = drizzle({ client: pool }) as unknown as Db;

  const runHooks = async (hooks: TxContext["afterCommit"]) => {
    for (const h of hooks) {
      try {
        await h();
      } catch (e) {
        log.error("db.after_commit_failed", { err: (e as Error).message });
      }
    }
  };

  return {
    pool,
    root,
    q: () => als.getStore()?.tx ?? root,
    inTx: () => als.getStore() !== undefined,
    async tx<T>(fn: (q: Executor) => Promise<T>): Promise<T> {
      const outer = als.getStore();
      if (outer) return fn(outer.tx);
      const hooks: TxContext["afterCommit"] = [];
      const startedAt = Date.now();
      const result = await root.transaction(async (tx) => als.run({ tx, afterCommit: hooks, startedAt }, () => fn(tx)));
      const dur = Date.now() - startedAt;
      if (dur > 5000) log.warn("db.long_transaction", { ms: dur });
      // Run hooks outside the ALS context so they never join a finished transaction.
      await als.exit(() => runHooks(hooks));
      return result;
    },
    afterCommit(fn) {
      const store = als.getStore();
      if (store) store.afterCommit.push(fn);
      else queueMicrotask(() => void runHooks([fn]));
    },
    async close() {
      await pool.end();
    },
  };
}
