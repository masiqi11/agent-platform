import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { PAYMENTS_REPO } from "../src/cli/demo-repos";
import type { Ctx } from "../src/core/context";
import { artifact, auditLog, event, job, localScmIssue, localScmMr, session, sessionTurn, task, workspace } from "../src/db/schema";
import { git } from "../src/modules/scm/git";
import { createTestApp, type TestApp } from "./helpers";

process.env.LLM_BACKOFF_MS = "2";
let t: TestApp;
const PW = "Correct-Horse-42";
const dataDir = mkdtempSync(join(tmpdir(), "ap-s5-"));
let owner = "";
let ownerPrincipal = "";
let ownerCtx: Ctx;
let projectId = "";
let groupId = "";
let dev: { id: string; principalId: string; name: string };
let repoUrl = "";

/** Scheduling cycles until nothing is left to run (consumers ⇄ jobs, CI → wake → turn). */
async function settle(max = 12) {
  for (let i = 0; i < max; i++) {
    const a = await t.s.consumers.drain();
    const b = await t.s.jobs.drain();
    if (!a && !b) return;
  }
}
const evs = async (type: string, taskId: string) =>
  (await t.s.db.root.select().from(event).where(eq(event.type, type))).filter((e) => (e.payload as { taskId?: string }).taskId === taskId || e.aggregateId === taskId);

async function newTask(title: string) {
  const r = await t.req("POST", "/api/v1/tasks", {
    token: owner,
    body: {
      projectId,
      title,
      description: "支付服务下单接口最近偶发超时，用户等待很久后失败。",
      acceptanceCriteria: ["调用网关的超时小于上游网关超时", "仓库测试全部通过"],
      assigneeAgentId: dev.id,
      groupId,
    },
  });
  expect(r.status).toBe(200);
  return r.body as { id: string; ref: string; status: string };
}

