/** `bun run audit:verify`: verifies every tenant's audit hash chain; exit 1 on any break. */
import { createConfig } from "../config";
import { createDatabase } from "../db";
import { createAudit } from "../core/audit";
import { tenant } from "../db/schema";
import { loadEnv } from "../env";

const config = createConfig(loadEnv());
const db = createDatabase(config.databaseUrl, 2);
const audit = createAudit(db);
let bad = 0;
for (const t of await db.root.select().from(tenant)) {
  const r = await audit.verify(t.id);
  console.log(`${t.name} (${t.id}): ${r.ok ? "OK" : `BROKEN at seq ${r.brokenAt}`} — ${r.count} records${r.head ? `, head ${r.head.slice(0, 16)}` : ""}`);
  if (!r.ok) bad++;
}
await db.close();
process.exit(bad ? 1 : 0);
