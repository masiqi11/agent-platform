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
  const root = drizzle({ client: pool }) as unknown as Db;
  const als = new AsyncLocalStorage<TxContext>();

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
