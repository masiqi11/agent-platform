import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInWorkspace } from "../src/modules/sandbox/paths";
import { OUTPUT_CAP, createDockerSandbox, createProcessSandbox, sandboxEnv } from "../src/modules/sandbox/service";

const tmp = () => mkdtempSync(join(tmpdir(), "ap-sbx-"));

describe("S5 sandbox — process (V6)", () => {
  const sb = createProcessSandbox(10_000);

  test("V6: timeout kills the whole process group, grandchildren included (SBX-05)", async () => {
    const dir = tmp();
    // The grandchild would write the marker after 2 s if it survived the group kill.
    const r = await sb.exec({ cwd: dir, cmd: `(sleep 2; touch ${dir}/survived) & sleep 30`, timeoutMs: 400 });
    expect(r.killed).toBe("timeout");
    expect(r.code).toBeNull();
    expect(r.durationMs).toBeLessThan(5_000);
    await Bun.sleep(2_500);
    expect(existsSync(join(dir, "survived"))).toBe(false);
  });

  test("V6: large output is streamed and truncated at the cap; full log kept separately (SBX-06)", async () => {
    const r = await sb.exec({ cwd: tmp(), cmd: "yes 0123456789 | head -c 3000000" });
    expect(r.code).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBe(OUTPUT_CAP);
    expect(r.log.length).toBe(3_000_000);
  });

  test("INV-17 / SBX-07: credentials never enter the sandbox env", async () => {
    process.env.GITLAB_TOKEN_FOR_TEST = "glpat-should-not-leak";
    const r = await sb.exec({ cwd: tmp(), cmd: "env", env: { MY_API_KEY: "x", DB_PASSWORD: "y", FOO: "ok", GITLAB_TOKEN: "z" } });
    expect(r.stdout).toContain("FOO=ok");
    for (const bad of ["glpat-should-not-leak", "MY_API_KEY", "DB_PASSWORD", "GITLAB_TOKEN", "DATABASE_URL", "MASTER_KEY", "JWT_SECRET"]) expect(r.stdout).not.toContain(bad);
    expect(Object.keys(sandboxEnv("/h", { AUTH_HEADER: "x", SESSION_ID: "y" }))).not.toContain("AUTH_HEADER");
  });

  test("exit codes and stderr are reported", async () => {
    const r = await sb.exec({ cwd: tmp(), cmd: "echo oops >&2; exit 3" });
    expect(r.code).toBe(3);
    expect(r.stderr.trim()).toBe("oops");
    expect(r.killed).toBeNull();
  });
});

describe("S5 sandbox — workspace path validation (SBX-08)", () => {
  test("relative, absolute (/workspace/…), traversal, symlink escape, .git", () => {
    const root = tmp();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "x");
    expect(resolveInWorkspace(root, "src/a.ts").endsWith("/src/a.ts")).toBe(true);
    expect(resolveInWorkspace(root, "/workspace/src/a.ts").endsWith("/src/a.ts")).toBe(true);
    expect(resolveInWorkspace(root, "src/new/dir/b.ts").endsWith("/src/new/dir/b.ts")).toBe(true);
    expect(() => resolveInWorkspace(root, "../etc/passwd")).toThrow("超出工作区");
    expect(() => resolveInWorkspace(root, "src/../../x")).toThrow("超出工作区");
    symlinkSync("/etc", join(root, "link"));
    expect(() => resolveInWorkspace(root, "link/passwd")).toThrow("符号链接");
    expect(() => resolveInWorkspace(root, "link/new-file")).toThrow("符号链接");
    expect(() => resolveInWorkspace(root, ".git/config")).toThrow(".git");
  });
});

// Real docker run (SBX-02). Runs only where a daemon and the image are present; otherwise skipped
// and recorded as "已实现、未经真机验证" for that environment.
const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? "mirror.gcr.io/oven/bun:1.4.4-alpine";
const docker = createDockerSandbox({ image: IMAGE, timeoutMs: 30_000 });
const dockerOk = (await docker.available()).ok;

describe.skipIf(!dockerOk)("S5 sandbox — docker (real daemon)", () => {
  test("non-root, read-only root, no network, writable workspace, image digest recorded", async () => {
    const dir = tmp();
    const r = await docker.exec({ cwd: dir, cmd: "id -u; touch /x 2>&1 || true; echo hi > out.txt && cat out.txt; wget -q -T 2 http://example.com 2>&1 || echo NO_NET; bun --version" });
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).not.toBe("0");
    expect(r.stdout).toContain("Read-only file system");
    expect(r.stdout).toContain("hi");
    expect(r.stdout).toContain("NO_NET");
    expect(r.imageDigest).toMatch(/^sha256:/);
    expect(existsSync(join(dir, "out.txt"))).toBe(true);
  });

  test("timeout removes the container", async () => {
    const r = await docker.exec({ cwd: tmp(), cmd: "sleep 60", timeoutMs: 1500 });
    expect(r.killed).toBe("timeout");
    await Bun.sleep(500);
    const ps = Bun.spawnSync(["docker", "ps", "-q", "--filter", "label=ap.sandbox=1"]);
    expect(ps.stdout.toString().trim()).toBe("");
  });
});
