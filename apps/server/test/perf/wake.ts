/**
 * §15.1 wake latency (manual; NOT CI): a message that @-mentions the captain → the captain's turn
 * starts (its context turn is recorded, before any model call). Real worker loop, default polling.
 *
 *   TEST_DATABASE_URL=… bun test/perf/wake.ts        # PERF_WAKES=20
 */
import { and, eq, gt } from "drizzle-orm";
import { session, sessionTurn } from "../../src/db/schema";
import { startWorker } from "../../src/worker";

const N = Number(process.env.PERF_WAKES ?? 20);
const { createTestApp } = await import("../helpers");
const t = await createTestApp("wake");
const owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "W", email: "o@w.test", name: "O", password: "Perf-Password-42" } })).body.token as string;
const p = (await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "WK", name: "唤醒" } })).body;
const cap = ((await t.req("GET", `/api/v1/projects/${p.id}/agents`, { token: owner })).body as Array<{ id: string; principalId: string; role: string }>).find((a) => a.role === "sub_captain")!;
const w = await startWorker(t.s);
const samples: number[] = [];
for (let i = 0; i < N; i++) {
  const since = new Date();
  const m = await t.req("POST", `/api/v1/groups/${p.mainGroupId}/messages`, { token: owner, body: { body: `@[${cap.principalId}] 第 ${i} 次：支付服务超时了吗` } });
  const sent = new Date(m.body.message.createdAt).getTime();
  let at = 0;
  for (let k = 0; k < 200 && !at; k++) {
    const rows = await t.s.db.root
      .select({ at: sessionTurn.createdAt })
      .from(sessionTurn)
      .innerJoin(session, eq(session.id, sessionTurn.sessionId))
      .where(and(eq(session.agentId, cap.id), eq(sessionTurn.role, "context"), gt(sessionTurn.createdAt, since)));
    if (rows.length) at = rows[0]!.at.getTime();
    else await Bun.sleep(20);
  }
  samples.push(at ? at - sent : Number.NaN);
  await Bun.sleep(300 + Math.random() * 700); // spread the sends over the poll phase
  // Let the turn finish before the next mention (one turn at a time per group).
  for (let k = 0; k < 100; k++) {
    const [s] = await t.s.db.root.select({ status: session.status }).from(session).where(eq(session.agentId, cap.id));
    if (s?.status !== "running") break;
    await Bun.sleep(50);
  }
}
await w.stop();
const ok = samples.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
const q = (p: number) => ok[Math.min(ok.length - 1, Math.floor(p * ok.length))] ?? null;
console.log(
  JSON.stringify({
    wakes: N,
    measured: ok.length,
    p50Ms: q(0.5),
    p95Ms: q(0.95),
    maxMs: ok.at(-1),
    pollMs: { events: t.s.config.worker.eventPollMs, jobs: t.s.config.worker.jobPollMs },
    target: "< 2000 ms",
  }),
);
await t.close();
process.exit(0);
