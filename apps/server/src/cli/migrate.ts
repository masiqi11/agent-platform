import { runMigrations } from "../db/migrate";
import { loadEnv } from "../env";
import { log } from "../core/logger";

const env = loadEnv();
await runMigrations(env.DATABASE_URL);
log.info("migrate.done");
