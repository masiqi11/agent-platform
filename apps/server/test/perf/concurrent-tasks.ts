/**
 * §15.1 "单租户 ≥ 100 个并发任务" (manual; NOT CI): PERF_TASKS tasks assigned at once to dev agents
 * (scripted model, local Git + local CI running `bun test` in the process sandbox), driven by the
 * real worker loop. Pass = every task reaches 评审中, no dead jobs or dead letters, no session left
 * running, event consumers caught up.
 *
 *   TEST_DATABASE_URL=… bun test/perf/concurrent-tasks.ts       # PERF_TASKS=100
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { PAYMENTS_REPO } from "../../src/cli/demo-repos";
import { startWorker } from "../../src/worker";

const N = Number(process.env.PERF_TASKS ?? 100);
// Written synchronously: buffered stdout to a file can be cut off by process.exit.
const LOG = process.env.PERF_LOG ?? "/tmp/ap-perf-concurrent.log";
const say = (s: string) => {
  appendFileSync(LOG, `${s}\n`);
  console.log(s);
};
const AGENTS = 5;
const dataDir = mkdtempSync(join(tmpdir(), "ap-perf-conc-"));
const { createTestApp } = await import("../helpers");
const t = await createTestApp("perfconc", { DATA_DIR: dataDir, SANDBOX: "process", WORKER_CONCURRENCY: "24", SANDBOX_TIMEOUT_MS: "120000" });
const owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "并发", email: "o@c.test", name: "王负责人", password: "Perf-Password-42" } })).body.token as string;
const ctx = await t.s.identity.authenticate(new Headers({ authorization: `Bearer ${owner}` }), "trc_conc");
const p = (await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "CC", name: "并发" } })).body;
const agents: string[] = [];
for (let i = 0; i < AGENTS; i++) agents.push((await t.req("POST", `/api/v1/projects/${p.id}/agents`, { token: owner, body: { name: `开发 ${i}`, role: "dev", maxConcurrency: 20 } })).body.id);
await t.s.repos.bind(ctx, p.id, { provider: "local", name: "payments", files: PAYMENTS_REPO, testCommand: "bun test" });
const t0 = Date.now();
const ids: string[] = [];
for (let i = 0; i < N; i++) {
  const r = await t.req("POST", "/api/v1/tasks", {
    token: owner,
    body: { projectId: p.id, title: `排查支付超时 #${i}`, description: "下单接口偶发超时。", acceptanceCriteria: ["调用网关的超时小于上游网关超时"], assigneeAgentId: agents[i % AGENTS] },
  });
  ids.push(r.body.id);
}
await Promise.all(ids.map((id) => t.req("POST", `/api/v1/tasks/${id}/transition`, { token: owner, body: { to: "ready" } })));
say(`${N} tasks ready in ${Date.now() - t0} ms; worker running…`);
const w = await startWorker(t.s);
const q = async <T>(s: ReturnType<typeof sql>) => ((await t.s.db.root.execute(s)) as unknown as { rows: T[] }).rows;
let last = "";
const deadline = Date.now() + 20 * 60_000;
while (Date.now() < deadline) {
  const st = await q<{ status: string; n: number }>(sql`select status, count(*)::int n from task group by status order by status`);
  const line = st.map((x) => `${x.status}=${x.n}`).join(" ");
  if (line !== last) say(`${Math.round((Date.now() - t0) / 1000)} s  ${line}`);
  last = line;
  if ((st.find((x) => x.status === "in_review")?.n ?? 0) + (st.find((x) => x.status === "blocked")?.n ?? 0) >= N) break;
  await Bun.sleep(2000);
}
const seconds = Math.round((Date.now() - t0) / 1000);
await Bun.sleep(3000);
await w.stop();
const status = await q<{ status: string; n: number }>(sql`select status, count(*)::int n from task group by status`);
const dead = await q<{ n: number }>(sql`select count(*)::int n from job where status = 'dead'`);
const dl = await q<{ n: number }>(sql`select count(*)::int n from dead_letter`);
const running = await q<{ n: number }>(sql`select count(*)::int n from session where status = 'running'`);
const lag = await q<{ lag: number }>(sql`select (select max(seq) from event) - min(offset_seq) as lag from event_consumer`);
const mrs = await q<{ n: number }>(sql`select count(*)::int n from workspace where mr_ref is not null`);
const ci = await q<{ status: string; n: number }>(sql`select ci->>'status' status, count(*)::int n from workspace group by 1`);
const result = { tasks: N, agents: AGENTS, seconds, status, mrs: mrs[0]!.n, ci, deadJobs: dead[0]!.n, deadLetters: dl[0]!.n, sessionsStillRunning: running[0]!.n, consumerLag: Number(lag[0]!.lag) };
say(JSON.stringify(result));
await t.close();
rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
