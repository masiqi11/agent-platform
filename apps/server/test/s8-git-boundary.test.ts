import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneWork, git, gitDirOf, refreshSandboxGit, removeWork } from "../src/modules/scm/git";
import { hostRun } from "../src/modules/sandbox/service";

/**
 * Issue #8 (P1): the sandbox mounts the worktree read-write, so anything under it is the agent's.
 * The control plane's git must never execute a program the agent planted: hooks, fsmonitor, filter
 * drivers, external diff, or a `.git` that points the host at another repository.
 */
let root = "";
let origin = "";
let work = "";
const marker = (n: string) => join(root, `pwned-${n}`);
const evil = async (n: string) => {
  const p = join(root, `evil-${n}.sh`);
  await writeFile(p, `#!/bin/sh\ntouch ${marker(n)}\ncat\n`);
  await chmod(p, 0o755);
  return p;
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ap-gitb-"));
  const seed = join(root, "seed");
  await mkdir(seed);
  await git(["init", "-q", "-b", "main"], { cwd: seed });
  await writeFile(join(seed, "a.txt"), "one\n");
  await git(["add", "-A"], { cwd: seed });
  await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: seed });
  origin = join(root, "origin.git");
  await git(["clone", "-q", "--bare", seed, origin], { cwd: "/" });
  work = join(root, "ws", "repo");
  await mkdir(join(root, "ws"));
  await cloneWork(origin, work, { hardlinks: false });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("#8 control-plane git vs. a writable sandbox worktree", () => {
  test("the git directory lives outside the mounted worktree; the sandbox gets a disposable copy", async () => {
    expect(existsSync(gitDirOf(work))).toBe(true);
    expect(existsSync(join(work, ".git", "HEAD"))).toBe(true); // a real directory copy, not a pointer
    // inside the sandbox, plain git works on the copy (reviewers use git diff/log/show)
    const r = await hostRun(["git", "-c", "safe.directory=*", "log", "--oneline"], { cwd: work, env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, timeoutMs: 10_000 });
    expect(r.stdout).toContain("init");
  });

  test("hooks, fsmonitor, filters, external diff and a redirected gitdir planted by the sandbox never run on the host", async () => {
    const inner = join(work, ".git");
    // 1) hooks in the worktree's .git
    await mkdir(join(inner, "hooks"), { recursive: true });
    for (const h of ["pre-commit", "commit-msg", "post-commit", "reference-transaction", "pre-push"]) {
      const p = join(inner, "hooks", h);
      await writeFile(p, `#!/bin/sh\ntouch ${marker(`hook-${h}`)}\n`);
      await chmod(p, 0o755);
    }
    // 2) local config with every execution entry point we know of
    await writeFile(
      join(inner, "config"),
      `[core]\n\tfsmonitor = ${await evil("fsmonitor")}\n\thooksPath = ${join(inner, "hooks")}\n\tsshCommand = ${await evil("ssh")}\n[filter "x"]\n\tclean = ${await evil("clean")}\n\tsmudge = ${await evil("smudge")}\n[diff]\n\texternal = ${await evil("diff")}\n`,
    );
    await writeFile(join(work, ".gitattributes"), "* filter=x\n");
    // 3) the agent edits a file and the platform commits it
    await writeFile(join(work, "a.txt"), "two\n");
    await git(["add", "-A"], { cwd: work });
    await git(["diff", "--cached", "--stat"], { cwd: work });
    await git(["-c", "user.name=agent", "-c", "user.email=a@a", "commit", "-q", "-m", "fix"], { cwd: work });
    await git(["diff", "HEAD~1..HEAD"], { cwd: work });
    for (const n of ["hook-pre-commit", "hook-commit-msg", "hook-post-commit", "hook-reference-transaction", "fsmonitor", "clean", "smudge", "diff"]) expect(existsSync(marker(n))).toBe(false);
    // the commit is in the control repo, not in the sandbox's copy
    const log = await git(["log", "--format=%s", "-2"], { cwd: work });
    expect(log.out.split("\n")).toEqual(["fix", "init"]);
  });

  test("a hook in the control git dir is not run either (hooks are off for every host call)", async () => {
    const p = join(gitDirOf(work), "hooks", "pre-commit");
    await mkdir(join(gitDirOf(work), "hooks"), { recursive: true });
    await writeFile(p, `#!/bin/sh\ntouch ${marker("ctl-hook")}\n`);
    await chmod(p, 0o755);
    await writeFile(join(work, "b.txt"), "b\n");
    await git(["add", "-A"], { cwd: work });
    await git(["-c", "user.name=agent", "-c", "user.email=a@a", "commit", "-q", "-m", "b"], { cwd: work });
    expect(existsSync(marker("ctl-hook"))).toBe(false);
  });

  test("replacing .git with a `gitdir:` pointer to another repo does not redirect host git", async () => {
    const other = join(root, "other");
    await mkdir(other);
    await git(["init", "-q", "-b", "main"], { cwd: other });
    await removeWork(join(root, "ws", "unused")); // no-op on a missing dir
    await refreshSandboxGit(work);
    rmSync(join(work, ".git"), { recursive: true, force: true });
    await writeFile(join(work, ".git"), `gitdir: ${join(other, ".git")}\n`);
    await writeFile(join(work, "c.txt"), "c\n");
    await git(["add", "-A"], { cwd: work });
    await git(["-c", "user.name=agent", "-c", "user.email=a@a", "commit", "-q", "-m", "c"], { cwd: work });
    expect((await git(["log", "--format=%s", "-1"], { cwd: work })).out).toBe("c");
    const otherLog = await git(["log", "--oneline"], { cwd: other, allowFail: true });
    expect(otherLog.ok).toBe(false); // still no commits there
  });
});
