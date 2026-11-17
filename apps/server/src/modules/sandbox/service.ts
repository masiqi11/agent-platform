import { existsSync } from "node:fs";
import { chmod, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { newId } from "../../core/ids";
import { log } from "../../core/logger";
import type { Config } from "../../config";
import { metrics } from "../../core/metrics";

/** Output kept in the result per stream (SBX-06); the full log (up to LOG_CAP) goes to the object store. */
export const OUTPUT_CAP = 1_000_000;
export const LOG_CAP = 10_000_000;

export interface ExecRequest {
  /** Host path of the workspace (mounted at /workspace in docker). */
  cwd: string;
  /** Shell command line (`sh -c`). */
  cmd: string;
  timeoutMs?: number;
  /** Extra non-secret env; keys that look like credentials are dropped (SBX-07 / INV-17). */
  env?: Record<string, string>;
  /**
   * Session-scoped tokens only (ADR-0010): an agent session token for the platform model proxy and
   * MCP endpoint — short-lived, bound to one session, revoked with the agent. Never a provider key
   * or a repository credential; those never enter the sandbox (INV-17).
   */
  sessionEnv?: Record<string, string>;
  /** Live stdout (e.g. a harness's JSON event stream), in chunks as they arrive. */
  onStdout?: (chunk: string) => void;
  /** Image for the docker sandbox (per repo, SBX-09). */
  image?: string;
  /** Egress allowlist (SBX-03). Empty = no network. */
  egress?: string[];
  limits?: { memoryMb?: number; cpus?: number; pids?: number };
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Combined output, capped at LOG_CAP, for the evidence log. */
  log: string;
  truncated: boolean;
  /** Why the process was killed, if it was (SBX-05). */
  killed: null | "timeout";
  durationMs: number;
  sandbox: "process" | "docker";
  image?: string;
  imageDigest?: string;
}

export interface Sandbox {
  kind: "process" | "docker";
  available(): Promise<{ ok: boolean; detail: string }>;
  exec(req: ExecRequest): Promise<ExecResult>;
  /** Removes leftover containers (SBX-10). Returns how many were removed. */
  sweep(): Promise<number>;
}

const SECRETISH = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE|AUTH|COOKIE|SESSION|MASTER_KEY|DATABASE_URL)/i;

/** Env passed into the sandbox: a fixed minimal base + caller extras minus anything secret-looking. */
export function sandboxEnv(home: string, extra: Record<string, string> = {}, basePath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"): Record<string, string> {
  const env: Record<string, string> = { PATH: basePath, HOME: home, LANG: "C.UTF-8", CI: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const [k, v] of Object.entries(extra)) if (!SECRETISH.test(k) && /^[A-Z_][A-Z0-9_]*$/.test(k)) env[k] = v;
  return env;
}

/** Reads a stream fully, keeping the first `cap` bytes; returns text + whether it was cut. */
async function drain(stream: ReadableStream<Uint8Array> | null | undefined, cap: number, onChunk: (b: Uint8Array) => void) {
  const parts: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  if (!stream) return { text: "", truncated: false };
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    onChunk(chunk);
    if (kept < cap) {
      const slice = chunk.subarray(0, cap - kept);
      parts.push(slice);
      kept += slice.length;
    }
  }
  return { text: Buffer.concat(parts).toString("utf8"), truncated: total > kept };
}

