import { createConfig } from "./config";
import { loadEnv, validateProduction } from "./env";
import { log } from "./core/logger";
import { runMigrations } from "./db/migrate";
import { createApp } from "./app";
import { createServices } from "./services";
import { startWorker } from "./worker";

/** Single entry; ROLE=all|web|worker (§7.1). */
const env = loadEnv();
validateProduction(env);
const config = createConfig(env);
const s = createServices(config);
await runMigrations(config.databaseUrl);

let server: { stop(): unknown } | undefined;
let worker: { stop(): Promise<void> } | undefined;
if (config.role !== "worker") {
  await s.realtime.start(config.databaseUrl);
  const app = createApp(s).listen({ hostname: config.host, port: config.port });
  server = app as unknown as { stop(): unknown };
  log.info("web.started", { url: `http://${config.host}:${config.port}`, role: config.role });
}
if (config.role !== "api") {
  worker = await startWorker(s);
  log.info("worker.started", { owner: s.owner });
}

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutdown", { sig });
  await worker?.stop();
  await s.realtime.stop();
  await server?.stop();
  await s.db.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
