import pg from "pg";
import type { Services } from "./services";
import { log } from "./core/logger";

/**
 * Worker loop: event consumers + job queue + cron (§7.1, §11). Modules register their
 * consumers/handlers in `registerAll`; the loop only drives them.
 */
export async function startWorker(s: Services, opts: { registerAll?: (s: Services) => void | Promise<void> } = {}) {
  const { registerHandlers } = await import("./modules/registry");
  await registerHandlers(s);
  await opts.registerAll?.(s);
  await s.consumers.init();
  let running = true;
  // Loops sleep on this so stop() wakes them at once instead of waiting out a 15 s poll.
  let wake!: () => void;
  const stopped = new Promise<void>((r) => (wake = r));
  // §15.1 wake latency: NOTIFY (ap_events / ap_jobs, sent on commit) kicks a loop out of its nap;
  // polling stays as the fallback. A kick that lands while the loop is busy is kept for the next nap.
  const kicks = new Map<string, () => void>();
  const pending = new Set<string>();
  const kick = (name: string) => {
    const k = kicks.get(name);
    if (k) k();
    else pending.add(name);
  };
  const nap = (name: string, ms: number) => {
    if (pending.delete(name)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        kicks.delete(name);
        resolve();
      };
      const timer = setTimeout(done, ms);
      kicks.set(name, done);
      void stopped.then(done);
    });
  };
  const loops: Promise<void>[] = [];
  const loop = (name: string, ms: number, fn: () => Promise<unknown>) =>
    loops.push(
      (async () => {
        while (running) {
          try {
            await fn();
          } catch (err) {
            log.warn("worker.loop_error", { loop: name, err: (err as Error).message.slice(0, 300) });
          }
          await nap(name, ms);
        }
      })(),
    );
  let listener: pg.Client | null = null;
  async function listen() {
    if (!running) return;
    const c = new pg.Client({ connectionString: s.config.databaseUrl });
    c.on("notification", (n) => kick(n.channel === "ap_jobs" ? "jobs" : "consumers"));
    c.on("error", (err) => {
      log.warn("worker.listen_error", { err: err.message.slice(0, 200) });
      if (listener === c) listener = null;
      void c.end().catch(() => undefined);
      if (running) setTimeout(() => void listen(), 5_000); // polling covers the gap
    });
    try {
      await c.connect();
      await c.query("listen ap_events");
      await c.query("listen ap_jobs");
      listener = c;
    } catch (err) {
      log.warn("worker.listen_failed", { err: (err as Error).message.slice(0, 200) });
      void c.end().catch(() => undefined);
      if (running) setTimeout(() => void listen(), 5_000);
    }
  }
  await listen();
  loop("consumers", s.config.worker.eventPollMs, () => s.consumers.tick());
  const inflight = new Set<Promise<void>>();
  loop("jobs", s.config.worker.jobPollMs, async () => {
    const free = s.config.worker.concurrency - inflight.size;
    if (free <= 0) return;
    for (const j of await s.jobs.claim(free)) {
      const p: Promise<void> = s.jobs.runJob(j).finally(() => {
        inflight.delete(p);
        kick("jobs"); // a slot freed: take the next queued job now
      });
      inflight.add(p);
    }
  });
  loop("recover", 15_000, () => s.jobs.recoverExpired());
  return {
    /**
     * Graceful stop: no new claims, running jobs get up to SHUTDOWN_GRACE_MS to finish, then
     * whatever is still running is released for another instance (handlers are idempotent, §11.4).
     */
    async stop() {
      running = false;
      wake();
      await listener?.end().catch(() => undefined);
      listener = null;
      await s.consumers.release().catch(() => {});
      const t0 = Date.now();
      await Promise.race([Promise.all([...loops, ...inflight]), Bun.sleep(s.config.worker.shutdownGraceMs)]);
      if (inflight.size) log.warn("worker.stop_grace_exceeded", { stillRunning: inflight.size, waitedMs: Date.now() - t0 });
      await s.jobs.releaseOwned().catch(() => {});
    },
  };
}
