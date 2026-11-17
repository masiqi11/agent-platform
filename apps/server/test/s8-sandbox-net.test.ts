import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { PAYMENTS_REPO } from "../src/cli/demo-repos";
import type { Ctx } from "../src/core/context";
import { job, session, sessionTurn, task, workspace } from "../src/db/schema";
import { git } from "../src/modules/scm/git";
import { createTestApp, type TestApp } from "./helpers";

/**
 * S8-1: an external engine in the DOCKER sandbox on the platform network. The container reaches the
 * platform (model proxy + MCP) and nothing else; an unfirewalled host is reported; the firewall
 * script closes it. Needs a docker daemon and the bun base image; skipped otherwise.
 */
const BASE = process.env.SANDBOX_TEST_IMAGE ?? "mirror.gcr.io/oven/bun:1.4.4-alpine";
const IMAGE = "ap-test-fake-pi:local";
const sh = (argv: string[]) => Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
const dockerOk =
  sh(["docker", "image", "inspect", BASE]).exitCode === 0 &&
  sh(["docker", "build", "-q", "-t", IMAGE, "--build-arg", `BASE=${BASE}`, "-f", join(import.meta.dir, "fixtures/harness/Dockerfile.fake-pi"), join(import.meta.dir, "fixtures/harness")]).exitCode ===
    0;
const canFirewall = dockerOk && process.getuid?.() === 0 && sh(["iptables", "-S", "INPUT"]).exitCode === 0;
const NET = `ap-test-sbx-${Date.now().toString(36)}`;

let t: TestApp;
let platform: ReturnType<typeof Bun.serve>;
let upstream: ReturnType<typeof Bun.serve>;
const dataDir = mkdtempSync(join(tmpdir(), "ap-s8net-"));
let owner = "";
let projectId = "";
let devId = "";

async function settle(max = 14) {
  for (let i = 0; i < max; i++) {
    const a = await t.s.consumers.drain();
    const b = await t.s.jobs.drain();
    if (!a && !b) return;
  }
}

describe.skipIf(!dockerOk)("S8-1 external engine in the docker sandbox, platform network only", () => {
  beforeAll(async () => {
    upstream = Bun.serve({ port: 0, fetch: () => Response.json({ choices: [{ message: { role: "assistant", content: "看 gateway.ts" } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }) });
    t = await createTestApp("s8net", { DATA_DIR: dataDir, SANDBOX: "docker", SANDBOX_IMAGE: IMAGE, SANDBOX_NETWORK: NET, HARNESS_PI_BIN: "bun /opt/fake-pi.ts" });
    platform = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: (r) => t.app.handle(r) });
    t.s.config.sandbox.platformPort = platform.port!;
    owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "N", email: "o@n.test", name: "王负责人", password: "Correct-Horse-42" } })).body.token;
    const ctx: Ctx = await t.s.identity.authenticate(new Headers({ authorization: `Bearer ${owner}` }), "trc_s8net");
    projectId = (await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "PAY", name: "支付服务" } })).body.id;
    await t.req("POST", "/api/v1/admin/models/providers", {
      token: owner,
      body: {
        name: "中转",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        dialect: "openai",
        isExternal: true,
        apiKey: "sk-upstream-net-test-000001",
        apis: ["chat"],
        models: [{ name: "relay-model" }],
      },
    });
    devId = (await t.req("POST", `/api/v1/projects/${projectId}/agents`, { token: owner, body: { name: "开发 · 小码", role: "dev", engine: "pi", modelPolicy: { primary: "relay-model" } } })).body.id;
    await t.s.repos.bind(ctx, projectId, { provider: "local", name: "payments", files: PAYMENTS_REPO, testCommand: "bun test" });
    const { registerHandlers } = await import("../src/modules/registry");
    await registerHandlers(t.s);
    await t.s.consumers.init();
    await t.s.db.root.delete(job).where(sql`${job.cron} is not null`);
  });
  afterAll(async () => {
    void platform?.stop(true);
    void upstream?.stop(true);
    await t?.close();
    const id = sh(["docker", "network", "inspect", "-f", "{{.Id}}", NET]).stdout.toString().trim();
    if (id && canFirewall) sh(["iptables", "-D", "INPUT", "-i", `br-${id.slice(0, 12)}`, "-j", "AP-SANDBOX"]);
    sh(["docker", "network", "rm", NET]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("the harness runs in a container: model via the proxy, tools via MCP, no other network; the platform does the git side", async () => {
    const tk = await t.req("POST", "/api/v1/tasks", {
      token: owner,
      body: { projectId, title: "排查支付服务超时", description: "支付服务偶发超时。[fake:probe]", acceptanceCriteria: ["调用网关的超时小于上游网关超时"], assigneeAgentId: devId },
    });
    await t.req("POST", `/api/v1/tasks/${tk.body.id}/transition`, { token: owner, body: { to: "ready" } });
    await settle();
    const [row] = await t.s.db.root.select().from(task).where(eq(task.id, tk.body.id));
    expect(row!.status).toBe("in_review");
    const [ws] = await t.s.db.root.select().from(workspace).where(eq(workspace.taskId, tk.body.id));
    const repoUrl = (await t.s.repos.projectRepos(projectId))[0]!.url;
    expect((await git(["show", `${ws!.branch}:src/gateway.ts`], { cwd: repoUrl })).out).toContain("= 3_000");
    const [ses] = await t.s.db.root.select().from(session).where(eq(session.scopeId, tk.body.id));
    const text = (await t.s.db.root.select().from(sessionTurn).where(eq(sessionTurn.sessionId, ses!.id))).map((x) => x.content).join("\n");
    expect(text).toContain("可用平台工具："); // MCP over the platform network
    expect(text).toContain("看 gateway.ts"); // model via the proxy
    expect(text).toContain("外网探测：blocked"); // nothing else
  });

  test("an unfirewalled host is reported; the firewall script closes it", async () => {
    const before = await t.s.sandbox.available();
    expect(before.ok).toBe(true);
    expect(before.detail).toContain(NET);
    expect(before.warning).toContain("sandbox-firewall.sh");
    if (!canFirewall) return; // needs root + iptables (CI runners: no)
    const run = Bun.spawnSync(["bash", join(import.meta.dir, "../../../deploy/sandbox-firewall.sh")], {
      env: { ...process.env, SANDBOX_NETWORK: NET, PORT: String(platform.port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    const after = await t.s.sandbox.available();
    expect(after.warning).toBeUndefined();
  });
});

describe("S8-1 image sources (SBX-09)", () => {
  test("the docker sandbox refuses an image outside SANDBOX_IMAGE_ALLOW before starting anything", async () => {
    const { createDockerSandbox } = await import("../src/modules/sandbox/service");
    const sb = createDockerSandbox({ image: "docker.io/someone/miner:latest", timeoutMs: 5_000, imageAllow: ["registry.internal/", "mirror.gcr.io/oven/"], dockerBin: "/nonexistent/docker" });
    await expect(sb.exec({ cwd: tmpdir(), cmd: "true" })).rejects.toThrow("不在允许的来源内");
  });
});
