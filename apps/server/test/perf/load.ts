/**
 * §15.1 load test (manual; NOT CI) against the seed from seed-scale.ts. Starts the real server
 * (separate process, ROLE=api) and drives a read-heavy mix like the console's, then reports
 * p50 / p95 / p99 per endpoint. Writes PERF_REPORT (default docs/perf/load-<date>.json).
 *
 *   bun test/perf/load.ts            # PERF_CONCURRENCY=16 PERF_SECONDS=30
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const seed = JSON.parse(readFileSync(process.env.PERF_OUT ?? "/tmp/ap-perf.json", "utf8")) as {
  url: string;
  token: string;
  users: string[];
  projects: Array<{ id: string; groupId: string; key: string }>;
  counts: unknown;
};
const C = Number(process.env.PERF_CONCURRENCY ?? 16);
const SECONDS = Number(process.env.PERF_SECONDS ?? 30);
const port = 21000 + Math.floor(Math.random() * 5000);
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn(["bun", "src/main.ts"], {
  cwd: resolve(import.meta.dir, "../.."),
  env: { ...process.env, DATABASE_URL: seed.url, ROLE: "api", PORT: String(port), HOST: "127.0.0.1", LOG_LEVEL: "error", NODE_ENV: "development", DB_POOL_MAX: "20" },
  stdout: "ignore",
  stderr: "inherit",
});
for (let i = 0; i < 100; i++) {
  if (
    await fetch(`${base}/readyz`).then(
      (r) => r.ok,
      () => false,
    )
  )
    break;
  await Bun.sleep(200);
}
const H = { authorization: `Bearer ${seed.token}`, "content-type": "application/json" };
const headersFor = (i: number) => ({ authorization: `Bearer ${seed.users[i % seed.users.length] ?? seed.token}`, "content-type": "application/json" });
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const taskIds = await (async () => {
  const ids: string[] = [];
  for (const p of seed.projects.slice(0, 10))
    ids.push(...((await (await fetch(`${base}/api/v1/projects/${p.id}/tasks`, { headers: H })).json()) as Array<{ id: string }>).map((t) => t.id).slice(0, 20));
  return ids;
})();

type Op = { name: string; weight: number; run: (H: Record<string, string>) => Promise<Response> };
const ops: Op[] = [
  { name: "GET /projects", weight: 10, run: (H) => fetch(`${base}/api/v1/projects`, { headers: H }) },
  { name: "GET /projects/:id", weight: 10, run: (H) => fetch(`${base}/api/v1/projects/${pick(seed.projects).id}`, { headers: H }) },
  { name: "GET /groups/:id/messages (timeline, 50)", weight: 25, run: (H) => fetch(`${base}/api/v1/groups/${pick(seed.projects).groupId}/messages?limit=50`, { headers: H }) },
  {
    name: "GET /groups/:id/messages (scroll back)",
    weight: 8,
    run: (H) => fetch(`${base}/api/v1/groups/${pick(seed.projects).groupId}/messages?limit=50&beforeSeq=${1000 + Math.floor(Math.random() * 8000)}`, { headers: H }),
  },
  { name: "GET /projects/:id/tasks (board)", weight: 15, run: (H) => fetch(`${base}/api/v1/projects/${pick(seed.projects).id}/tasks`, { headers: H }) },
  { name: "GET /tasks/:id", weight: 15, run: (H) => fetch(`${base}/api/v1/tasks/${pick(taskIds)}`, { headers: H }) },
  {
    name: "GET /projects/:id/search",
    weight: 7,
    run: (H) => fetch(`${base}/api/v1/projects/${pick(seed.projects).id}/search?q=${encodeURIComponent(pick(["超时", "退款", "网关", "对账"]))}&limit=20`, { headers: H }),
  },
  {
    name: "POST /groups/:id/messages",
    weight: 5,
    run: (H) => fetch(`${base}/api/v1/groups/${pick(seed.projects).groupId}/messages`, { method: "POST", headers: H, body: JSON.stringify({ body: `压测消息 ${Math.random()}` }) }),
  },
  { name: "GET /me", weight: 5, run: (H) => fetch(`${base}/api/v1/me`, { headers: H }) },
];
const total = ops.reduce((n, o) => n + o.weight, 0);
const chooseOp = () => {
  let r = Math.random() * total;
  for (const o of ops) if ((r -= o.weight) < 0) return o;
  return ops[0]!;
};

const lat = new Map<string, number[]>();
const errors = new Map<string, number>();
async function client(i: number, until: number, record: boolean) {
  const h = headersFor(i);
  while (Date.now() < until) {
    const op = chooseOp();
    const t0 = performance.now();
    let ok = false;
    try {
      const r = await op.run(h);
      await r.arrayBuffer();
      ok = r.ok;
    } catch {
      ok = false;
    }
    const ms = performance.now() - t0;
    if (!record) continue;
    if (!ok) errors.set(op.name, (errors.get(op.name) ?? 0) + 1);
    else (lat.get(op.name) ?? lat.set(op.name, []).get(op.name)!).push(ms);
  }
}
// Warm-up (JIT, pool, caches), then the measured run.
await Promise.all(Array.from({ length: C }, (_, i) => client(i, Date.now() + 5_000, false)));
const started = Date.now();
await Promise.all(Array.from({ length: C }, (_, i) => client(i, started + SECONDS * 1000, true)));
const elapsed = (Date.now() - started) / 1000;
server.kill();

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10 : 0;
};
const all = [...lat.values()].flat();
const rows = [...lat.entries()].map(([name, xs]) => ({ name, n: xs.length, p50: q(xs, 50), p95: q(xs, 95), p99: q(xs, 99), errors: errors.get(name) ?? 0 }));
const report = {
  at: new Date().toISOString(),
  data: seed.counts,
  setup: { concurrency: C, users: seed.users.length, seconds: SECONDS, server: "1 process, ROLE=api, DB_POOL_MAX=20, same host as Postgres 16 and the load generator" },
  overall: { requests: all.length, rps: Math.round(all.length / elapsed), p50: q(all, 50), p95: q(all, 95), p99: q(all, 99), errors: [...errors.values()].reduce((a, b) => a + b, 0) },
  endpoints: rows,
  targets: { "API p95 < 300 ms": q(all, 95) < 300, "timeline first screen < 500 ms (p95)": (rows.find((r) => r.name.includes("timeline"))?.p95 ?? 1e9) < 500 },
};
const path = process.env.PERF_REPORT ?? resolve(import.meta.dir, `../../../../docs/perf/load-${report.at.slice(0, 10)}.json`);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(0);
