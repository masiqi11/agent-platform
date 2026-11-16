/**
 * KB-补6 评测（`bun run kb:eval`）：对每个有评测集的项目，先同步建索引，再算 recall@5。
 * 检索、分块或提示词改动后运行，结果与基线（docs/results/s7-eval.json）对比。
 *
 *   DATABASE_URL=... SEED_PASSWORD=... bun run kb:eval [--owner owner@xinghe.test]
 */
import { eq } from "drizzle-orm";
import { createConfig } from "../config";
import { evalQuestion, project } from "../db/schema";
import { loadEnv } from "../env";
import { createServices } from "../services";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const PASSWORD = process.env.SEED_PASSWORD;
if (!PASSWORD) throw new Error("SEED_PASSWORD is required (evaluates as the demo owner)");
const s = createServices(createConfig(loadEnv({ ...process.env, LOG_LEVEL: "error" })), { owner: "kb-eval" });

async function main() {
  const token = await s.identity.signIn(arg("owner") ?? "owner@xinghe.test", PASSWORD!);
  const ctx = await s.identity.authenticate(new Headers({ authorization: `Bearer ${token}` }), "trc_kbeval");
  const ids = [...new Set((await s.db.root.select({ p: evalQuestion.projectId }).from(evalQuestion)).map((x) => x.p))];
  let hits = 0;
  let total = 0;
  for (const id of ids) {
    const [p] = await s.db.root.select().from(project).where(eq(project.id, id));
    for (const r of await s.repos.projectRepos(id)) await s.knowledge.indexRepo({ projectId: id, repoId: r.id });
    await s.knowledge.indexWarm(id);
    const e = await s.knowledge.evaluate(ctx, id);
    hits += e.results.filter((x) => x.hit).length;
    total += e.total;
    console.log(`${p?.key}: recall@${e.k} = ${e.recall}（${e.total} 题）`);
    for (const m of e.results.filter((x) => !x.hit)) console.log(`  未命中：${m.question} → 期望 ${m.expected.join("、")}，实得 ${m.found.join("、") || "无"}`);
  }
  console.log(`合计 recall@5 = ${total ? (hits / total).toFixed(3) : "n/a"}（${total} 题）`);
}

await main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await s.realtime.stop().catch(() => undefined);
    await s.db.close();
  });
