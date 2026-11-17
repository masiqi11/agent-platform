/**
 * Knowledge-base eval with a real embedding model (manual; NOT part of CI). Indexes the two demo
 * repos, registers the embedding model through the admin API, and runs the 30 demo questions
 * (KB-补6) per retrieval configuration, so the vector route can be judged on its own and in the mix.
 *
 *   TEST_DATABASE_URL=… OLLAMA_URL=http://127.0.0.1:11434 EMBED_MODEL=nomic-embed-text \
 *     bun test/kb/embed-eval.ts
 *
 * Results go to docs/results/s7-embed-eval.json. `scripted:embed` (character n-gram hashing, the
 * CI stand-in) is measured in the same run as the baseline.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { DEMO_EVAL } from "../../src/cli/demo-eval";
import { BILLING_REPO, PAYMENTS_REPO } from "../../src/cli/demo-repos";
import { embedPrefix } from "../../src/modules/llm/service";

const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";
const K = 5;
type Routes = { bm25: boolean; sag2: boolean; vector: boolean };
const CONFIGS: Array<{ name: string; routes: Routes }> = [
  { name: "bm25", routes: { bm25: true, sag2: false, vector: false } },
  { name: "vector", routes: { bm25: false, sag2: false, vector: true } },
  { name: "bm25+vector", routes: { bm25: true, sag2: false, vector: true } },
  { name: "hybrid (bm25+sag2+vector)", routes: { bm25: true, sag2: true, vector: true } },
];

const { createTestApp } = await import("../helpers");
const t = await createTestApp("embedeval", { SANDBOX: "process" });
const out: Record<string, unknown> = { at: new Date().toISOString(), model: MODEL, k: K, questions: DEMO_EVAL.length, runs: [] as unknown[] };
try {
  const setup = await t.req("POST", "/api/v1/setup", { body: { tenantName: "E", email: "o@e.test", name: "评测", password: "Correct-Horse-42" } });
  const owner = setup.body.token as string;
  const ctx = await t.s.identity.authenticate(new Headers({ authorization: `Bearer ${owner}` }), "trc_embed");
  const P: Record<string, string> = {};
  for (const [key, repoName, files] of [
    ["PAY", "payments", PAYMENTS_REPO],
    ["BILL", "billing", BILLING_REPO],
  ] as const) {
    const p = await t.req("POST", "/api/v1/projects", { token: owner, body: { key, name: key } });
    await t.s.repos.bind(ctx, p.body.id, { provider: "local", name: repoName, files });
    P[repoName] = p.body.id;
  }
  const { registerHandlers } = await import("../../src/modules/registry");
  await registerHandlers(t.s);
  await t.s.consumers.init();
  await t.s.db.root.execute(sql`delete from job where cron is not null`);
  const settle = async () => {
    for (let i = 0; i < 50; i++) if (!(await t.s.consumers.drain()) && !(await t.s.jobs.drain())) break;
  };

  async function evaluate(label: string, extra: Record<string, unknown> = {}) {
    for (const c of CONFIGS) {
      const misses: unknown[] = [];
      let hits = 0;
      let top1 = 0;
      let rr = 0;
      const t0 = Date.now();
      for (const q of DEMO_EVAL) {
        // Rank over a longer list so MRR sees where the expected file lands even past K.
        const r = await t.s.knowledge.search(ctx, { query: q.question, projectIds: [P[q.repo]!], routes: c.routes, limit: 20 });
        const found = r.results.map((h) => h.path);
        const rank = found.findIndex((f) => q.expect.includes(f)) + 1;
        if (rank === 1) top1++;
        if (rank > 0) rr += 1 / rank;
        if (rank > 0 && rank <= K) hits++;
        else misses.push({ question: q.question, expect: q.expect, rank: rank || null, found: found.slice(0, K) });
      }
      const n = DEMO_EVAL.length;
      const m = { recall: Number((hits / n).toFixed(3)), recallAt1: Number((top1 / n).toFixed(3)), mrr: Number((rr / n).toFixed(3)) };
      (out.runs as unknown[]).push({ embedding: label, config: c.name, ...m, msPerQuery: Math.round((Date.now() - t0) / n), misses, ...extra });
      console.log(`${label.padEnd(22)} ${c.name.padEnd(26)} R@${K} ${m.recall.toFixed(3)}  R@1 ${m.recallAt1.toFixed(3)}  MRR ${m.mrr.toFixed(3)}`);
    }
  }

  // Baseline: the deterministic stand-in used in CI.
  const base = await t.req("PUT", "/api/v1/admin/models/embedding", { token: owner, body: { name: "scripted:embed" } });
  await settle();
  const embedded = async (m: string) =>
    (
      (await t.s.db.root.execute(
        sql`select count(*)::int n from document_chunk c join project_index i on i.id=c.index_id where i.is_active and i.embedding_model = ${m} and c.embedding is not null`,
      )) as unknown as { rows: Array<{ n: number }> }
    ).rows[0]!.n;
  const probe = await t.s.knowledge.search(ctx, { query: DEMO_EVAL[0]!.question, projectIds: [P.payments!], routes: CONFIGS[1]!.routes, limit: K });
  console.log(
    `baseline: switch ${JSON.stringify(base.body)}, ${await embedded("scripted:embed")} chunks embedded, vector route ${JSON.stringify(probe.routes.vector)}, ${probe.results.length} results`,
  );
  await evaluate("scripted:embed");

  // Real model, registered and selected through the admin API (§8.7: 768 dims).
  const prov = await t.req("POST", "/api/v1/admin/models/providers", {
    token: owner,
    body: { name: "本地 Ollama", baseUrl: OLLAMA, dialect: "ollama", isExternal: false, models: [{ name: MODEL, embeddingDim: 768 }] },
  });
  if (prov.status !== 200) throw new Error(`register provider: ${prov.status} ${JSON.stringify(prov.body)}`);
  const sw = await t.req("PUT", "/api/v1/admin/models/embedding", { token: owner, body: { name: MODEL } });
  if (sw.status !== 200 || !sw.body.rebuildQueued) throw new Error(`switch model: ${sw.status} ${JSON.stringify(sw.body)}`);
  const t0 = Date.now();
  await settle();
  const buildMs = Date.now() - t0;
  const st = (await t.req("GET", `/api/v1/projects/${P.payments}/knowledge/status`, { token: owner })).body;
  const chunks = (await t.s.db.root.execute(
    sql`select count(*)::int n from document_chunk c join project_index i on i.id=c.index_id where i.is_active and i.embedding_model = ${MODEL} and c.embedding is not null`,
  )) as unknown as { rows: Array<{ n: number }> };
  console.log(
    `rebuild with ${MODEL}: ${buildMs} ms, ${chunks.rows[0]!.n} chunks embedded; index ${JSON.stringify(st.indexes.map((i: { name: string; version: number; embeddingModel: string }) => `${i.name} v${i.version} ${i.embeddingModel}`))}`,
  );
  out.rebuild = { ms: buildMs, embeddedChunks: chunks.rows[0]!.n };
  await evaluate(MODEL, { prefix: embedPrefix(MODEL, "query") || null });
} finally {
  const file = resolve(import.meta.dir, "../../../../docs/results/s7-embed-eval.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  await t.close();
}
