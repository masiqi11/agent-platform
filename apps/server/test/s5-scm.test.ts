import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Ctx } from "../src/core/context";
import { newId } from "../src/core/ids";
import { auditLog, credential, event, repo, task, taskComment, workspace } from "../src/db/schema";
import { createGitLabScm } from "../src/modules/scm/gitlab";
import { ScmAuthError, ScmNotReady } from "../src/modules/scm/types";
import { scanDiffForSecrets } from "../src/modules/workspaces/service";
import { createTestApp, type TestApp } from "./helpers";

/** In-memory GitLab REST v4 (just what the provider uses). */
function fakeGitLab(token = "glpat-test-token-0123456789abcd") {
  const st = {
    issues: [] as Array<{ iid: number; title: string; description: string; labels: string[]; state: string }>,
    mrs: [] as Array<{ iid: number; source_branch: string; target_branch: string; state: string; title: string }>,
    notes: [] as Array<{ target: string; iid: number; body: string }>,
    pipelines: [] as Array<{ id: number; sha: string; ref: string; status: string }>,
    mergeResponses: [] as number[],
    protectedMain: true,
    calls: [] as string[],
    level: 30,
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const path = url.pathname.replace(/^\/api\/v4/, "");
    st.calls.push(`${method} ${path}${url.search}`);
    if ((init?.headers as Record<string, string>)?.["PRIVATE-TOKEN"] !== token) return json(401, { message: "401 Unauthorized" });
    if (path === "/user") return json(200, { id: 99, username: "platform-bot" });
    if (path === "/personal_access_tokens/self") return json(200, { scopes: ["api"] });
    const m = path.match(/^\/projects\/([^/]+)(\/.*)?$/);
    if (!m) return json(404, {});
    const rest = m[2] ?? "";
    if (!rest) return json(200, { id: 7, default_branch: "main", path_with_namespace: "pay/payments", permissions: { project_access: { access_level: st.level } } });
    if (rest.startsWith("/protected_branches/"))
      return st.protectedMain && rest.endsWith("/main") ? json(200, { name: "main", allow_force_push: false, push_access_levels: [{ access_level: 40 }] }) : json(404, {});
    if (rest === "/issues" && method === "GET") {
      const label = url.searchParams.get("labels");
      return json(
        200,
        st.issues.filter((i) => !label || i.labels.includes(label)),
      );
    }
    if (rest === "/issues" && method === "POST") {
      const i = { iid: st.issues.length + 1, title: body.title, description: body.description, labels: String(body.labels).split(","), state: "opened" };
      st.issues.push(i);
      return json(201, { ...i, web_url: `https://gl.test/pay/payments/-/issues/${i.iid}` });
    }
    const im = rest.match(/^\/issues\/(\d+)$/);
    if (im) {
      const i = st.issues.find((x) => x.iid === Number(im[1]));
      if (!i) return json(404, {});
      if (method === "PUT") {
        if (body.title) i.title = body.title;
        if (body.description) i.description = body.description;
        if (body.labels) i.labels = String(body.labels).split(",");
        if (body.state_event === "close") i.state = "closed";
        if (body.state_event === "reopen") i.state = "opened";
      }
      return json(200, { ...i, web_url: `https://gl.test/pay/payments/-/issues/${i.iid}` });
    }
    if (rest === "/merge_requests" && method === "POST") {
      if (st.mrs.some((x) => x.source_branch === body.source_branch && x.state === "opened")) return json(409, { message: ["Another open merge request already exists for this source branch"] });
      const mr = { iid: st.mrs.length + 1, source_branch: body.source_branch, target_branch: body.target_branch, state: "opened", title: body.title };
      st.mrs.push(mr);
      return json(201, { ...mr, web_url: `https://gl.test/pay/payments/-/merge_requests/${mr.iid}` });
    }
    if (rest === "/merge_requests" && method === "GET")
      return json(
        200,
        st.mrs.filter((x) => x.source_branch === url.searchParams.get("source_branch") && x.state === url.searchParams.get("state")),
      );
    const mm = rest.match(/^\/merge_requests\/(\d+)(\/merge|\/notes)?$/);
    if (mm) {
      const mr = st.mrs.find((x) => x.iid === Number(mm[1]));
      if (!mr) return json(404, {});
      if (mm[2] === "/merge") {
        const code = st.mergeResponses.shift() ?? 200;
        if (code !== 200) return json(code, { message: code === 405 ? "Method Not Allowed" : "Branch cannot be merged" });
        mr.state = "merged";
        return json(200, { ...mr, merge_commit_sha: "f".repeat(40) });
      }
      if (mm[2] === "/notes") {
        st.notes.push({ target: "mr", iid: mr.iid, body: body.body });
        return json(201, { id: st.notes.length });
      }
      if (method === "PUT" && body.state_event === "close") mr.state = "closed";
      return json(200, { ...mr, web_url: `https://gl.test/pay/payments/-/merge_requests/${mr.iid}` });
    }
    if (rest === "/pipelines") return json(200, st.pipelines.filter((p) => p.sha === url.searchParams.get("sha")).reverse());
    return json(404, { message: "not faked" });
  }) as typeof fetch;
  return { st, fetch: f, token };
}

