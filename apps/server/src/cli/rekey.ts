/**
 * `bun run rekey`: re-encrypts every credential with the current master key (ADM-补1, §14.3).
 *
 * Rotation: put the new key in MASTER_KEY_V2 (keep MASTER_KEY), restart, run this, confirm
 * `remaining: 0`. Until then both keys must stay available. Safe to re-run; exits 1 on failures.
 */
import { createConfig } from "../config";
import { loadEnv } from "../env";
import { createServices } from "../services";

const config = createConfig(loadEnv());
const s = createServices(config, { owner: "cli-rekey" });
const r = await s.system.rekeyCredentials();
console.log(JSON.stringify(r, null, 2));
await s.db.close();
process.exit(r.failed.length || r.remaining ? 1 : 0);
