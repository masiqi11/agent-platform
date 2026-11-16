import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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

/** Fixed identity/config for every host git call; nothing is persisted into repo config. */
const BASE = ["-c", "safe.directory=*", "-c", "init.defaultBranch=main", "-c", "advice.detachedHead=false"];

/**
 * Host-side git (control plane). Credentials arrive per call through `env` (askpass) and are
 * never written to `.git/config`, logs or the sandbox (INV-17 / §12.7).
 */
export async function git(args: string[], o: { cwd: string; env?: Record<string, string>; timeoutMs?: number; allowFail?: boolean }) {
  // Isolated from the host's global/system git config: no inherited identity, signing keys, helpers or proxies.
  const env = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...o.env };
  const r = await hostRun(["git", ...BASE, ...args], { cwd: o.cwd, env, timeoutMs: o.timeoutMs ?? 120_000 });
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

export const shaRe = /^[0-9a-f]{40}$/;
