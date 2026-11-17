import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINES, finalText, parseLine, prepare, type Engine } from "../src/modules/harness/adapters";

/** Contract tests against real event streams recorded in H0 (ADR-0010). */
const FIXTURE: Record<Engine, string> = { "claude-code": "claude", codex: "codex", opencode: "opencode", pi: "pi" };
const events = (e: Engine) =>
  readFileSync(join(import.meta.dir, "fixtures/harness", `${FIXTURE[e]}-fix-timeout.jsonl`), "utf8")
    .split("\n")
    .flatMap((l) => parseLine(e, l));

describe("harness adapters: parsing recorded runs", () => {
  for (const e of ENGINES)
    test(`${e}: session id, tool calls with results, and a final summary of the fix`, () => {
      const ev = events(e);
      expect(ev.find((x) => x.kind === "session")).toBeTruthy();
      expect(ev.filter((x) => x.kind === "tool").length).toBeGreaterThan(1);
      expect(ev.filter((x) => x.kind === "tool_result").length).toBeGreaterThan(1);
      expect(ev.some((x) => x.kind === "error")).toBe(false);
      const final = finalText(ev);
      expect(final).toMatch(/3_?000|3s|3 秒|3000/);
    });
  test("garbage and unknown lines are ignored", () => {
    for (const e of ENGINES) expect([...parseLine(e, "not json"), ...parseLine(e, "{bad"), ...parseLine(e, '{"type":"nope"}')]).toEqual([]);
  });
});

describe("harness adapters: configuration", () => {
  const base = { prompt: "修复超时", model: "m-1", platformUrl: "http://127.0.0.1:9", mcpTools: ["get_task", "block_task"], maxTurns: 30 };
  for (const e of ENGINES)
    test(`${e}: model via the platform proxy, tools via the platform MCP, and the token only referenced from the environment`, () => {
      const p = prepare({ engine: e, role: "dev", ...base });
      const all = `${p.cmd}\n${JSON.stringify(p.env)}\n${Object.values(p.files).join("\n")}`;
      expect(all).toContain("http://127.0.0.1:9/llm");
      expect(all).toContain("http://127.0.0.1:9/mcp");
      expect(all).toContain("PLATFORM_LLM_TOKEN");
      expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // never a literal token
      // Engines that allowlist tools by name must list the platform tools; OpenCode takes whatever the MCP endpoint offers (filtered server side).
      if (e !== "opencode") expect(all).toContain("get_task");
    });
  test("role limits: reviewers and testers cannot edit; reviewers cannot run arbitrary commands", () => {
    const cc = prepare({ engine: "claude-code", role: "reviewer", ...base }).cmd;
    expect(cc).toMatch(/--disallowedTools '[^']*Edit/);
    expect(cc).not.toMatch(/--allowedTools '[^']*(^|,)Bash(,|')/);
    expect(prepare({ engine: "codex", role: "tester", ...base }).files[".codex/config.toml"]).toContain('sandbox_mode = "read-only"');
    const oc = JSON.parse(prepare({ engine: "opencode", role: "reviewer", ...base }).files[".platform/opencode.json"]!);
    expect(oc.permission.edit).toBe("deny");
    expect(oc.permission.bash["*"]).toBe("deny");
    expect(prepare({ engine: "pi", role: "reviewer", ...base }).cmd).not.toMatch(/--tools '[^']*(edit|write|bash)/);
    expect(prepare({ engine: "pi", role: "tester", ...base }).cmd).toMatch(/--tools '[^']*bash/);
  });
  test("prompts with quotes survive the shell", () => {
    const p = prepare({ engine: "pi", role: "dev", ...base, prompt: 'it\'s "quoted" $HOME `x`' });
    expect(p.cmd).toContain(`'it'\\''s "quoted" $HOME \`x\`'`);
  });
});