const gl = fakeGitLab();
const repoRef = { url: "https://gl.test/pay/payments", externalId: "pay/payments", defaultBranch: "main" };

describe("S5 GitLab provider (fake server)", () => {
  const scm = createGitLabScm(repoRef, { token: gl.token, fetch: gl.fetch, backoffMs: 1, notReadyRetries: 2 });

  test("checkAccess: permission level, protected default branch, bot id; warns when unprotected", async () => {
    const ok = await scm.checkAccess();
    expect(ok).toMatchObject({ ok: true, defaultBranch: "main", defaultBranchProtected: true, canPush: true, botUserId: "99" });
    expect(ok.warnings).toEqual([]);
    gl.st.protectedMain = false;
    const warn = await scm.checkAccess();
    expect(warn.defaultBranchProtected).toBe(false);
    expect(warn.warnings.join()).toContain("未受保护");
    gl.st.protectedMain = true;
  });

  test("TRAP-9: creating an MR that already exists (409) reuses it", async () => {
    const a = await scm.openMr({ sourceBranch: "task/1", targetBranch: "main", title: "PAY-1", description: "d" });
    const b = await scm.openMr({ sourceBranch: "task/1", targetBranch: "main", title: "PAY-1", description: "d" });
    expect(a.reused).toBe(false);
    expect(b).toMatchObject({ iid: a.iid, reused: true });
    expect(gl.st.mrs).toHaveLength(1);
  });

  test("TRAP-9: merge 405/406 retried a bounded number of times; persistent 422 → ScmNotReady with reason", async () => {
    gl.st.mergeResponses = [405, 406];
    expect((await scm.mergeMr(1, "a".repeat(40))).mergeCommit).toBe("f".repeat(40));
    const mr2 = await scm.openMr({ sourceBranch: "task/2", targetBranch: "main", title: "PAY-2", description: "d" });
    gl.st.mergeResponses = [422, 422, 422, 422];
    const before = gl.st.calls.length;
    await expect(scm.mergeMr(mr2.iid, "b".repeat(40))).rejects.toBeInstanceOf(ScmNotReady);
    expect(gl.st.calls.slice(before).filter((c) => c.includes("/merge")).length).toBe(3); // 1 + 2 retries
  });

  test("TRAP-9: issue sync is convergent — re-runs (even after losing the iid) never duplicate", async () => {
    const input = { marker: "ap::PAY-1", title: "PAY-1 超时", description: "x", labels: ["status::开发中"], state: "opened" as const };
    const a = await scm.upsertIssue({ ...input, iid: null });
    const b = await scm.upsertIssue({ ...input, iid: null }); // iid lost: found by marker label
    const c = await scm.upsertIssue({ ...input, iid: a.iid, labels: ["status::已完成"], state: "closed" });
    const d2 = await scm.upsertIssue({ ...input, iid: a.iid, labels: ["status::已完成"], state: "closed" });
    expect(new Set([a.iid, b.iid, c.iid, d2.iid]).size).toBe(1);
    expect(gl.st.issues).toHaveLength(1);
    expect(gl.st.issues[0]).toMatchObject({ state: "closed" });
    expect(gl.st.issues[0]!.labels).toEqual(["ap::PAY-1", "status::已完成"]);
  });

  test("401 → ScmAuthError; the token never appears in errors", async () => {
    const bad = createGitLabScm(repoRef, { token: "glpat-wrong-wrong-wrong-wrong", fetch: gl.fetch });
    const e = await bad.getMr(1).catch((x) => x);
    expect(e).toBeInstanceOf(ScmAuthError);
    expect(String(e.message)).not.toContain("glpat-wrong");
  });

  test("git remote auth is a one-shot askpass, no token in the URL", async () => {
    const r = await scm.gitRemote();
    expect(r.url).toBe("https://gl.test/pay/payments.git");
    expect(r.url).not.toContain(gl.token);
    expect(await Bun.file(r.env.GIT_ASKPASS!).text()).not.toContain(gl.token);
    await r.cleanup();
    expect(await Bun.file(r.env.GIT_ASKPASS!).exists()).toBe(false);
  });
});

