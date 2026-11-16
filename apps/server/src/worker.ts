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
          await Bun.sleep(ms);
        }
      })(),
    );
  loop("consumers", s.config.worker.eventPollMs, () => s.consumers.tick());
  const inflight = new Set<Promise<void>>();
  loop("jobs", s.config.worker.jobPollMs, async () => {
    const free = s.config.worker.concurrency - inflight.size;
    if (free <= 0) return;
    for (const j of await s.jobs.claim(free)) {
      const p: Promise<void> = s.jobs.runJob(j).finally(() => inflight.delete(p));
      inflight.add(p);
    }
  });
  loop("recover", 15_000, () => s.jobs.recoverExpired());
  return {
    async stop() {
      running = false;
      await s.consumers.release().catch(() => {});
      await Promise.race([Promise.all([...loops, ...inflight]), Bun.sleep(10_000)]);
      await s.jobs.releaseOwned().catch(() => {});
    },
  };
}