async function run(argv: string[], o: { cwd: string; env: Record<string, string>; timeoutMs: number; onTimeout?: () => Promise<void>; onStdout?: (chunk: string) => void }) {
  const t0 = Date.now();
  const useSetsid = existsSync("/usr/bin/setsid") || existsSync("/bin/setsid");
  // `setsid` makes the child a new process-group leader (it execs in place when the caller is not a
  // group leader), so a timeout can kill the whole group, grandchildren included (V6 / SBX-05).
  const proc = Bun.spawn(useSetsid ? ["setsid", ...argv] : argv, { cwd: o.cwd, env: o.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let killed: ExecResult["killed"] = null;
  const timer = setTimeout(() => {
    killed = "timeout";
    try {
      process.kill(useSetsid ? -proc.pid : proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
    void o.onTimeout?.();
  }, o.timeoutMs);
  const logParts: Uint8Array[] = [];
  let logBytes = 0;
  const tee = (b: Uint8Array) => {
    if (logBytes < LOG_CAP) {
      const s = b.subarray(0, LOG_CAP - logBytes);
      logParts.push(s);
      logBytes += s.length;
    }
  };
  const dec = new TextDecoder();
  const [out, err] = await Promise.all([
    drain(proc.stdout, OUTPUT_CAP, (b) => {
      tee(b);
      if (o.onStdout) o.onStdout(dec.decode(b, { stream: true }));
    }),
    drain(proc.stderr, OUTPUT_CAP, tee),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  // Make sure nothing in the group survives a normal exit either.
  if (useSetsid) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      /* group already gone */
    }
  }
  return {
    code: killed ? null : code,
    stdout: out.text,
    stderr: err.text,
    log: Buffer.concat(logParts).toString("utf8"),
    truncated: out.truncated || err.truncated,
    killed,
    durationMs: Date.now() - t0,
  };
}

/** Development-only sandbox: a plain subprocess in the workspace with a scrubbed env (SBX-01). */
export function createProcessSandbox(defaultTimeoutMs: number): Sandbox {
  return {
    kind: "process",
    async available() {
      return { ok: true, detail: "process（仅开发；无网络隔离与资源限额）" };
    },
    async exec(req) {
      const home = join(req.cwd, ".sandbox-home");
      const r = await run(["sh", "-c", req.cmd], { cwd: req.cwd, env: { ...sandboxEnv(home, req.env), ...req.sessionEnv }, timeoutMs: req.timeoutMs ?? defaultTimeoutMs, onStdout: req.onStdout });
      return { ...r, sandbox: "process" };
    },
    async sweep() {
      return 0;
    },
  };
}

/** Container uid when the host runs as root: files stay writable for both sides via a+rwX. */
const NOBODY = "65532:65532";

/**
 * Production sandbox (SBX-02): non-root, read-only rootfs + writable /workspace, all capabilities
 * dropped, no-new-privileges, pid/memory/cpu limits, no docker socket, no privileged mode, optional
 * gVisor runtime, network off unless the project allowlists egress.
 */
export function createDockerSandbox(cfg: { image?: string; runtime?: string; timeoutMs: number; dockerBin?: string }): Sandbox {
  const docker = cfg.dockerBin ?? "docker";
  const digests = new Map<string, string>();
  async function digestOf(image: string) {
    if (digests.has(image)) return digests.get(image)!;
    const r = await run([docker, "image", "inspect", "--format", "{{.Id}}", image], { cwd: "/", env: { PATH: process.env.PATH ?? "" }, timeoutMs: 15_000 });
    const d = r.code === 0 ? r.stdout.trim() : "";
    if (d) digests.set(image, d);
    return d;
  }
  async function makeWritable(dir: string) {
    // Container runs as an unprivileged uid; widen permissions on the workspace only.
    const walk = async (p: string) => {
      await chmod(p, 0o777).catch(() => undefined);
      for (const e of await readdir(p, { withFileTypes: true }).catch(() => [])) {
        const q = join(p, e.name);
        if (e.isDirectory()) await walk(q);
        else if (e.isFile()) await chmod(q, ((await stat(q)).mode & 0o111 ? 0o777 : 0o666) as number).catch(() => undefined);
      }
    };
    await walk(dir);
  }
  return {
    kind: "docker",
    async available() {
      const r = await run([docker, "version", "--format", "{{.Server.Version}}"], { cwd: "/", env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000 }).catch((e) => ({
        code: 1,
        stdout: "",
        stderr: String(e),
      }));
      if (r.code !== 0) return { ok: false, detail: `docker 不可用：${(r.stderr || r.stdout).trim().slice(0, 200)}` };
      const image = cfg.image ?? "";
      const d = image ? await digestOf(image) : "";
      return { ok: Boolean(d) || !image, detail: `docker ${r.stdout.trim()}${image ? `，镜像 ${image}${d ? "" : "（未拉取）"}` : ""}` };
    },
    async exec(req) {
      const image = req.image ?? cfg.image;
      if (!image) throw new Error("docker 沙箱未配置镜像（SANDBOX_IMAGE 或仓库设置）");
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      const user = uid === 0 ? NOBODY : `${uid}:${process.getgid?.() ?? uid}`;
      if (uid === 0) await makeWritable(req.cwd);
      const name = `ap-sbx-${newId("x").slice(2, 18).toLowerCase()}`;
      const l = req.limits ?? {};
      const env = { ...sandboxEnv("/tmp", req.env, "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"), ...req.sessionEnv };
      if (req.egress?.length) log.warn("sandbox.egress_not_enforced", { note: "allowlist recorded; container still runs with network none" });
      const argv = [
        docker,
        "run",
        "--rm",
        "--name",
        name,
        "--label",
        "ap.sandbox=1",
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,exec,size=256m",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        String(l.pids ?? 256),
        "--memory",
        `${l.memoryMb ?? 1024}m`,
        "--cpus",
        String(l.cpus ?? 2),
        "--user",
        user,
        "-v",
        `${req.cwd}:/workspace`,
        "-w",
        "/workspace",
        ...(cfg.runtime ? ["--runtime", cfg.runtime] : []),
        ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        image,
        "sh",
        "-c",
        req.cmd,
      ];
      const r = await run(argv, {
        cwd: req.cwd,
        onStdout: req.onStdout,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: req.timeoutMs ?? cfg.timeoutMs,
        onTimeout: async () => {
          await run([docker, "rm", "-f", name], { cwd: "/", env: { PATH: process.env.PATH ?? "" }, timeoutMs: 15_000 }).catch(() => undefined);
        },
      });
      return { ...r, sandbox: "docker", image, imageDigest: await digestOf(image) };
    },
    async sweep() {
      const r = await run([docker, "ps", "-aq", "--filter", "label=ap.sandbox=1", "--filter", "status=exited"], { cwd: "/", env: { PATH: process.env.PATH ?? "" }, timeoutMs: 15_000 }).catch(
        () => null,
      );
      const ids = r?.stdout.split("\n").filter(Boolean) ?? [];
      if (ids.length) await run([docker, "rm", "-f", ...ids], { cwd: "/", env: { PATH: process.env.PATH ?? "" }, timeoutMs: 30_000 }).catch(() => undefined);
      return ids.length;
    },
  };
}

export function createSandbox(config: Config): Sandbox {
  const sb = config.sandbox.kind === "docker" ? createDockerSandbox(config.sandbox) : createProcessSandbox(config.sandbox.timeoutMs);
  // §16.1: sandbox executions and timeouts.
  const exec = sb.exec.bind(sb);
  sb.exec = async (req) => {
    const r = await exec(req);
    metrics.sandbox.runs.inc({ kind: sb.kind, outcome: r.killed ? "timeout" : r.code === 0 ? "ok" : "failed" });
    metrics.sandbox.duration.observe({ kind: sb.kind }, r.durationMs / 1000);
    return r;
  };
  return sb;
}

/** Runs a host-side command (git etc.) — NOT a sandbox: used by the control plane only. */
export async function hostRun(argv: string[], o: { cwd: string; env?: Record<string, string>; timeoutMs?: number }) {
  return run(argv, { cwd: o.cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", LANG: "C.UTF-8", ...o.env }, timeoutMs: o.timeoutMs ?? 120_000 });
}

export { resolveInWorkspace } from "./paths";