describe("S5 GIT-补8 secret scan", () => {
  test("only added lines count", () => {
    const diff = ["--- a/x", "+++ b/x", `-const old = "glpat-${"o".repeat(24)}";`, '+const ok = "hello";'].join("\n");
    expect(scanDiffForSecrets(diff)).toEqual([]);
    expect(scanDiffForSecrets(`+++ b/k\n+AKIAABCDEFGHIJKLMNOP\n`)).toHaveLength(1);
  });
});

/* ───────────── binding, credentials, webhooks, CI state (TRAP-7) ───────────── */

let t: TestApp;
const dataDir = mkdtempSync(join(tmpdir(), "ap-s5scm-"));
let owner = "";
let ownerCtx: Ctx;
let projectId = "";
let repoId = "";
let secret = "";
let taskId = "";
let wsId = "";
const gl2 = fakeGitLab("glpat-binding-token-0123456789wxyz");
const realFetch = globalThis.fetch;

beforeAll(async () => {
  t = await createTestApp("s5scm", { DATA_DIR: dataDir });
  const setup = await t.req("POST", "/api/v1/setup", { body: { tenantName: "S5G", email: "o@s5g.test", name: "王负责人", password: "Correct-Horse-42" } });
  owner = setup.body.token;
  ownerCtx = await t.s.identity.authenticate(new Headers({ authorization: `Bearer ${owner}` }), "trc_s5g");
  const p = await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "PAY", name: "支付服务" } });
  projectId = p.body.id;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await t?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("S5 repo binding + webhooks (fake GitLab through the app)", () => {
  test("bind: preflight, encrypted token (last 4 only), webhook secret shown once, audit without the token", async () => {
    // Point the GitLab provider at the fake server (it resolves the global fetch per client).
    globalThis.fetch = Object.assign(gl2.fetch, { preconnect: () => undefined }) as typeof fetch;
    const body = { provider: "gitlab", name: "payments", url: "https://gl.test/pay/payments", token: gl2.token, testCommand: "bun test" };
    const pre = await t.req("POST", `/api/v1/projects/${projectId}/repos/preflight`, { token: owner, body });
    expect(pre.status).toBe(200);
    expect(pre.body).toMatchObject({ ok: true, defaultBranchProtected: true });
    const r = await t.req("POST", `/api/v1/projects/${projectId}/repos`, { token: owner, body });
    expect(r.status).toBe(200);
    expect(r.body.repo).toMatchObject({ provider: "gitlab", status: "ok", tokenLast4: "wxyz" });
    expect(r.body.webhook.url).toContain(`/api/v1/webhooks/gitlab/${r.body.repo.id}`);
    repoId = r.body.repo.id;
    secret = r.body.webhook.secret;
    const list = await t.req("GET", `/api/v1/projects/${projectId}/repos`, { token: owner });
    expect(JSON.stringify(list.body)).not.toContain(gl2.token);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    const creds = await t.s.db.root.select().from(credential);
    expect(creds.every((c) => !c.ciphertext.includes(gl2.token) && !c.ciphertext.includes(secret))).toBe(true);
    const audits = await t.s.db.root.select().from(auditLog).where(eq(auditLog.action, "repo.bind"));
    expect(JSON.stringify(audits)).not.toContain(gl2.token);
  });

  test("local binding refuses host paths outside LOCAL_SCM_DIR", async () => {
    const r = await t.req("POST", `/api/v1/projects/${projectId}/repos`, { token: owner, body: { provider: "local", name: "evil", url: "/etc" } });
    expect(r.status).toBe(400);
  });

  test("webhook: bad token 401; notes mirrored once (INV-16); bot notes ignored (loop-back); issue edits become hints", async () => {
    const tk = await t.req("POST", "/api/v1/tasks", { token: owner, body: { projectId, title: "超时" } });
    taskId = tk.body.id;
    await t.s.db.root.update(task).set({ issueRef: "#5" }).where(eq(task.id, taskId));
    const hook = (kind: string, b: unknown, tok = secret, uuid = newId("u")) =>
      t.req("POST", `/api/v1/webhooks/gitlab/${repoId}`, { headers: { "x-gitlab-token": tok, "x-gitlab-event": kind, "x-gitlab-event-uuid": uuid }, body: b });
    expect((await hook("Note Hook", {}, "wrong")).status).toBe(401);
    const note = { user: { id: 7, name: "李测试" }, object_attributes: { id: 501, note: "复现了：下单 30s 才返回" }, issue: { iid: 5 } };
    expect((await hook("Note Hook", note, secret, "uuid-1")).status).toBe(200);
    expect((await hook("Note Hook", note, secret, "uuid-1")).status).toBe(200);
    expect((await hook("Note Hook", { ...note, user: { id: 99, name: "platform-bot" }, object_attributes: { id: 502, note: "我们自己发的" } })).body.result).toEqual({ ignored: "loopback" });
    await hook("Issue Hook", { user: { id: 7 }, object_attributes: { iid: 5, id: 1, action: "update", updated_at: "x" }, changes: { title: { previous: "a", current: "b" } } }, secret, "uuid-2");
    const comments = await t.s.db.root.select().from(taskComment).where(eq(taskComment.taskId, taskId));
    expect(comments).toHaveLength(2);
    expect(comments.map((c) => c.body).join("\n")).toContain("复现了");
    expect(comments.map((c) => c.body).join("\n")).toContain("平台以任务为准");
  });

  test("TRAP-7: CI status is monotonic per sha; duplicates and late polls are no-ops; stale sha ignored", async () => {
    const [tk] = await t.s.db.root.select().from(task).where(eq(task.id, taskId));
    wsId = newId("wsp");
    const head = "a".repeat(40);
    await t.s.db.root.insert(workspace).values({ id: wsId, tenantId: tk!.tenantId, taskId, repoId, branch: "task/1", status: "ready", headCommit: head, baseCommit: "0".repeat(40), mrRef: "!1" });
    const hook = (status: string, sha = head, id = 11) =>
      t.req("POST", `/api/v1/webhooks/gitlab/${repoId}`, {
        headers: { "x-gitlab-token": secret, "x-gitlab-event": "Pipeline Hook", "x-gitlab-event-uuid": newId("u") },
        body: { object_attributes: { id, sha, ref: "task/1", status } },
      });
    await hook("running");
    await hook("success");
    await hook("success"); // duplicate webhook
    await hook("running"); // late report for the same pipeline must not downgrade
    // Polling fallback reports the same terminal result: no-op.
    gl2.st.pipelines.push({ id: 11, sha: head, ref: "task/1", status: "success" });
    await t.s.workspaces.pollCi({ workspaceId: wsId, sha: head });
    await hook("failed", "b".repeat(40), 12); // stale sha (not the head)
    const [ws] = await t.s.db.root.select().from(workspace).where(eq(workspace.id, wsId));
    expect(ws!.ci).toMatchObject({ status: "success", sha: head });
    const done = (await t.s.db.root.select().from(event).where(eq(event.type, "pipeline.completed"))).filter((e) => (e.payload as { workspaceId: string }).workspaceId === wsId);
    expect(done).toHaveLength(1);
    // A *new* pipeline for the same sha (retry, GIT-补5) may record a different terminal result.
    await hook("failed", head, 13);
    const [ws2] = await t.s.db.root.select().from(workspace).where(eq(workspace.id, wsId));
    expect(ws2!.ci).toMatchObject({ status: "failed", pipelineId: "13" });
  });

  test("401 from GitLab marks the repo credential_invalid and notifies maintainers (once)", async () => {
    const [r] = await t.s.db.root.select().from(repo).where(eq(repo.id, repoId));
    await t.s.repos.onAuthError(r!, new ScmAuthError("x"));
    await t.s.repos.onAuthError({ ...r!, status: "credential_invalid" }, new ScmAuthError("x"));
    const [after] = await t.s.db.root.select().from(repo).where(eq(repo.id, repoId));
    expect(after!.status).toBe("credential_invalid");
    const evs = await t.s.db.root
      .select()
      .from(event)
      .where(and(eq(event.type, "repo.credential_invalid"), eq(event.aggregateId, repoId)));
    expect(evs).toHaveLength(1);
    void ownerCtx;
  });
});
