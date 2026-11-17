import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NO_EVIDENCE_TEXT } from "@ap/shared";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { BILLING_REPO, PAYMENTS_REPO } from "../src/cli/demo-repos";
import { DEMO_EVAL } from "../src/cli/demo-eval";
import type { Ctx } from "../src/core/context";
import { newId } from "../src/core/ids";
import { decision, documentChunk, job, projectIndex, tenant } from "../src/db/schema";
import { hasLexicalEvidence } from "../src/modules/knowledge/service";
import { embedPrefix } from "../src/modules/llm/service";
import { git } from "../src/modules/scm/service";
import { createTestApp, type TestApp } from "./helpers";

process.env.LLM_BACKOFF_MS = "2";
let t: TestApp;
const PW = "Correct-Horse-42";
const dataDir = mkdtempSync(join(tmpdir(), "ap-s7-"));
let owner = "";
let ownerCtx: Ctx;
let outsider = "";
let outsiderCtx: Ctx;
let tenantId = "";
const P: Record<string, { id: string; group: string; repoId: string; url: string }> = {};

beforeAll(async () => {
  t = await createTestApp("s7kb", { DATA_DIR: dataDir, SANDBOX: "process" });
  const setup = await t.req("POST", "/api/v1/setup", { body: { tenantName: "S7", email: "o@s7.test", name: "王负责人", password: PW } });
  owner = setup.body.token;
  ownerCtx = await t.s.identity.authenticate(new Headers({ authorization: `Bearer ${owner}` }), "trc_s7");
  tenantId = (await t.s.db.root.select().from(tenant))[0]!.id;
  // Vector route on, with the deterministic embedding model (§8.7).
  await t.s.db.root.execute(sql`update tenant set settings = settings || ${JSON.stringify({ embeddingModel: "scripted:embed" })}::jsonb where id = ${tenantId}`);
  for (const [key, name, files, repoName] of [
    ["PAY", "支付服务", PAYMENTS_REPO, "payments"],
    ["BILL", "计费服务", BILLING_REPO, "billing"],
  ] as const) {
    const p = await t.req("POST", "/api/v1/projects", { token: owner, body: { key, name } });
    const bound = await t.s.repos.bind(ownerCtx, p.body.id, {
      provider: "local",
      name: repoName,
      files: { ...files, ".env": "DB_PASSWORD=hunter2hunter2\n", "src/leak.ts": `export const apiKey = "sk-${"a".repeat(30)}";\n` },
    });
    P[key] = { id: p.body.id, group: p.body.mainGroupId, repoId: bound.repo.id, url: bound.repo.url };
  }
  const inv = await t.req("POST", "/api/v1/invitations", { token: owner, body: { tenantRole: "member" } });
  const acc = await t.req("POST", `/api/v1/invitations/${inv.body.token}/accept`, { body: { email: "x@s7.test", name: "外部成员", password: PW } });
  outsider = acc.body.token;
  const me = (await t.req("GET", "/api/v1/me", { token: outsider })).body;
  await t.req("PUT", `/api/v1/projects/${P.PAY!.id}/members/${me.principalId}`, { token: owner, body: { role: "member" } });
  outsiderCtx = await t.s.identity.authenticate(new Headers({ authorization: `Bearer ${outsider}` }), "trc_s7x");
  const { registerHandlers } = await import("../src/modules/registry");
  await registerHandlers(t.s);
  await t.s.consumers.init();
  await t.s.db.root.delete(job).where(sql`${job.cron} is not null`);
  // repo.bound → full index jobs.
  for (let i = 0; i < 10; i++) if (!(await t.s.consumers.drain()) && !(await t.s.jobs.drain())) break;
});
afterAll(async () => {
  await t?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("S7 indexing", () => {
  test("repo.bound indexes the default branch: code by declaration, docs by heading, embeddings, exclusions and redaction (KB-补1)", async () => {
    const st = await t.req("GET", `/api/v1/projects/${P.PAY!.id}/knowledge/status`, { token: owner });
    expect(st.status).toBe(200);
    const ix = st.body.indexes.find((x: { repoId: string }) => x.repoId === P.PAY!.repoId);
    expect(ix).toMatchObject({ status: "ready", version: 1, stale: false, embeddingModel: "scripted:embed" });
    const chunks = await t.s.db.root.select().from(documentChunk).where(eq(documentChunk.projectId, P.PAY!.id));
    expect(chunks.find((c) => c.path === "src/gateway.ts" && c.symbol === "GATEWAY_CALL_TIMEOUT_MS")).toBeTruthy();
    expect(chunks.find((c) => c.path === "docs/runbook.md" && c.symbol === "回调失败")).toBeTruthy();
    expect(chunks.some((c) => c.path === ".env")).toBe(false);
    const leak = chunks.find((c) => c.path === "src/leak.ts")!;
    expect(leak.text).toContain("[REDACTED]");
    expect(leak.text).not.toContain("sk-aaaa");
    const withVec = await t.s.db.root
      .select({ id: documentChunk.id })
      .from(documentChunk)
      .where(and(eq(documentChunk.projectId, P.PAY!.id), isNotNull(documentChunk.embedding)));
    expect(withVec.length).toBe(chunks.length);
  });

  test("FR-KB-03: a deleted file is tombstoned on the next incremental index and never returned again", async () => {
    const before = await t.s.knowledge.search(ownerCtx, { query: "超时约定 支付网关", projectIds: [P.BILL!.id] });
    expect(before.results.some((h) => h.path === "docs/timeouts.md")).toBe(true);
    const tmp = mkdtempSync(join(tmpdir(), "ap-s7d-"));
    await git(["clone", "-q", P.BILL!.url, tmp], { cwd: "/" });
    await git(["rm", "-q", "docs/timeouts.md"], { cwd: tmp });
    await git(["-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qm", "删除超时约定文档"], { cwd: tmp });
    await git(["push", "-q", P.BILL!.url, "HEAD:refs/heads/main"], { cwd: tmp, env: { AP_MERGE_QUEUE: "1" } });
    const r = await t.s.knowledge.indexRepo({ projectId: P.BILL!.id, repoId: P.BILL!.repoId });
    expect(r).toMatchObject({ tombstoned: 1, changed: 0 });
    const after = await t.s.knowledge.search(ownerCtx, { query: "超时约定 支付网关", projectIds: [P.BILL!.id] });
    expect(after.results.some((h) => h.path === "docs/timeouts.md")).toBe(false);
    const dead = await t.s.db.root
      .select()
      .from(documentChunk)
      .where(and(eq(documentChunk.path, "docs/timeouts.md"), isNotNull(documentChunk.tombstonedAt)));
    expect(dead.length).toBeGreaterThan(0);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("FR-KB-08: a full rebuild builds a new version and switches the alias; one active index per repo", async () => {
    const r = await t.s.knowledge.indexRepo({ projectId: P.PAY!.id, repoId: P.PAY!.repoId, full: true });
    expect((r as { version: number }).version).toBe(2);
    const active = await t.s.db.root
      .select()
      .from(projectIndex)
      .where(and(eq(projectIndex.repoId, P.PAY!.repoId), eq(projectIndex.isActive, true)));
    expect(active).toHaveLength(1);
    expect(active[0]!.version).toBe(2);
    const live = await t.s.db.root.select({ ix: documentChunk.indexId }).from(documentChunk).where(eq(documentChunk.projectId, P.PAY!.id));
    expect(new Set(live.map((x) => x.ix))).toEqual(
      new Set([
        active[0]!.id,
        ...(
          await t.s.db.root
            .select({ id: projectIndex.id })
            .from(projectIndex)
            .where(and(eq(projectIndex.projectId, P.PAY!.id), isNull(projectIndex.repoId)))
        ).map((x) => x.id),
      ]),
    );
    // Unchanged commit → incremental is a no-op.
    expect(await t.s.knowledge.indexRepo({ projectId: P.PAY!.id, repoId: P.PAY!.repoId })).toMatchObject({ unchanged: true });
  });
});

describe("S7 retrieval", () => {
  test("hybrid search is explainable per route and each route can be switched off (FR-KB-04)", async () => {
    const all = await t.req("GET", `/api/v1/projects/${P.PAY!.id}/knowledge/search?q=${encodeURIComponent("支付回调如何验签")}`, { token: owner });
    expect(all.status).toBe(200);
    expect(all.body.results[0].path).toBe("src/callback.ts");
    const routes = new Set<string>(all.body.results.flatMap((h: { routes: Array<{ route: string }> }) => h.routes.map((r) => r.route)));
    expect([...routes].sort((a, b) => a.localeCompare(b))).toEqual(["bm25", "sag2", "vector"]);
    expect(all.body.routes.bm25.candidates).toBeGreaterThan(0);
    const only = await t.req("GET", `/api/v1/projects/${P.PAY!.id}/knowledge/search?q=${encodeURIComponent("支付回调如何验签")}&routes=bm25`, { token: owner });
    expect(new Set(only.body.results.flatMap((h: { routes: Array<{ route: string }> }) => h.routes.map((r) => r.route)))).toEqual(new Set(["bm25"]));
    expect(only.body.routes.sag2.enabled).toBe(false);
  });

  test("S7 exit: asked in the payments context, the global captain finds the billing timeout logic with clickable citations", async () => {
    const r = await t.req("POST", "/api/v1/captain/ask", { token: owner, body: { question: "超时相关的计费逻辑在哪个仓库哪个文件" } });
    expect(r.status).toBe(200);
    expect(r.body.consulted).toContain("BILL");
    const bill = r.body.sources.find((s: { key: string }) => s.key === "BILL");
    expect(bill).toBeTruthy();
    const cite = bill.citations.find((c: { path: string }) => c.path === "src/payments-client.ts");
    expect(cite).toMatchObject({ repoName: "billing" });
    expect(r.body.answer).toContain("【BILL】");
    // The citation resolves to the file at that commit (FR-KB-06).
    const f = await t.req("GET", `/api/v1/projects/${P.BILL!.id}/knowledge/file?repoId=${cite.repoId}&path=${encodeURIComponent(cite.path)}&commit=${cite.commit}`, { token: owner });
    expect(f.status).toBe(200);
    expect(f.body.content).toContain("PAYMENTS_CALL_TIMEOUT_MS");
  });

  test("INV-12: content of a project the caller cannot read never enters any route's candidate set", async () => {
    const r = await t.s.knowledge.search(outsiderCtx, { query: "超时 计费 支付 账单 税额" });
    expect(r.allowedProjectIds).toEqual([P.PAY!.id]);
    for (const k of ["bm25", "sag2", "vector"] as const) for (const pid of r.routes[k].projects) expect(pid).toBe(P.PAY!.id);
    expect(r.results.every((h) => h.projectId === P.PAY!.id)).toBe(true);
    const direct = await t.req("GET", `/api/v1/projects/${P.BILL!.id}/knowledge/search?q=${encodeURIComponent("账单")}`, { token: outsider });
    expect([403, 404]).toContain(direct.status);
    const g = await t.req("POST", "/api/v1/captain/ask", { token: outsider, body: { question: "计费服务的税率是多少" } });
    expect(g.body.consulted ?? []).not.toContain("BILL");
    expect(JSON.stringify(g.body)).not.toContain("DEFAULT_VAT_RATE");
  });

  test("INV-04: nothing relevant → 未检索到依据, low confidence, a follow-up suggestion, no citations", async () => {
    const r = await t.req("POST", `/api/v1/projects/${P.PAY!.id}/knowledge/ask`, { token: owner, body: { question: "量子纠缠的哈密顿量怎么写" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ answer: NO_EVIDENCE_TEXT, citations: [], confidence: "low" });
    expect(r.body.followUp).toBeTruthy();
  });

  test("KB-补2 / TRAP-15: citations a model invents are dropped; the answer falls back to retrieved locations only", async () => {
    await t.s.db.root.execute(sql`update tenant set settings = settings || ${JSON.stringify({ defaultModel: "scripted:rogue" })}::jsonb where id = ${tenantId}`);
    const r = await t.s.knowledge.askProjectCaptain(ownerCtx, { projectId: P.PAY!.id, question: "退款金额校验规则" });
    await t.s.db.root.execute(sql`update tenant set settings = settings - 'defaultModel' where id = ${tenantId}`);
    expect(r.model).toBe("fallback");
    expect(r.citations.length).toBeGreaterThan(0);
    for (const c of r.citations) expect(r.hits.some((h) => h.path === c.path && h.commit === c.commit)).toBe(true);
    expect(r.citations[0]!.path).toBe("src/refund.ts");
  });

  test("FR-KB-10: an index behind the branch head marks answers stale", async () => {
    await t.s.db.root.execute(sql`update repo set settings = settings || ${JSON.stringify({ headSha: "f".repeat(40) })}::jsonb where id = ${P.PAY!.repoId}`);
    const r = await t.s.knowledge.askProjectCaptain(ownerCtx, { projectId: P.PAY!.id, question: "支付回调如何验签" });
    await t.s.db.root.execute(sql`update repo set settings = settings - 'headSha' where id = ${P.PAY!.repoId}`);
    expect(r.stale).toBe(true);
    expect(r.answer).toContain("旧 commit");
    expect(r.confidence).not.toBe("high");
  });

  test("TRAP-3 / KB-补4/5: raw chat is never evidence; confirmed decisions are, and lead for 'why' questions", async () => {
    await t.req("POST", `/api/v1/groups/${P.PAY!.group}/messages`, { token: owner, body: { body: "闲聊：紫罗兰协议听说很好用" } });
    await t.s.db.root
      .insert(decision)
      .values({ id: newId("dcs"), tenantId, projectId: P.PAY!.id, groupId: P.PAY!.group, text: "决定：支付回调改为异步队列处理，原因是上游重试通知过多导致超时", status: "confirmed" });
    await t.s.knowledge.indexWarm(P.PAY!.id);
    const chat = await t.s.knowledge.search(ownerCtx, { query: "紫罗兰协议", projectIds: [P.PAY!.id] });
    // Raw chat is not indexed: nothing lexically matches, vector neighbours are not evidence.
    expect(chat.results.some((h) => h.text.includes("紫罗兰") || h.sourceKind === "chat")).toBe(false);
    expect(chat.results.filter(hasLexicalEvidence)).toEqual([]);
    const noAnswer = await t.s.knowledge.askProjectCaptain(ownerCtx, { projectId: P.PAY!.id, question: "紫罗兰协议" });
    expect(noAnswer.answer).toBe(NO_EVIDENCE_TEXT);
    const why = await t.s.knowledge.search(ownerCtx, { query: "为什么支付回调改为异步队列", projectIds: [P.PAY!.id] });
    expect(why.results[0]!.sourceKind).toBe("decision");
    // Pure vector similarity is not evidence.
    expect(hasLexicalEvidence({ routes: [{ route: "vector", score: 0.9, rank: 1 }] })).toBe(false);
    expect(hasLexicalEvidence({ routes: [{ route: "bm25", score: 0.1, rank: 3 }] })).toBe(true);
  });

  test("project catalog lists repos, maintainers and agents (FR-KB-01)", async () => {
    const c = await t.req("GET", `/api/v1/projects/${P.PAY!.id}/catalog`, { token: owner });
    expect(c.status).toBe(200);
    expect(c.body.repos[0]).toMatchObject({ name: "payments" });
    expect(c.body.agents.length).toBeGreaterThan(0);
  });
});

describe("S7 eval set (KB-补6)", () => {
  test("30 demo questions: recall@5 on expected paths ≥ 0.85", async () => {
    // Restore the deleted doc so the set is evaluated against the full demo repo.
    const tmp = mkdtempSync(join(tmpdir(), "ap-s7e-"));
    await git(["clone", "-q", P.BILL!.url, tmp], { cwd: "/" });
    mkdirSync(join(tmp, "docs"), { recursive: true });
    writeFileSync(join(tmp, "docs/timeouts.md"), BILLING_REPO["docs/timeouts.md"]!);
    await git(["add", "-A"], { cwd: tmp });
    await git(["-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qm", "恢复超时约定"], { cwd: tmp });
    await git(["push", "-q", P.BILL!.url, "HEAD:refs/heads/main"], { cwd: tmp, env: { AP_MERGE_QUEUE: "1" } });
    await t.s.knowledge.indexRepo({ projectId: P.BILL!.id, repoId: P.BILL!.repoId });
    const results = [];
    for (const q of DEMO_EVAL) {
      const pid = q.repo === "payments" ? P.PAY!.id : P.BILL!.id;
      const r = await t.s.knowledge.search(ownerCtx, { query: q.question, projectIds: [pid], limit: 5 });
      const found = r.results.map((h) => h.path);
      results.push({ repo: q.repo, question: q.question, expect: q.expect, found, hit: q.expect.some((e) => found.includes(e)) });
    }
    const recall = results.filter((r) => r.hit).length / results.length;
    writeFileSync(
      resolve(import.meta.dir, "../../../docs/results/s7-eval.json"),
      JSON.stringify(
        { at: new Date().toISOString(), model: "scripted (judge) + scripted:embed", k: 5, total: results.length, recall: Number(recall.toFixed(3)), misses: results.filter((r) => !r.hit) },
        null,
        2,
      ) + "\n",
    );
    expect(results).toHaveLength(30);
    expect(recall).toBeGreaterThanOrEqual(0.85);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("S7 embedding model administration (§8.7)", () => {
  test("only registered 768-d embedding models can be selected; switching rebuilds every index, warm layer included", async () => {
    const bad = await t.req("POST", "/api/v1/admin/models/providers", {
      token: owner,
      body: { name: "错维度", baseUrl: "http://127.0.0.1:9", dialect: "ollama", isExternal: false, models: [{ name: "big-embed", embeddingDim: 1024 }] },
    });
    expect(bad.status).toBe(400);
    expect((await t.req("PUT", "/api/v1/admin/models/embedding", { token: owner, body: { name: "scripted:demo" } })).status).toBe(400); // a chat model
    expect((await t.req("PUT", "/api/v1/admin/models/embedding", { token: outsider, body: { name: null } })).status).toBe(403);

    const before = new Map((await t.s.db.root.select().from(projectIndex).where(eq(projectIndex.isActive, true))).map((i) => [i.repoId ?? `warm:${i.projectId}`, i.version]));
    const off = await t.req("PUT", "/api/v1/admin/models/embedding", { token: owner, body: { name: null } });
    expect(off.body).toMatchObject({ embeddingModel: null, changed: true });
    expect(off.body.rebuildQueued).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) if (!(await t.s.consumers.drain()) && !(await t.s.jobs.drain())) break;
    const r = await t.s.knowledge.search(ownerCtx, { query: "支付回调如何验签", projectIds: [P.PAY!.id] });
    expect(r.routes.vector).toMatchObject({ enabled: false, note: expect.stringContaining("未配置嵌入模型") });

    const on = await t.req("PUT", "/api/v1/admin/models/embedding", { token: owner, body: { name: "scripted:embed" } });
    expect(on.body).toMatchObject({ embeddingModel: "scripted:embed", changed: true });
    for (let i = 0; i < 20; i++) if (!(await t.s.consumers.drain()) && !(await t.s.jobs.drain())) break;
    const after = await t.s.db.root.select().from(projectIndex).where(eq(projectIndex.isActive, true));
    for (const ix of after) {
      expect(ix.embeddingModel).toBe("scripted:embed"); // warm layer label follows the model too
      if (ix.repoId) expect(ix.version).toBeGreaterThan(before.get(ix.repoId)!); // full rebuild, alias switched
    }
    const back = await t.s.knowledge.search(ownerCtx, { query: "支付回调如何验签", projectIds: [P.PAY!.id] });
    expect(back.routes.vector.enabled).toBe(true);
    expect(back.routes.vector.candidates).toBeGreaterThan(0);
    // Selecting the same model again is a no-op.
    expect((await t.req("PUT", "/api/v1/admin/models/embedding", { token: owner, body: { name: "scripted:embed" } })).body).toMatchObject({ changed: false, rebuildQueued: 0 });
  });

  test("asymmetric models get their query / document prefixes", () => {
    expect(embedPrefix("nomic-embed-text", "query")).toBe("search_query: ");
    expect(embedPrefix("nomic-embed-text:v1.5", "document")).toBe("search_document: ");
    expect(embedPrefix("embeddinggemma", "query")).toBe("task: search result | query: ");
    expect(embedPrefix("embeddinggemma:300m", "document")).toBe("title: none | text: ");
    expect(embedPrefix("scripted:embed", "query")).toBe("");
  });
});
