/**
 * S8-7 — main scenario, ten steps, on a DEPLOYED instance (manual; NOT CI): real model + real GitLab.
 * Talks to the platform only over its public HTTP API, as people would in the console: no database
 * access, no job draining. Pass the instance URL and an admin token; it registers the model provider,
 * creates the project and agents, binds the GitLab repo, then plays the human parts (ask the captain,
 * answer the follow-up, accept the proposal, approve the merge) and waits for the agents.
 *
 *   BASE=http://127.0.0.1:3000 ADMIN_TOKEN=… LLM_BASE_URL=… LLM_API_KEY=… LLM_MODEL=… \
 *   GITLAB_URL=https://gitlab.example/pay/payments-s8 GITLAB_TOKEN=… [GITLAB_CA_FILE=ca.pem] bun test/gitlab/s8-install-real.ts
 *
 * Production only accepts https GitLab; a self-signed GitLab passes its CA (PEM) in GITLAB_CA_FILE,
 * which goes into the bind form's「CA 证书」field (docs/deploy.md §8).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const BASE = env("BASE").replace(/\/$/, "");
const TOKEN = env("ADMIN_TOKEN");
const MODEL = env("LLM_MODEL");
const t0 = Date.now();
const steps: Array<{ step: string; ok: boolean; s: number; note?: string }> = [];
const mark = (step: string, ok: boolean, note?: string) => {
  steps.push({ step, ok, s: Math.round((Date.now() - t0) / 1000), ...(note ? { note: note.slice(0, 300) } : {}) });
  console.log(`${ok ? "✓" : "✗"} ${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s  ${step}${note ? ` — ${note.slice(0, 200)}` : ""}`);
};
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, minutes = 15): Promise<T> {
  const end = Date.now() + minutes * 60_000;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await Bun.sleep(5_000);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

let taskId = "";
try {
  // ── Setup (an admin's first hour, docs/deploy.md §7–8) ──
  const prov = await api("POST", "/admin/models/providers", {
    name: "模型中转",
    baseUrl: env("LLM_BASE_URL"),
    dialect: "openai",
    isExternal: true,
    apiKey: env("LLM_API_KEY"),
    apis: ["chat", "responses", "messages"],
    // Same as the console's「添加供应商」form defaults: tool calls and JSON on.
    models: [{ name: MODEL, contextWindow: 200_000, supportsTools: true, supportsJson: true }],
  });
  const test = await api<{ ok: boolean; latencyMs: number; error?: string }>("POST", `/admin/models/providers/${prov.id}/test`);
  await api("PUT", "/admin/models/default", { name: MODEL });
  mark("model provider registered, connectivity test, set as default", test.ok, test.ok ? `${test.latencyMs} ms` : test.error);
  const p = await api("POST", "/projects", { key: "PAY", name: "支付服务", description: "支付网关调用、下单与回调" });
  const agents = await api<Array<{ id: string; principalId: string; role: string }>>("GET", `/projects/${p.id}/agents`);
  const cap = agents.find((a) => a.role === "sub_captain")!;
  for (const [name, role] of [
    ["开发 · 小码", "dev"],
    ["评审 · 审审", "reviewer"],
    ["测试 · 测测", "tester"],
  ])
    await api("POST", `/projects/${p.id}/agents`, { name, role });
  const bound = await api<{ check: { ok: boolean; warnings?: string[]; detail?: string } }>("POST", `/projects/${p.id}/repos`, {
    provider: "gitlab",
    name: "payments",
    url: env("GITLAB_URL"),
    token: env("GITLAB_TOKEN"),
    ...(process.env.GITLAB_CA_FILE ? { caCert: readFileSync(process.env.GITLAB_CA_FILE, "utf8") } : {}),
  });
  mark("GitLab repo bound (access check)", bound.check.ok, JSON.stringify(bound.check.warnings ?? []));

  const messages = async () =>
    (await api<{ items: Array<{ id: string; author: { principalId: string }; body: string; kind: string; seq: number }> }>("GET", `/groups/${p.mainGroupId}/messages?limit=50`)).items.map((m) => ({
      ...m,
      authorPrincipalId: m.author.principalId,
    }));
  const say = (body: string) => api("POST", `/groups/${p.mainGroupId}/messages`, { body });

  // ── 1–2: ask the captain; it restates and asks for what's missing ──
  const m1 = await say(`@[${cap.principalId}] 支付服务最近超时，帮我查一下`);
  const reply = await until("captain reply", async () => (await messages()).find((m) => m.authorPrincipalId === cap.principalId && m.seq > m1.message.seq), 5);
  mark("1–2 captain replies to the request", true, reply.body);

  // ── 3: details → proposal with acceptance criteria ──
  await say("从昨天下午 3 点开始，下单接口 p99 超过 30 秒才失败，上游网关 5 秒就断开，影响所有下单用户");
  const prp = await until(
    "task proposal",
    async () =>
      (await api<Array<{ id: string; kind: string; status: string; payload: { title?: string; acceptanceCriteria?: string[] } }>>("GET", `/projects/${p.id}/proposals?status=pending`)).find(
        (x) => x.kind === "create_task",
      ),
    8,
  );
  mark("3 captain proposes a task with acceptance criteria", (prp.payload.acceptanceCriteria ?? []).length > 0, `${prp.payload.title} · ${(prp.payload.acceptanceCriteria ?? []).join(" / ")}`);

  // ── 4: a human confirms in the web console ──
  const acc = await api<{ resultTaskIds: string[] }>("POST", `/proposals/${prp.id}/accept`);
  taskId = acc.resultTaskIds[0]!;
  let tk0 = await api<{ status: string; assigneeAgentId: string | null }>("GET", `/tasks/${taskId}`);
  if (!tk0.assigneeAgentId) {
    // Priorities outside the auto-assign policy (e.g. P1) get an assignment proposal: a person confirms it.
    const asg = await until(
      "assignment proposal",
      async () =>
        (await api<Array<{ id: string; kind: string; payload: { taskId?: string; agentName?: string } }>>("GET", `/projects/${p.id}/proposals?status=pending`)).find(
          (x) => x.kind === "assign" && x.payload.taskId === taskId,
        ),
      3,
    );
    await api("POST", `/proposals/${asg.id}/accept`);
    tk0 = await api("GET", `/tasks/${taskId}`);
    mark("4b human confirms the assignment proposal", Boolean(tk0.assigneeAgentId), asg.payload.agentName ?? "");
  }
  mark("4 human accepts → task created and assigned", Boolean(taskId && tk0.assigneeAgentId), `status ${tk0.status}`);

  // ── 5–8: dev fixes, MR + GitLab CI, review, test; status changes logged as they happen ──
  let last = "";
  const seen: string[] = [];
  const appr = await until(
    "merge approval request",
    async () => {
      const t = await api<{ status: string; blockedReason?: string | null }>("GET", `/tasks/${taskId}`);
      if (t.status !== last) {
        last = t.status;
        seen.push(t.status);
        mark(`task → ${t.status}`, !["blocked", "cancelled"].includes(t.status), t.blockedReason ?? undefined);
        if (["blocked", "cancelled"].includes(t.status)) throw new Error(`task ${t.status}: ${t.blockedReason}`);
      }
      return (await api<Array<{ id: string; kind: string; status: string }>>("GET", `/tasks/${taskId}/approvals`)).find((a) => a.kind === "merge" && a.status === "pending");
    },
    45,
  );
  const code = await api<{ mr?: { ref?: string; url?: string } | null; ci?: { status?: string } | null }>("GET", `/tasks/${taskId}/code`).catch(() => null);
  mark("5–8 fix → MR → GitLab CI → review → test → merge approval requested", true, `path ${seen.join(" → ")}; MR ${code?.mr?.ref ?? "?"}; CI ${code?.ci?.status ?? "?"}`);

  // ── 9: a human approves with the evidence; the merge queue merges ──
  await api("POST", `/approvals/${appr.id}/decide`, { decision: "approve", reason: "证据齐全，同意合并" });
  await until("task done", async () => (await api<{ status: string }>("GET", `/tasks/${taskId}`)).status === "done", 20);
  mark("9 approved → merge queue merges → done", true);

  // ── 10: the captain posts the completion summary in the group ──
  const summary = await until(
    "completion summary",
    async () => (await messages()).find((m) => m.authorPrincipalId === cap.principalId && /完成|已合并|合并/.test(m.body) && m.seq > m1.message.seq + 3),
    5,
  );
  mark("10 captain posts the completion summary", true, summary.body);
} catch (e) {
  mark("scenario", false, (e as Error).message);
} finally {
  const out = resolve(import.meta.dir, "../../../../docs/results/s8-install-real.json");
  writeFileSync(
    out,
    `${JSON.stringify({ at: new Date().toISOString(), base: "deployed instance (docker compose, production config)", model: MODEL, taskId, minutes: Number(((Date.now() - t0) / 60000).toFixed(1)), steps }, null, 2)}\n`,
  );
  console.log(`result: ${out}`);
}
