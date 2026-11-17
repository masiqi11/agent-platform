/**
 * §15.1 retrieval p95 < 1.5 s at 100k chunks, reranking excluded (manual; NOT CI). Seeds an active
 * index of PERF_CHUNKS chunks (random 768-d vectors + text) into the first perf project, builds the
 * HNSW index, then times knowledge search (BM25 + vector routes; SAG2 off = no model judging).
 *
 *   bun test/perf/retrieval.ts      # after seed-scale.ts; PERF_CHUNKS=100000 PERF_QUERIES=60
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createConfig } from "../../src/config";
import { loadEnv } from "../../src/env";
import { createServices } from "../../src/services";

const seed = JSON.parse(readFileSync(process.env.PERF_OUT ?? "/tmp/ap-perf.json", "utf8")) as { url: string; token: string; projects: Array<{ id: string; key: string }> };
const N = Number(process.env.PERF_CHUNKS ?? 100_000);
const Q = Number(process.env.PERF_QUERIES ?? 60);
const s = createServices(createConfig(loadEnv({ ...process.env, DATABASE_URL: seed.url, LOG_LEVEL: "error" })), { owner: "perf-kb" });
const ctx = await s.identity.authenticate(new Headers({ authorization: `Bearer ${seed.token}` }), "trc_perf_kb");
await s.llm.setEmbeddingModel(ctx, "scripted:embed");
const p = seed.projects[0]!;
const ix = "pix_perf";
const t0 = Date.now();
const have = ((await s.db.root.execute(sql`select count(*)::int n from document_chunk where index_id = ${ix}`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
if (have < N) {
  await s.db.root.execute(sql`delete from document_chunk where index_id = ${ix}`);
  await s.db.root.execute(sql`delete from project_index where id = ${ix}`);
  await s.db.root.execute(sql`
    insert into project_index (id, tenant_id, project_id, version, is_active, commit, embedding_model, embedding_dim, tokenizer_version, status)
    values (${ix}, ${ctx.tenantId}, ${p.id}, 1, true, 'perf', 'scripted:embed', 768, 'perf', 'ready')`);
  const topics = sql.raw(`(array['支付 超时 网关','退款 流程 对账','签名 校验 回调','订单 状态 重试','限流 熔断 降级','发票 结算 报表','日志 追踪 告警','缓存 失效 一致性'])`);
  // Batches keep each statement's memory bounded; vectors are random and normalized by the cosine operator.
  for (let b = 0; b < N; b += 10_000) {
    await s.db.root.execute(sql`
      insert into document_chunk (id, index_id, tenant_id, project_id, source_kind, path, commit, start_line, end_line, text, tokens, embedding)
      select 'chk_perf_' || g, ${ix}, ${ctx.tenantId}, ${p.id}, 'code', 'src/mod' || (g % 500) || '/file' || g || '.ts', 'perf', 1, 40,
             'export function f' || g || '() { /* ' || ${topics}[1 + g % 8] || ' ' || md5(g::text) || ' */ }',
             to_tsvector('simple', ${topics}[1 + g % 8] || ' f' || g || ' ' || md5(g::text)),
             (select ('[' || string_agg((random() - 0.5)::text, ',') || ']')::vector from generate_series(1, 768) where g > 0)
      from generate_series(${b + 1}::int, ${Math.min(b + 10_000, N)}::int) g`);
    console.log(`chunks ${Math.min(b + 10_000, N)}/${N} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  await s.db.root.execute(sql`reindex index chunk_embedding_hnsw`);
  await s.db.root.execute(sql`analyze document_chunk`);
}
console.log(`seed + index: ${Math.round((Date.now() - t0) / 1000)} s`);
const queries = ["支付超时怎么处理", "退款对账流程", "回调签名校验", "订单状态重试", "限流熔断", "发票结算报表", "日志追踪告警", "缓存一致性"];
const lat: number[] = [];
for (let i = 0; i < Q + 5; i++) {
  const t1 = performance.now();
  const r = await s.knowledge.search(ctx, { query: queries[i % queries.length]!, projectIds: [p.id], routes: { bm25: true, vector: true, sag2: false } });
  const ms = performance.now() - t1;
  if (i >= 5) lat.push(ms); // first few warm caches
  if (i === 5) console.log(`sample: ${r.results.length} hits; routes ${JSON.stringify(Object.fromEntries(Object.entries(r.routes).map(([k, v]) => [k, v.candidates])))}`);
}
lat.sort((a, b) => a - b);
const q = (x: number) => Math.round(lat[Math.min(lat.length - 1, Math.floor(x * lat.length))]!);
const chunks = ((await s.db.root.execute(sql`select count(*)::int n from document_chunk`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
console.log(JSON.stringify({ chunks, queries: lat.length, p50Ms: q(0.5), p95Ms: q(0.95), maxMs: Math.round(lat.at(-1)!), routes: "bm25 + vector (no SAG2 / rerank)", target: "p95 < 1500 ms" }));
await s.db.close();
process.exit(0);
