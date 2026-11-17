/**
 * Harness adapters (ADR-0010): how each external engine is configured and how its event stream is
 * read. Pure functions — the service writes the files into the sandbox HOME and runs the command.
 *
 * Every engine gets its model from the platform model proxy and the platform's tools from the
 * platform MCP endpoint, both authenticated with the session token in `PLATFORM_LLM_TOKEN`
 * (referenced from the environment; never written into a file). Role limits below are defence in
 * depth: the platform enforces the real ones server side, since a harness with a shell can route
 * around its own tool settings.
 */

export const ENGINES = ["claude-code", "codex", "opencode", "pi"] as const;
export type Engine = (typeof ENGINES)[number];
/** The wire API each engine speaks to the model proxy (H0). */
export const ENGINE_API: Record<Engine, "chat" | "responses" | "messages"> = { "claude-code": "messages", codex: "responses", opencode: "chat", pi: "chat" };
export const ENGINE_LABEL: Record<Engine, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "pi" };
export type HarnessRole = "dev" | "reviewer" | "tester";

/** Normalized harness event, written to the session transcript. */
export type HarnessEvent =
  | { kind: "session"; id: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input?: unknown }
  | { kind: "tool_result"; name?: string; ok: boolean; output?: string }
  | { kind: "final"; text: string }
  | { kind: "error"; message: string };

export type Reasoning = "low" | "high" | "max";
/** Codex has no "max": its highest effort is xhigh. */
const CODEX_EFFORT: Record<Reasoning, string> = { low: "low", high: "high", max: "xhigh" };

export interface PrepareInput {
  engine: Engine;
  role: HarnessRole;
  prompt: string;
  /** Model id shown to the harness; the proxy enforces the agent's model anyway. */
  model: string;
  /** Platform base URL as seen from the sandbox, e.g. http://127.0.0.1:8080 */
  platformUrl: string;
  /** Platform MCP tools this role may call (names as registered). */
  mcpTools: string[];
  maxTurns: number;
  /** Engine session to continue (rework), when the engine supports it. */
  resume?: string | null;
  /** Executable to run (defaults to the engine's usual command name). */
  bin?: string;
  /** Reasoning effort (agent modelPolicy.reasoning), mapped onto the engine's own setting. */
  reasoning?: Reasoning;
}

