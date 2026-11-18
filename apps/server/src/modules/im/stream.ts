import pg from "pg";
import { log } from "../../core/logger";

export interface StreamStatus {
  holder: boolean;
  connected: boolean;
  since: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  reconnects: number;
}

/**
 * Holds an IM Stream connection on exactly one instance (§12.3 "单实例持有"). The lease is a
 * Postgres session advisory lock on a dedicated connection: it is released by the database the
 * moment the holder's connection dies, so a crashed holder is replaced within one retry period,
 * and two instances can never both hold it.
 */
export function createStreamHolder(o: {
  databaseUrl: string;
  name: string;
  /** One connection session; resolves when it ends (the holder reconnects with backoff). */
  run: (signal: AbortSignal, onState: (s: { connected: boolean; error?: string }) => void) => Promise<void>;
  retryMs?: number;
}) {
  const retryMs = o.retryMs ?? 15_000;
  const st: StreamStatus = { holder: false, connected: false, since: null, lastEventAt: null, lastError: null, reconnects: 0 };
  let stopped = false;
  let client: pg.Client | null = null;
  let session: AbortController | null = null;
  let wake: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      wake = () => {
        clearTimeout(t);
        r();
      };
    });

  async function acquire(): Promise<boolean> {
    const c = new pg.Client({ connectionString: o.databaseUrl });
    c.on("error", (e) => {
      // Connection lost → lock lost: stop streaming at once; the loop tries to re-acquire.
      log.warn("im.stream.lease_lost", { name: o.name, err: e.message.slice(0, 200) });
      st.holder = false;
      session?.abort();
      if (client === c) client = null;
    });
    try {
      await c.connect();
      const r = await c.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext($1)) as ok", [`ap:im-stream:${o.name}`]);
      if (r.rows[0]?.ok) {
        client = c;
        return true;
      }
    } catch (e) {
      st.lastError = (e as Error).message.slice(0, 200);
    }
    await c.end().catch(() => undefined);
    return false;
  }

  async function loop() {
    let backoff = 1_000;
    while (!stopped) {
      if (!client) {
        st.holder = false;
        if (!(await acquire())) {
          await sleep(retryMs);
          continue;
        }
        st.holder = true;
        log.info("im.stream.lease_acquired", { name: o.name });
      }
      session = new AbortController();
      const started = Date.now();
      try {
        await o.run(session.signal, (s) => {
          st.connected = s.connected;
          if (s.connected) {
            st.since = new Date().toISOString();
            st.lastError = null;
            backoff = 1_000;
          }
          if (s.error) st.lastError = s.error;
        });
      } catch (e) {
        st.lastError = (e as Error).message.slice(0, 200);
        log.warn("im.stream.session_failed", { name: o.name, err: st.lastError });
      }
      st.connected = false;
      if (stopped) break;
      st.reconnects++;
      if (Date.now() - started > 60_000) backoff = 1_000;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }

  let running: Promise<void> | null = null;
  return {
    start() {
      running ??= loop();
    },
    async stop() {
      stopped = true;
      session?.abort();
      wake?.();
      const c = client;
      client = null;
      await c?.end().catch(() => undefined);
      await running?.catch(() => undefined);
      st.holder = false;
    },
    touch() {
      st.lastEventAt = new Date().toISOString();
    },
    status: (): StreamStatus => ({ ...st }),
  };
}
export type StreamHolder = ReturnType<typeof createStreamHolder>;