beforeAll(async () => {
  t = await createTestApp("s5dev", { DATA_DIR: dataDir, SANDBOX: "process" });
  const setup = await t.req("POST", "/api/v1/setup", { body: { tenantName: "S5", email: "o@s5.test", name: "王负责人", password: PW } });
  owner = setup.body.token;
  ownerPrincipal = (await t.req("GET", "/api/v1/me", { token: owner })).body.principalId;
  ownerCtx = await t.s.identity.authenticate(new Headers({ authorization: `Bearer ${owner}` }), "trc_s5");
  const p = await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "PAY", name: "支付服务", description: "支付网关" } });
  projectId = p.body.id;
  groupId = p.body.mainGroupId;
  dev = (await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name: "开发 A", role: "dev" } })).body;
  const bound = await t.s.repos.bind(ownerCtx, projectId, { provider: "local", name: "payments", files: PAYMENTS_REPO, testCommand: "bun test" });
  expect(bound.check.ok).toBe(true);
  expect(bound.check.defaultBranchProtected).toBe(true);
  repoUrl = bound.repo.url;
  const { registerHandlers } = await import("../src/modules/registry");
  await registerHandlers(t.s);
  await t.s.consumers.init();
  await t.s.db.root.delete(job).where(sql`${job.cron} is not null`);
});
afterAll(async () => {
  await t?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("S5 dev agent — exit scenario (scripted model + local SCM)", () => {
  let taskId = "";
  test("assignment → workspace → fix → commit → push → MR → CI → in_review", async () => {
    const tk = await newTask("排查支付服务超时");
    taskId = tk.id;
    expect(tk.status).toBe("backlog");
    const ready = await t.req("POST", `/api/v1/tasks/${tk.id}/transition`, { token: owner, body: { to: "ready" } });
    expect(ready.status).toBe(200);
    await settle();

    const [row] = await t.s.db.root.select().from(task).where(eq(task.id, tk.id));
    expect(row!.status).toBe("in_review");
    expect(row!.testPlan).toMatchObject({ draftBy: dev.id });

    const [ws] = await t.s.db.root.select().from(workspace).where(eq(workspace.taskId, tk.id));
    expect(ws!.branch).toBe("task/1");
    expect(ws!.mrRef).toBe("!1");
    expect(ws!.ci).toMatchObject({ status: "success", sha: ws!.headCommit });
    expect(ws!.diffStat).toMatchObject({ files: 1, paths: ["src/gateway.ts"], humanReviewRequired: false });

    // The fix landed on the task branch, authored by the agent with task + owner trailers (GIT-补1).
    const show = await git(["log", "-1", "--format=%an|%ae|%B", "task/1"], { cwd: repoUrl });
    const [an, ae, body] = show.out.split("|");
    expect(an).toBe("开发 A");
    expect(ae).toBe(`${dev.id}@agents.localhost`);
    expect(body).toContain("Task: PAY-1");
    expect(body).toContain("Co-authored-by: 王负责人 <o@s5.test>");
    const file = await git(["show", "task/1:src/gateway.ts"], { cwd: repoUrl });
    expect(file.out).toContain("GATEWAY_CALL_TIMEOUT_MS = 3_000");
    // INV-10: the default branch is untouched.
    expect((await git(["show", "main:src/gateway.ts"], { cwd: repoUrl })).out).toContain("30_000");

    // INV-05: change ↔ workspace, branch, MR and test evidence (patch + CI log artifacts).
    const arts = await t.s.db.root.select().from(artifact).where(eq(artifact.taskId, tk.id));
    expect(arts.map((a) => a.kind).sort()).toEqual(["log", "patch"]);
    const ciLog = readFileSync(join(dataDir, "artifacts", arts.find((a) => a.kind === "log")!.uri.replace("local://", "")), "utf8");
    expect(ciLog).toContain("[exit 0]");
    const mrs = await t.s.db.root.select().from(localScmMr).where(eq(localScmMr.repoPath, repoUrl));
    expect(mrs).toHaveLength(1);
    expect(mrs[0]!.description).toContain("PAY-1");
    expect(mrs[0]!.description).toContain("- [ ] 调用网关的超时小于上游网关超时");

    // Issue sync (platform_wins, convergent): one issue with status label.
    const issues = await t.s.db.root.select().from(localScmIssue).where(eq(localScmIssue.repoPath, repoUrl));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.labels).toContain("status::评审中");
    expect(row!.issueRef).toBe("#1");

    // Session: task scope, transcript incl. the context package (SES-补4/5), tool audits.
    const [ses] = await t.s.db.root
      .select()
      .from(session)
      .where(and(eq(session.scopeType, "task"), eq(session.scopeId, tk.id)));
    expect(ses!.status).toBe("idle");
    const turns = await t.s.db.root.select().from(sessionTurn).where(eq(sessionTurn.sessionId, ses!.id));
    expect(turns.some((x) => x.role === "context" && x.contextPackage)).toBe(true);
    const audits = await t.s.db.root
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} like 'tool.%'`);
    for (const tool of ["tool.run_command", "tool.write_file", "tool.commit", "tool.push", "tool.open_merge_request", "tool.request_review"]) expect(audits.some((a) => a.action === tool)).toBe(true);
  });

  test("TRAP-5: created+assigned+ready wakes the dev agent exactly once for the assignment", async () => {
    const wakes = (await evs("wake.requested", taskId)).filter((e) => (e.payload as { kind: string }).kind === "task_assigned");
    expect(wakes).toHaveLength(1);
    const sessions = await t.s.db.root
      .select()
      .from(session)
      .where(and(eq(session.scopeType, "task"), eq(session.scopeId, taskId)));
    expect(sessions).toHaveLength(1);
    // Re-delivering the same events does not wake again.
    const ready = (await evs("task.status_changed", taskId)).find((e) => (e.payload as { to: string }).to === "ready")!;
    await t.s.devAgent.consumer.handle({ ...ready, payload: ready.payload, type: "task.status_changed", aggregateType: "task", occurredAt: "", idempotencyKey: undefined } as never);
    await settle();
    expect((await evs("wake.requested", taskId)).filter((e) => (e.payload as { kind: string }).kind === "task_assigned")).toHaveLength(1);
  });

  test("INV-17: no credentials reach the sandbox env or the model context", async () => {
    const [ses] = await t.s.db.root
      .select()
      .from(session)
      .where(and(eq(session.scopeType, "task"), eq(session.scopeId, taskId)));
    const turns = await t.s.db.root.select().from(sessionTurn).where(eq(sessionTurn.sessionId, ses!.id));
    const all = JSON.stringify(turns);
    for (const secret of [t.s.config.jwt.secret, t.s.config.auth.secret, t.s.config.masterKeys[1]!, t.url]) expect(all).not.toContain(secret);
    const ws = (await t.s.db.root.select().from(workspace).where(eq(workspace.taskId, taskId)))[0]!;
    const remotes = await git(["remote", "-v"], { cwd: ws.worktreePath! });
    expect(remotes.out).not.toMatch(/token|@/i);
  });
});

describe("S5 dev agent — crash recovery (SES-补2)", () => {
  test("worker dies after push and after MR: resume neither re-pushes nor opens a second MR", async () => {
    const tk = await newTask("修复下单超时（崩溃恢复）");
    let crashes = 0;
    t.s.devAgent.hooks.afterTool = (name) => {
      if ((name === "push" && crashes === 0) || (name === "open_merge_request" && crashes === 1)) {
        crashes++;
        throw new Error("simulated worker crash");
      }
    };
    await t.req("POST", `/api/v1/tasks/${tk.id}/transition`, { token: owner, body: { to: "ready" } });
    await settle(3);
    expect(crashes).toBe(1);
    const [ws1] = await t.s.db.root.select().from(workspace).where(eq(workspace.taskId, tk.id));
    expect(await evs("commit.pushed", tk.id)).toHaveLength(1);
    // Crash happened before the checkpoint was durable: forget it, and let the lease expire.
    const [s1] = await t.s.db.root
      .select()
      .from(session)
      .where(and(eq(session.scopeType, "task"), eq(session.scopeId, tk.id)));
    expect(s1!.status).toBe("running");
    const expire = () =>
      t.s.db.root.execute(sql`update session set lease_owner = 'dead-worker', heartbeat_at = now() - interval '1 hour', checkpoint = checkpoint - 'pushedSha' - 'mr' where id = ${s1!.id}`);
    const rerun = () => t.s.db.root.execute(sql`update job set run_at = now() where type = 'dev.turn' and status = 'queued'`);
    await expire();
    await rerun();
    await settle(3);
    expect(crashes).toBe(2);
    // Crash #2 right after the MR call: drop the stored MR ref too, as if the write was lost.
    await t.s.db.root.update(workspace).set({ mrRef: null, mrUrl: null }).where(eq(workspace.id, ws1!.id));
    await expire();
    await rerun();
    t.s.devAgent.hooks.afterTool = undefined;
    await settle();

    const [row] = await t.s.db.root.select().from(task).where(eq(task.id, tk.id));
    expect(row!.status).toBe("in_review");
    expect(await evs("commit.pushed", tk.id)).toHaveLength(1);
    const [ws] = await t.s.db.root.select().from(workspace).where(eq(workspace.taskId, tk.id));
    expect(ws!.branch).toBe("task/2");
    const mrs = (await t.s.db.root.select().from(localScmMr).where(eq(localScmMr.repoPath, repoUrl))).filter((m) => m.sourceBranch === "task/2");
    expect(mrs).toHaveLength(1);
    expect(await evs("mr.opened", tk.id)).toHaveLength(1);
    const sessions = await t.s.db.root
      .select()
      .from(session)
      .where(and(eq(session.scopeType, "task"), eq(session.scopeId, tk.id)));
    expect(sessions).toHaveLength(1);
  });
});

describe("S5 dev agent — guards", () => {
  test("INV-10: pushing the default branch is refused (platform) and the repo hook refuses it too", async () => {
    const tk = await newTask("越权推送测试");
    const [r] = await t.s.repos.projectRepos(projectId);
    const tr = (await t.s.db.root.select().from(task).where(eq(task.id, tk.id)))[0]!;
    const ws = await t.s.workspaces.ensure(ownerCtx, tr, r!);
    await git(["checkout", "-q", "-B", "main", "origin/main"], { cwd: ws.worktreePath! });
    await expect(t.s.workspaces.push(ownerCtx, ws, tr)).rejects.toThrow("INV-10");
    const denied = await t.s.db.root
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "workspace.push"), eq(auditLog.outcome, "denied")));
    expect(denied.length).toBeGreaterThan(0);
    // Repo side (GIT-补2): even a raw git push of a new commit to main is rejected by the pre-receive hook.
    await Bun.write(join(ws.worktreePath!, "x.txt"), "x");
    await git(["add", "-A"], { cwd: ws.worktreePath! });
    await git(["-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qm", "x"], { cwd: ws.worktreePath! });
    const raw = await git(["push", repoUrl, "HEAD:refs/heads/main"], { cwd: ws.worktreePath!, allowFail: true });
    expect(raw.ok).toBe(false);
    expect(raw.err).toContain("只能由合并队列更新");
    await t.req("POST", `/api/v1/tasks/${tk.id}/transition`, { token: owner, body: { to: "cancelled", reason: "测试结束" } });
    await settle();
  });

  test("GIT-补8: a diff containing a secret is never pushed; the task is blocked", async () => {
    const tk = await newTask("密钥扫描测试");
    await t.req("POST", `/api/v1/tasks/${tk.id}/transition`, { token: owner, body: { to: "ready" } });
    const [r] = await t.s.repos.projectRepos(projectId);
    let tr = (await t.s.db.root.select().from(task).where(eq(task.id, tk.id)))[0]!;
    // Pause wakes for this test: drive the workspace directly.
    await t.s.db.root.delete(job).where(eq(job.type, "dev.turn"));
    const ws = await t.s.workspaces.ensure(ownerCtx, tr, r!);
    await Bun.write(join(ws.worktreePath!, "src/config.ts"), `export const key = "glpat-${"x".repeat(24)}";\n`);
    const a = (await t.s.db.root.select().from(session).limit(0)) && (await t.s.agents.raw(ownerCtx, dev.id));
    tr = (await t.s.db.root.select().from(task).where(eq(task.id, tk.id)))[0]!;
    await t.s.workspaces.commit(ownerCtx, (await t.s.workspaces.load(ws.id))!, a, tr, "add config");
    await expect(t.s.workspaces.push(ownerCtx, await t.s.workspaces.load(ws.id), tr)).rejects.toThrow("密钥");
    const remote = await git(["show-ref", "--verify", "--quiet", "refs/heads/task/4"], { cwd: repoUrl, allowFail: true });
    expect(remote.ok).toBe(false);
  });

  test("GIT-补7: sensitive paths / large changes require human review", async () => {
    const { scopeGuard } = await import("../src/modules/workspaces/service");
    const s = { sensitivePaths: [".gitlab-ci.yml", "deploy/", "package.json"], changeLimits: { files: 3, lines: 100 } };
    expect(scopeGuard({ files: 1, additions: 2, deletions: 1, paths: ["src/a.ts"] }, s).humanReviewRequired).toBe(false);
    expect(scopeGuard({ files: 1, additions: 2, deletions: 0, paths: [".gitlab-ci.yml"] }, s).reasons[0]).toContain("敏感路径");
    expect(scopeGuard({ files: 1, additions: 2, deletions: 0, paths: ["deploy/k8s.yaml"] }, s).humanReviewRequired).toBe(true);
    expect(scopeGuard({ files: 4, additions: 2, deletions: 0, paths: ["a", "b", "c", "d"] }, s).reasons[0]).toContain("文件数");
    expect(scopeGuard({ files: 1, additions: 90, deletions: 20, paths: ["a"] }, s).reasons[0]).toContain("行数");
  });

  test("branch naming: a taken branch name gets a suffix (FR-GIT-02)", async () => {
    const tk = await newTask("分支冲突测试");
    const tr = (await t.s.db.root.select().from(task).where(eq(task.id, tk.id)))[0]!;
    // Someone else already pushed task/<n> for an unrelated reason.
    const tmp = mkdtempSync(join(tmpdir(), "ap-br-"));
    await git(["clone", "-q", repoUrl, tmp], { cwd: "/" });
    await git(["push", "-q", repoUrl, `HEAD:refs/heads/task/${tr.number}`], { cwd: tmp });
    const [r] = await t.s.repos.projectRepos(projectId);
    const ws = await t.s.workspaces.ensure(ownerCtx, tr, r!);
    expect(ws.branch).toBe(`task/${tr.number}-2`);
    // Idempotent per (task, repo).
    expect((await t.s.workspaces.ensure(ownerCtx, tr, r!)).id).toBe(ws.id);
  });

  test("human takeover ends the session and stops wakes; hand-back wakes the agent again (AGT-补3)", async () => {
    const tk = await newTask("接管测试");
    await t.req("POST", `/api/v1/tasks/${tk.id}/transition`, { token: owner, body: { to: "ready" } });
    await t.s.consumers.drain();
    const take = await t.req("POST", `/api/v1/tasks/${tk.id}/takeover`, { token: owner, body: { reason: "我自己来改" } });
    expect(take.status).toBe(200);
    await settle();
    const [row] = await t.s.db.root.select().from(task).where(eq(task.id, tk.id));
    expect(row!.takenOverBy).toBe(ownerPrincipal);
    expect(row!.status).toBe("ready"); // the agent never started
    expect(await evs("task.takeover", tk.id)).toHaveLength(1);
    const back = await t.req("POST", `/api/v1/tasks/${tk.id}/handback`, { token: owner });
    expect(back.status).toBe(200);
    await settle();
    const [after] = await t.s.db.root.select().from(task).where(eq(task.id, tk.id));
    expect(after!.status).toBe("in_review");
  });

  test("cancel cleanup (TSK-补2): MR closed, branch kept, workspace released, issue closed", async () => {
    const tk = (
      await t.s.db.root
        .select({ tk: task })
        .from(task)
        .innerJoin(workspace, eq(workspace.taskId, task.id))
        .where(and(eq(task.status, "in_review"), sql`${workspace.mrRef} is not null`))
        .limit(1)
    )[0]!.tk;
    const res = await t.req("POST", `/api/v1/tasks/${tk.id}/transition`, { token: owner, body: { to: "cancelled", reason: "需求取消" } });
    expect(res.status).toBe(200);
    await settle();
    const [ws] = await t.s.db.root.select().from(workspace).where(eq(workspace.taskId, tk.id));
    expect(ws!.status).toBe("released");
    const [mr] = await t.s.db.root
      .select()
      .from(localScmMr)
      .where(and(eq(localScmMr.repoPath, repoUrl), eq(localScmMr.sourceBranch, ws!.branch)));
    expect(mr!.state).toBe("closed");
    expect((await git(["show-ref", "--verify", "--quiet", `refs/heads/${ws!.branch}`], { cwd: repoUrl, allowFail: true })).ok).toBe(true);
    const [row] = await t.s.db.root.select().from(task).where(eq(task.id, tk.id));
    const [iss] = await t.s.db.root
      .select()
      .from(localScmIssue)
      .where(and(eq(localScmIssue.repoPath, repoUrl), eq(localScmIssue.iid, Number(row!.issueRef!.slice(1)))));
    expect(iss!.state).toBe("closed");
    expect(iss!.labels).toContain("取消");
  });

  test("code view + agent load + system status endpoints", async () => {
    const tk = (
      await t.s.db.root
        .select({ tk: task })
        .from(task)
        .innerJoin(workspace, eq(workspace.taskId, task.id))
        .where(and(eq(task.status, "in_review"), sql`${workspace.mrRef} is not null`))
        .limit(1)
    )[0]!.tk;
    const code = await t.req("GET", `/api/v1/tasks/${tk.id}/code`, { token: owner });
    expect(code.status).toBe(200);
    expect(code.body.workspaces[0].mrRef).toMatch(/^!/);
    expect(code.body.cost.calls).toBeGreaterThan(0);
    const load = await t.req("GET", `/api/v1/projects/${projectId}/agents/load`, { token: owner });
    expect(load.status).toBe(200);
    expect(load.body.find((x: { agentId: string }) => x.agentId === dev.id).recentTasks.length).toBeGreaterThan(0);
    const sys = await t.req("GET", "/api/v1/admin/system", { token: owner });
    expect(sys.status).toBe(200);
    expect(sys.body.sandbox.kind).toBe("process");
    expect(sys.body.migration.current).toBe(sys.body.migration.expected);
  });
});
