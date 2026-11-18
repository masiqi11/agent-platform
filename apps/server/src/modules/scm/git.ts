import { existsSync } from "node:fs";
import { chmod, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRedactionValue } from "../../core/logger";
import { hostRun } from "../sandbox/service";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args[0]} failed (${code}): ${stderr.trim().slice(0, 400)}`);
  }
}

/**
 * Fixed config for every host git call; nothing is persisted into repo config. Hooks and fsmonitor
 * are off: the control plane never runs a program a repository (or an agent) put in place (#8).
 */
const BASE = ["-c", "safe.directory=*", "-c", "init.defaultBranch=main", "-c", "advice.detachedHead=false", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/**
 * Working copies that a sandbox mounts keep their git directory NEXT to the directory, never inside
 * it (#8): the sandbox can write anything under the worktree, so a `.git` there (hooks, config with
 * filters / external diff / sshCommand, or a `gitdir:` pointer elsewhere) would let it steer the
 * host's git. The host addresses these copies only through `--git-dir` / `--work-tree`.
 */
export const gitDirOf = (worktree: string) => `${worktree.replace(/\/+$/, "")}.gitdir`;

/**
 * Host-side git (control plane). Credentials arrive per call through `env` (askpass) and are
 * never written to `.git/config`, logs or the sandbox (INV-17 / §12.7).
 */
export async function git(args: string[], o: { cwd: string; env?: Record<string, string>; timeoutMs?: number; allowFail?: boolean }) {
  // Isolated from the host's global/system git config: no inherited identity, signing keys, helpers or proxies.
  const env = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...o.env };
  const ctl = o.cwd !== "/" ? gitDirOf(o.cwd) : "";
  const sep = ctl && existsSync(ctl) ? ["--git-dir", ctl, "--work-tree", o.cwd] : [];
  const r = await hostRun(["git", ...BASE, ...sep, ...args], { cwd: o.cwd, env, timeoutMs: o.timeoutMs ?? 120_000 });
  if (r.code !== 0 && !o.allowFail) throw new GitError(args, r.code, r.stderr || r.stdout);
  return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

/**
 * One-shot askpass for HTTPS remotes: the token lives only in this process env for one git call,
 * the script reads it from there, and the script file is deleted afterwards.
 */
export async function askpassEnv(token: string, username = "oauth2") {
  addRedactionValue(token);
  const dir = await mkdtemp(join(tmpdir(), "ap-askpass-"));
  const script = join(dir, "askpass.sh");
  await writeFile(script, `#!/bin/sh\ncase "$1" in\n  Username*) echo "${username}" ;;\n  *) printf '%s\\n' "$AP_GIT_TOKEN" ;;\nesac\n`);
  await chmod(script, 0o700);
  return {
    env: { GIT_ASKPASS: script, AP_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Clones a working copy for a sandbox: worktree at `dir`, git directory at `gitDirOf(dir)`. */
export async function cloneWork(src: string, dir: string, o: { env?: Record<string, string>; hardlinks?: boolean } = {}) {
  const ctl = gitDirOf(dir);
  await rm(ctl, { recursive: true, force: true });
  await git(["clone", "-q", ...(o.hardlinks === false ? ["--no-hardlinks"] : []), `--separate-git-dir=${ctl}`, src, dir], { cwd: "/", env: o.env, timeoutMs: 600_000 });
  await refreshSandboxGit(dir);
}

/**
 * Replaces the worktree's `.git` (clone leaves a `gitdir:` pointer to the control directory) with a
 * disposable COPY, so tools inside the sandbox (`git diff/log/show`) work. The host never reads it:
 * its calls carry `--git-dir` explicitly, and `git add` never stages a `.git` entry.
 */
export async function refreshSandboxGit(dir: string) {
  const inner = `${dir.replace(/\/+$/, "")}/.git`;
  await rm(inner, { force: true, recursive: true });
  await cp(gitDirOf(dir), inner, { recursive: true });
}

/** Removes a working copy and its git directory. */
export async function removeWork(dir: string) {
  await rm(dir, { recursive: true, force: true });
  await rm(gitDirOf(dir), { recursive: true, force: true });
}

export const shaRe = /^[0-9a-f]{40}$/;
