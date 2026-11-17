/**
 * §15.1 performance seed (manual; NOT CI): 50 projects (made through the API, so each has its
 * captain and main group), 5,000 tasks and 500,000 messages (bulk SQL). Leaves the database in
 * place and writes its URL + an owner token to PERF_OUT (default /tmp/ap-perf.json).
 *
 *   TEST_DATABASE_URL=… bun test/perf/seed-scale.ts
 */
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";

const PROJECTS = Number(process.env.PERF_PROJECTS ?? 50);
const TASKS_PER = Number(process.env.PERF_TASKS_PER ?? 100);
const MSGS_PER = Number(process.env.PERF_MSGS_PER ?? 10_000);
const out = process.env.PERF_OUT ?? "/tmp/ap-perf.json";
const t0 = Date.now();
const { createTestApp } = await import("../helpers");
const t = await createTestApp("perf");
const owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "压测", email: "owner@perf.test", name: "王负责人", password: "Perf-Password-42" } })).body.token as string;
const me = (await t.req("GET", "/api/v1/me", { token: owner })).body as { principalId: string; tenant: { id: string } };
const projects: Array<{ id: string; groupId: string; key: string }> = [];
for (let i = 0; i < PROJECTS; i++) {
  const key = `P${String(i).padStart(2, "0")}`;
  const r = await t.req("POST", "/api/v1/projects", { token: owner, body: { key, name: `项目 ${key}`, description: "压测数据" } });
  projects.push({ id: r.body.id, groupId: r.body.mainGroupId, key });
}
console.log(`projects: ${projects.length} (${Date.now() - t0} ms)`);
// One user per load client: per-user rate limits (§10.3) apply as they would to a real team.
const USERS = Number(process.env.PERF_USERS ?? 16);
const users: string[] = [];
for (let u = 0; u < USERS; u++) {
  const inv = await t.req("POST", "/api/v1/invitations", { token: owner, body: { email: `u${u}@perf.test`, tenantRole: "member" } });
  const acc = await t.req("POST", `/api/v1/invitations/${inv.body.token}/accept`, { body: { email: `u${u}@perf.test`, name: `成员${u}`, password: "Perf-Password-42" } });
  const pid = (await t.req("GET", "/api/v1/me", { token: acc.body.token })).body.principalId as string;
  for (const p of projects) await t.req("PUT", `/api/v1/projects/${p.id}/members/${pid}`, { token: owner, body: { role: "member" } });
  users.push(acc.body.token);
}

const statuses = sql.raw(`(array['backlog','ready','in_progress','in_review','testing','done','blocked'])`);
const topics = sql.raw(`(array['超时','回调','对账','退款','网关','签名','重试','限流','发票','结算'])`);
for (const [i, p] of projects.entries()) {
  await t.s.db.root.execute(sql`
    insert into task (id, tenant_id, project_id, group_id, number, title, description, type, priority, status, created_by, tokens, created_at, updated_at)
    select 'tsk_perf' || ${i} || '_' || g, ${me.tenant.id}, ${p.id}, ${p.groupId}, g,
           '修复支付' || ${topics}[1 + g % 10] || '问题 #' || g, '压测任务描述 ' || md5(g::text), 'bug', 'P2',
           ${statuses}[1 + g % 7], ${me.principalId},
           to_tsvector('simple', '修复 支付 ' || ${topics}[1 + g % 10] || ' 问题'), now() - (g || ' minutes')::interval, now()
    from generate_series(1, ${TASKS_PER}) g`);
  await t.s.db.root.execute(sql`update project set next_task_number = ${TASKS_PER + 1} where id = ${p.id}`);
  const base = ((await t.s.db.root.execute(sql`select next_seq - 1 as base from chat_group where id = ${p.groupId}`)) as unknown as { rows: Array<{ base: number }> }).rows[0]!.base;
  await t.s.db.root.execute(sql`
    insert into message (id, tenant_id, group_id, seq, author_principal_id, author_label, kind, body, tokens, created_at)
    select 'msg_perf' || ${i} || '_' || g, ${me.tenant.id}, ${p.groupId}, ${base}::bigint + g, ${me.principalId}, '王负责人', 'text',
           '第' || g || '条：支付服务 订单 ' || ${topics}[1 + g % 10] || ' ' || md5(g::text),
           to_tsvector('simple', '支付服务 订单 ' || ${topics}[1 + g % 10] || ' ' || md5(g::text)),
           now() - ((${MSGS_PER} - g) || ' seconds')::interval
    from generate_series(1, ${MSGS_PER}) g`);
  await t.s.db.root.execute(sql`update chat_group set next_seq = ${base}::bigint + ${MSGS_PER} + 1 where id = ${p.groupId}`);
  if (i % 10 === 9) console.log(`seeded ${i + 1}/${projects.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
}
await t.s.db.root.execute(sql`analyze`);
const counts = (
  (await t.s.db.root.execute(sql`select (select count(*) from project)::int p, (select count(*) from task)::int t, (select count(*) from message)::int m`)) as unknown as {
    rows: Array<{ p: number; t: number; m: number }>;
  }
).rows[0];
writeFileSync(out, JSON.stringify({ url: t.url, token: owner, users, projects, counts, seededInMs: Date.now() - t0 }, null, 2));
console.log(JSON.stringify({ counts, seconds: Math.round((Date.now() - t0) / 1000), out }));
// Keep the database: close connections without dropping.
await t.s.realtime.stop();
await t.s.db.close();
process.exit(0);