export interface Prepared {
  /** Shell command line, run in the workspace with stdin closed. */
  cmd: string;
  /** Files written relative to the sandbox HOME. */
  files: Record<string, string>;
  /** Non-secret env (the token goes through sessionEnv as PLATFORM_LLM_TOKEN). */
  env: Record<string, string>;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const TOKEN_ENV = "PLATFORM_LLM_TOKEN";

export function prepare(i: PrepareInput): Prepared {
  const llm = `${i.platformUrl.replace(/\/$/, "")}/llm`;
  const mcpUrl = `${i.platformUrl.replace(/\/$/, "")}/mcp`;
  const readOnly = i.role !== "dev";
  const canRun = i.role !== "reviewer";
  switch (i.engine) {
    case "claude-code": {
      const allowed = [
        "Read",
        "Grep",
        "Glob",
        ...(readOnly ? [] : ["Edit", "Write", "MultiEdit"]),
        ...(canRun ? ["Bash"] : ["Bash(git diff*)", "Bash(git log*)", "Bash(git show*)"]),
        ...i.mcpTools.map((t) => `mcp__platform__${t}`),
      ];
      const disallowed = ["WebFetch", "WebSearch", ...(readOnly ? ["Edit", "Write", "MultiEdit", "NotebookEdit"] : [])];
      return {
        cmd: [
          i.bin ?? "claude",
          "-p",
          q(i.prompt),
          "--output-format stream-json --verbose",
          `--model ${q(i.model)}`,
          `--permission-mode ${readOnly ? "default" : "acceptEdits"}`,
          `--allowedTools ${q(allowed.join(","))}`,
          `--disallowedTools ${q(disallowed.join(","))}`,
          `--max-turns ${i.maxTurns}`,
          ...(i.reasoning ? [`--effort ${i.reasoning}`] : []),
          '--mcp-config "$HOME/.platform/mcp.json" --strict-mcp-config',
          ...(i.resume ? [`--resume ${q(i.resume)}`] : []),
        ].join(" "),
        files: { ".platform/mcp.json": JSON.stringify({ mcpServers: { platform: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer \${${TOKEN_ENV}}` } } } }, null, 2) },
        // Claude Code reads its key from ANTHROPIC_API_KEY; the service maps the session token onto it.
        env: { ANTHROPIC_BASE_URL: llm, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      };
    }
    case "codex": {
      const tools = i.mcpTools.map((t) => `\n[mcp_servers.platform.tools.${t}]\napproval_mode = "approve"\n`).join("");
      return {
        cmd: [i.bin ?? "codex", "exec", ...(i.resume ? ["resume", q(i.resume)] : []), "--json --skip-git-repo-check", q(i.prompt), "< /dev/null"].join(" "),
        files: {
          ".codex/config.toml": `model = ${JSON.stringify(i.model)}
${i.reasoning ? `model_reasoning_effort = "${CODEX_EFFORT[i.reasoning]}"\n` : ""}model_provider = "platform"
approval_policy = "never"
sandbox_mode = ${JSON.stringify(readOnly ? "read-only" : "workspace-write")}

[model_providers.platform]
name = "platform proxy"
base_url = ${JSON.stringify(`${llm}/v1`)}
env_key = "${TOKEN_ENV}"
wire_api = "responses"

[mcp_servers.platform]
url = ${JSON.stringify(mcpUrl)}
bearer_token_env_var = "${TOKEN_ENV}"
${tools}`,
        },
        env: { CODEX_HOME: "$HOME/.codex" },
      };
    }
    case "opencode": {
      const config = {
        $schema: "https://opencode.ai/config.json",
        model: `platform/${i.model}`,
        provider: {
          platform: {
            npm: "@ai-sdk/openai-compatible",
            name: "platform proxy",
            options: { baseURL: `${llm}/v1`, apiKey: `{env:${TOKEN_ENV}}` },
            models: { [i.model]: { name: i.model } },
          },
        },
        mcp: { platform: { type: "remote", url: mcpUrl, headers: { Authorization: `Bearer {env:${TOKEN_ENV}}` }, enabled: true } },
        permission: { edit: readOnly ? "deny" : "allow", bash: canRun ? "allow" : { "git diff*": "allow", "git log*": "allow", "git show*": "allow", "*": "deny" }, webfetch: "deny" },
        share: "disabled",
        autoupdate: false,
      };
      return {
        cmd: [i.bin ?? "opencode", "run", "--format json", ...(i.reasoning ? [`--variant ${i.reasoning}`] : []), ...(i.resume ? [`--session ${q(i.resume)}`] : []), q(i.prompt), "< /dev/null"].join(
          " ",
        ),
        files: { ".platform/opencode.json": JSON.stringify(config, null, 2) },
        env: { OPENCODE_CONFIG: "$HOME/.platform/opencode.json", OPENCODE_DISABLE_AUTOUPDATE: "1" },
      };
    }
    case "pi": {
      const tools = [readOnly ? "read,grep,find,ls" : "read,bash,edit,write,grep,find,ls", ...(canRun && readOnly ? ["bash"] : []), ...i.mcpTools.map((t) => `mcp__platform__${t}`)].join(",");
      return {
        cmd: [
          i.bin ?? "pi",
          "--provider platform",
          `--model ${q(i.model)}`,
          "--mode json",
          ...(i.reasoning ? [`--thinking ${i.reasoning}`] : []),
          `--session-dir "$HOME/.pi/sessions"`,
          ...(i.resume ? [`--session ${q(i.resume)}`] : []),
          `--tools ${q(tools)}`,
          "-p",
          q(i.prompt),
          "< /dev/null",
        ].join(" "),
        files: {
          ".pi/agent/models.json": JSON.stringify(
            { providers: { platform: { baseUrl: `${llm}/v1`, api: "openai-completions", apiKey: `$${TOKEN_ENV}`, models: [{ id: i.model, name: i.model, contextWindow: 200000, maxTokens: 8192 }] } } },
            null,
            2,
          ),
          ".pi/agent/mcp.json": JSON.stringify({ mcpServers: { platform: { url: mcpUrl, headers: { Authorization: `Bearer \${${TOKEN_ENV}}` }, exposure: "direct" } } }, null, 2),
        },
        env: {},
      };
    }
  }
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (typeof c === "string" ? c : ((c as { text?: string }).text ?? ""))).join("") : "";
const cut = (s: string, n = 2000) => (s.length > n ? `${s.slice(0, n)}…` : s);
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : typeof v === "number" || typeof v === "boolean" ? `${v}` : JSON.stringify(v));

/** Parses one line of an engine's JSON event stream. Unknown lines yield nothing. */
export function parseLine(engine: Engine, line: string): HarnessEvent[] {
  if (!line.startsWith("{")) return [];
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: HarnessEvent[] = [];
  const type = j.type as string | undefined;
  switch (engine) {
    case "claude-code": {
      if (type === "system" && j.subtype === "init" && typeof j.session_id === "string") out.push({ kind: "session", id: j.session_id });
      if (type === "assistant")
        for (const c of ((j.message as { content?: unknown[] })?.content ?? []) as Array<Record<string, unknown>>) {
          if (c.type === "text" && str(c.text ?? "").trim()) out.push({ kind: "text", text: cut(str(c.text)) });
          if (c.type === "tool_use") out.push({ kind: "tool", name: str(c.name), input: c.input });
        }
      if (type === "user")
        for (const c of ((j.message as { content?: unknown[] })?.content ?? []) as Array<Record<string, unknown>>)
          if (c.type === "tool_result") out.push({ kind: "tool_result", ok: c.is_error !== true, output: cut(textOf(c.content)) });
      if (type === "result") {
        if (j.is_error === true || (typeof j.subtype === "string" && j.subtype !== "success")) out.push({ kind: "error", message: cut(str(j.result ?? j.subtype)) });
        else out.push({ kind: "final", text: cut(str(j.result ?? ""), 8000) });
      }
      break;
    }
    case "codex": {
      if (type === "thread.started" && typeof j.thread_id === "string") out.push({ kind: "session", id: j.thread_id });
      const it = (j.item ?? {}) as Record<string, unknown>;
      if (type === "item.started" && it.type === "command_execution") out.push({ kind: "tool", name: "shell", input: { command: it.command } });
      if (type === "item.completed") {
        if (it.type === "agent_message") out.push({ kind: "text", text: cut(str(it.text ?? "")) });
        if (it.type === "command_execution") out.push({ kind: "tool_result", name: "shell", ok: it.exit_code === 0, output: cut(str(it.aggregated_output ?? "")) });
        if (it.type === "file_change") out.push({ kind: "tool", name: "apply_patch", input: it.changes });
        if (it.type === "mcp_tool_call") {
          out.push({ kind: "tool", name: `${str(it.server)}.${str(it.tool)}`, input: it.arguments });
          out.push({ kind: "tool_result", name: str(it.tool), ok: !it.error, output: cut(JSON.stringify(it.error ?? it.result ?? null)) });
        }
      }
      if (type === "turn.failed" || type === "error") out.push({ kind: "error", message: cut(JSON.stringify((j.error as unknown) ?? j.message ?? j)) });
      break;
    }
    case "opencode": {
      const part = (j.part ?? {}) as Record<string, unknown>;
      if (typeof j.sessionID === "string" && type === "step_start") out.push({ kind: "session", id: j.sessionID });
      if (type === "text" && str(part.text ?? "").trim()) out.push({ kind: "text", text: cut(str(part.text)) });
      if (type === "tool_use") {
        const st = (part.state ?? {}) as Record<string, unknown>;
        out.push({ kind: "tool", name: str(part.tool), input: st.input });
        out.push({ kind: "tool_result", name: str(part.tool), ok: st.status === "completed", output: cut(str(st.output ?? st.error ?? "")) });
      }
      if (type === "error") out.push({ kind: "error", message: cut(JSON.stringify(j.error ?? j)) });
      break;
    }
    case "pi": {
      if (type === "session" && typeof j.id === "string") out.push({ kind: "session", id: j.id });
      if (type === "tool_execution_end") out.push({ kind: "tool_result", name: str(j.toolName), ok: j.isError !== true, output: cut(textOf((j.result as { content?: unknown })?.content)) });
      if (type === "message_end") {
        const m = (j.message ?? {}) as Record<string, unknown>;
        if (m.role === "assistant") {
          for (const c of (m.content ?? []) as Array<Record<string, unknown>>) {
            if (c.type === "text" && str(c.text ?? "").trim()) out.push({ kind: "text", text: cut(str(c.text)) });
            if (c.type === "toolCall") out.push({ kind: "tool", name: str(c.name), input: c.arguments });
          }
          if (m.stopReason === "error" || m.errorMessage) out.push({ kind: "error", message: cut(str(m.errorMessage ?? "模型调用失败")) });
        }
      }
      break;
    }
  }
  return out;
}

/** The harness's final answer: the explicit final event, else the last assistant text. */
export function finalText(events: HarnessEvent[]): string {
  const f = events.findLast((e) => e.kind === "final");
  if (f && f.kind === "final" && f.text.trim()) return f.text;
  const t = events.findLast((e) => e.kind === "text");
  return t && t.kind === "text" ? t.text : "";
}
