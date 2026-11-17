import { asText, type ParsedToolCall } from "@ap/shared";

/** Scripted model (LLM-13): deterministic, in-process, first-class for CI and demos. */
export interface ScriptRequest {
  purpose: string;
  messages: Array<{ role: string; content: string }>;
  toolNames: string[];
  json: boolean;
}
export interface ScriptReply {
  content: string;
  toolCalls?: ParsedToolCall[];
  /** Simulated failure for retry/fallback tests. */
  fail?: "timeout" | "server_error" | "refused";
}
export type Script = (req: ScriptRequest) => ScriptReply;

const lastUser = (req: ScriptRequest) => [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";

/** Pulls the `<trigger>` block the context builder writes, or falls back to the last user message. */
export function triggerText(req: ScriptRequest): string {
  const all = req.messages.map((m) => m.content).join("\n");
  const m = all.match(/<trigger[^>]*>([\s\S]*?)<\/trigger>/);
  const raw = m?.[1] ?? lastUser(req);
  // Drop fences, then a leading "作者: " speaker label so replies quote only the request.
  return raw
    .replace(/<\/?untrusted[^>]*>/g, "")
    .trim()
    .replace(/^[^:：\n]{1,40}[:：]\s*/, "")
    .trim();
}

/** Lines of the transcript (`#seq 作者: 正文`) for summaries. */
function transcript(req: ScriptRequest): Array<{ seq: number; author: string; body: string }> {
  const out: Array<{ seq: number; author: string; body: string }> = [];
  for (const m of req.messages) {
    for (const line of m.content.split("\n")) {
      const r = line.match(/^#(\d+)\s+([^:：]+)[:：]\s*(.+)$/);
      if (r) out.push({ seq: Number(r[1]), author: r[2]!.trim(), body: r[3]!.trim() });
    }
  }
  return out;
}

const hasDetail = (t: string) => /\d{2,}|错误|报错|日志|接口|版本|5\d\d|超时率|p9\d|ms|秒|从.*开始|昨天|今天/.test(t) && t.replace(/@\S+/g, "").trim().length >= 18;

/** The "demo" script plays a sensible captain: ask when vague, propose when detailed, summarise on demand. */
export const demoScript: Script = (req) => {
  if (req.purpose === "captain.summary") {
    // Human chat only: skip cards ("[kind] …") and agent/system authors; each line lands in one section.
    const lines = transcript(req).filter((l) => !l.body.startsWith("[") && !/船长|系统|Agent/.test(l.author));
    const used = new Set<number>();
    const pick = (re: RegExp, max = 5) => {
      const out: Array<{ text: string; seqs: number[] }> = [];
      for (const l of lines) {
        if (out.length >= max || used.has(l.seq) || !re.test(l.body)) continue;
        used.add(l.seq);
        out.push({ text: l.body.replace(/^决定[:：]\s*/, "").slice(0, 80), seqs: [l.seq] });
      }
      return out;
    };
    const decisions = pick(/(决定|定了|就这么办|统一|采用|改为)/);
    const constraints = pick(/(必须|不能|不要|只能|限制|需要和)/);
    const openQuestions = pick(/[?？]$/);
    const risks = pick(/(风险|超时|故障|报错|502|回滚|限流)/);
    const taskGraph = pick(/(任务|修复|排查|上线|验收)/);
    // Rolling summary: carry the previous version forward (a real model gets the same input).
    const all = req.messages.map((m) => m.content).join("\n");
    const pm = all.match(/上一版摘要：(\{.*\})\s*\n/);
    let prev: Record<string, Array<{ text: string; seqs: number[]; decisionId?: string }>> = {};
    try {
      prev = pm ? (JSON.parse(pm[1]!) as typeof prev) : {};
    } catch {
      prev = {};
    }
    const merge = (k: string, now: Array<{ text: string; seqs: number[] }>) => [...(prev[k] ?? []).filter((x) => !now.some((n) => n.text === x.text)), ...now].slice(-8);
    return {
      content: JSON.stringify({
        decisions: merge("decisions", decisions),
        constraints: merge("constraints", constraints),
        openQuestions: merge("openQuestions", openQuestions),
        taskGraph: merge("taskGraph", taskGraph),
        risks: merge("risks", risks),
      }),
    };
  }
  if (req.purpose === "global.ask") {
    const projects = [
      ...req.messages
        .map((m) => m.content)
        .join("\n")
        .matchAll(/\[project:([A-Z0-9]+)\]/g),
    ].map((m) => m[1]!);
    if (!projects.length) return { content: JSON.stringify({ answer: "", sources: [] }) };
    return { content: JSON.stringify({ answer: `相关项目：${projects.join("、")}。详见各项目摘要。`, sources: projects }) };
  }
  if (req.purpose === "dev.turn") return devScript(req);
  if (req.purpose === "review.turn") return reviewerScript(req);
  if (req.purpose === "kb.judge") return kbJudgeScript(req);
  if (req.purpose === "kb.answer") return kbAnswerScript(req);
  if (req.purpose === "test.turn") return testerScript(req);
  if (req.purpose === "captain.turn") {
    const t = triggerText(req)
      .replace(/@\S+\s*/g, "")
      .trim();
    const answering = /<answering_question/.test(req.messages.map((m) => m.content).join("\n"));
    const explicit = /(帮我|请|麻烦|需要|查一下|修复|处理|排查|做一个|加一个)/.test(t);
    if (!answering && explicit && !hasDetail(t) && req.toolNames.includes("ask_question")) {
      return {
        content: `收到：${t.slice(0, 40)}。在建任务前需要先确认一些信息。`,
        toolCalls: [
          {
            name: "ask_question",
            arguments: { question: "能补充一下现象吗？比如从什么时候开始、影响哪些接口、错误率或报错信息。", options: ["我来补充细节", "先按现有信息建任务"], default: "先按现有信息建任务" },
          },
        ],
      };
    }
    if ((explicit || answering) && req.toolNames.includes("propose_task")) {
      const all = req.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n");
      const ids = [...all.matchAll(/id="(msg_[A-Za-z0-9_-]+)"/g)].map((m) => m[1]!);
      const title = answering ? "排查支付服务超时" : t.slice(0, 30);
      return {
        content: "已根据讨论生成任务提议，请确认。",
        toolCalls: [
          {
            name: "propose_task",
            arguments: {
              title,
              description: t,
              type: /超时|报错|bug|故障|502/.test(all) ? "bug" : "feature",
              priority: /P0|紧急|线上/.test(all) ? "P1" : "P2",
              acceptanceCriteria: ["定位超时根因并给出证据（日志 / 链路）", "修复后 p99 恢复到基线以内", "补充回归测试"],
              sourceMessageIds: ids.slice(-3),
            },
          },
        ],
      };
    }
    return { content: `收到。${t ? `关于「${t.slice(0, 30)}」` : ""}我会跟进，有需要建任务的地方会先发提议给大家确认。` };
  }
  return { content: "ok" };
};

/* ───────────── scripted dev agent (S5) ───────────── */

interface DevState {
  taskStatus: string;
  branch: string;
  base: string;
  head: string;
  dirty: boolean;
  pushedSha: string | null;
  mr: string | null;
  ci: { status: string; sha: string } | null;
  testCommand: string;
  review?: { sha: string; round: number; comments: Array<{ path?: string; line?: number; body: string }> } | null;
}

/** Tool results of the current turn, in order: `<tool_result name="x">json</tool_result>`. */
function toolResults(req: ScriptRequest): Array<{ name: string; ok: boolean; data: Record<string, unknown> }> {
  const out: Array<{ name: string; ok: boolean; data: Record<string, unknown> }> = [];
  for (const m of req.messages) {
    for (const r of m.content.matchAll(/<tool_result name="([a-z_]+)">\s*([\s\S]*?)\s*<\/tool_result>/g)) {
      try {
        const v = JSON.parse(r[2]!) as { ok: boolean; result?: Record<string, unknown>; error?: string };
        out.push({ name: r[1]!, ok: v.ok, data: (v.result ?? { error: v.error }) as Record<string, unknown> });
      } catch {
        out.push({ name: r[1]!, ok: false, data: {} });
      }
    }
  }
  return out;
}

function devState(req: ScriptRequest): DevState | null {
  const all = req.messages.map((m) => m.content).join("\n");
  const m = all.match(/<state>\s*(\{[\s\S]*?\})\s*<\/state>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as DevState;
  } catch {
    return null;
  }
}

/**
 * Plays a careful developer: reproduce → locate (FIXME marker) → fix → re-test → commit → push →
 * MR → wait for CI → request review. Decisions come from <state> plus this turn's tool results, so a
 * resumed session after a crash continues without repeating side effects.
 */
export const devScript: Script = (req) => {
  const st = devState(req);
  if (!st) return { content: "缺少工作区状态，无法继续。" };
  const res = toolResults(req);
  const last = (name: string) => [...res].reverse().find((r) => r.name === name);
  const call = (content: string, name: string, args: Record<string, unknown>) => ({ content, toolCalls: [{ name, arguments: args }] });
  const committed = st.head !== st.base;
  // Rework: an open change request on the current head comes first (main scenario step 6).
  if (st.review && st.review.sha === st.head) {
    const wroteFiles = res.filter((r) => r.name === "write_file" && r.ok).map((r) => asText(r.data.path));
    const gw = [...res].reverse().find((r) => r.name === "read_file" && r.data.path === "src/gateway.ts");
    if (!gw) return call("先看评审意见涉及的文件。", "read_file", { path: "src/gateway.ts" });
    if (!wroteFiles.includes("src/gateway.ts")) {
      const lines = asText(gw.data.content).split("\n");
      const i = lines.findIndex((l) => /GATEWAY_CALL_TIMEOUT_MS\s*=/.test(l));
      if (i >= 0 && !/必须小于/.test(lines[i - 1] ?? "")) lines.splice(i, 0, "// 必须小于上游网关超时（UPSTREAM_GATEWAY_TIMEOUT_MS），给重试留出余量；不要改回 30s。");
      return call("按评审意见补充超时约束的注释。", "write_file", { path: "src/gateway.ts", content: lines.join("\n") });
    }
    if (!wroteFiles.includes("test/gateway-default.test.ts"))
      return call("按评审意见补充默认超时的测试。", "write_file", {
        path: "test/gateway-default.test.ts",
        content: [
          'import { expect, test } from "bun:test";',
          // (built in two parts so module-boundary checks don't read this generated text as an import)
          `import { GATEWAY_CALL_TIMEOUT_MS, UPSTREAM_GATEWAY_TIMEOUT_MS, callGateway } ${"from"} "../src/gateway";`,
          "",
          'test("default timeout leaves headroom below the upstream gateway", () => {',
          "  expect(GATEWAY_CALL_TIMEOUT_MS).toBeLessThanOrEqual(UPSTREAM_GATEWAY_TIMEOUT_MS * 0.8);",
          "});",
          'test("a hung call fails with the default timeout path", async () => {',
          '  await expect(callGateway(() => new Promise<never>(() => {}), 20)).rejects.toThrow("gateway timeout");',
          "});",
          "",
        ].join("\n"),
      });
    const ran = [...res].reverse().find((r) => r.name === "run_command");
    const wroteIdx = res.map((r) => r.name).lastIndexOf("write_file");
    if (!ran || res.indexOf(ran) < wroteIdx) return call("改完跑测试。", "run_command", { command: st.testCommand });
    if (ran.data.exitCode !== 0) return call("按评审意见修改后测试失败。", "block_task", { reason: "按评审意见修改后测试失败", needs: "人类 owner" });
    return call("提交评审修改。", "commit", { message: `按评审意见修改（第 ${st.review.round} 轮）：补充超时约束注释与默认超时测试` });
  }
  if (st.ci && st.ci.sha === st.head && committed && st.mr) {
    if (st.ci.status === "success" && st.taskStatus === "in_progress")
      return call("CI 已通过，提交评审。", "request_review", {
        summary: "修复超时：缩短调用上游网关的超时，使其小于网关自身的超时，并补充了测试。",
        testPlan: { scope: "网关超时配置与回归测试", environment: "沙箱 + 仓库测试命令", cases: ["运行仓库全部测试", "验证超时配置小于上游网关超时"], passCriteria: "全部测试通过" },
      });
    if (st.ci.status === "failed") return call("CI 失败，需要人工判断。", "block_task", { reason: "CI 在当前提交上失败，自动修复未成功", needs: "人类 owner" });
    return { content: "CI 运行中，等待结果。" };
  }
  if (committed && !st.dirty && st.pushedSha !== st.head) return call("推送任务分支。", "push", {});
  if (committed && !st.dirty && !st.mr) return call("创建 MR。", "open_merge_request", { title: "" });
  if (committed && !st.dirty) return { content: "等待 CI。" };
  // No commit yet: reproduce, locate, fix, verify, commit.
  const tests = res.filter((r) => r.name === "run_command");
  const wrote = last("write_file");
  if (!tests.length) return call("先跑测试复现问题。", "run_command", { command: st.testCommand });
  if (!wrote) {
    const firstTest = tests[0]!;
    if (firstTest.data.exitCode === 0 && !st.dirty) return call("测试全部通过，无法复现。", "block_task", { reason: "按现有信息无法复现问题（测试全部通过）", needs: "人类 owner 补充复现步骤" });
    const found = last("search_code");
    if (!found) return call("搜索代码里标注的问题点。", "search_code", { pattern: "FIXME" });
    const hit = asText((found.data.matches as string[] | undefined)?.[0]);
    const path = hit.split(":")[0];
    if (!path) return call("没有找到问题点。", "block_task", { reason: "无法定位问题代码", needs: "人类 owner" });
    const read = last("read_file");
    if (!read || read.data.path !== path) return call(`查看 ${path}。`, "read_file", { path });
    const content = asText(read.data.content);
    const lines = content.split("\n");
    const i = lines.findIndex((l) => /FIXME/.test(l));
    const target = lines[i]?.match(/应改为\s*([0-9_]+)/)?.[1];
    if (i < 0 || !target) return call("问题点没有给出可执行的修复方向。", "block_task", { reason: "FIXME 未说明修复方向", needs: "人类 owner" });
    lines[i] = lines[i]!.replace(/=\s*[0-9_]+/, `= ${target}`).replace(/\s*\/\/\s*FIXME.*$/, "");
    return call(`修改 ${path}：超时改为 ${target}。`, "write_file", { path, content: lines.join("\n") });
  }
  const after = tests[tests.length - 1]!;
  const ranAfterWrite = res.indexOf(after) > res.indexOf(wrote);
  if (!ranAfterWrite) return call("修改后重新跑测试。", "run_command", { command: st.testCommand });
  if (after.data.exitCode !== 0) return call("修改后测试仍失败。", "block_task", { reason: "修改后测试仍然失败", needs: "人类 owner" });
  return call("测试通过，提交。", "commit", { message: "修复网关调用超时：超时时间小于上游网关超时\n\n复现：仓库测试失败；修复后全部通过。" });
};

/* ───────────── scripted reviewer / tester (S6) ───────────── */

function qaState(req: ScriptRequest): Record<string, unknown> | null {
  const m = req.messages
    .map((x) => x.content)
    .join("\n")
    .match(/<state>\s*(\{[\s\S]*?\})\s*<\/state>/);
  try {
    return m ? (JSON.parse(m[1]!) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Plays a careful reviewer: if the change has no test changes, it asks for two things (an explanatory
 * comment next to the timeout and a regression test) — main scenario step 6; otherwise it approves,
 * marks every criterion and confirms the test plan.
 */
export const reviewerScript: Script = (req) => {
  const st = qaState(req);
  if (!st) return { content: "缺少状态。" };
  const files = (st.files as string[] | undefined) ?? [];
  const criteria = (st.criteria as Array<{ id: string }> | undefined) ?? [];
  const touchesTests = files.some((f) => /(^|\/)(test|tests|__tests__)\//.test(f) || /\.test\.[jt]sx?$/.test(f));
  if (!touchesTests)
    return {
      content: "改动方向正确，但还有两点需要修改。",
      toolCalls: [
        {
          name: "submit_review",
          arguments: {
            verdict: "changes_requested",
            summary: "超时修复方向正确，需补充约束说明与回归测试。",
            comments: [
              { path: files.find((f) => f.startsWith("src/")) ?? files[0] ?? "src", line: 4, body: "请在超时常量旁注明它必须小于上游网关的超时，避免以后被改回 30s。" },
              { path: "test/", body: "请补充一个回归测试：默认超时要明显小于上游网关超时，且挂起的调用会快速失败。" },
            ],
          },
        },
      ],
    };
  return {
    content: "意见已处理，评审通过。",
    toolCalls: [
      {
        name: "submit_review",
        arguments: {
          verdict: "approved",
          summary: "修复与回归测试都到位。",
          criteria: Object.fromEntries(criteria.map((c) => [c.id, "met"])),
          testPlan: { cases: ["运行仓库全部测试", "核对默认超时小于上游网关超时", "挂起调用在超时后快速失败"], confirmedNote: "评审确认" },
        },
      },
    ],
  };
};

/** Plays a tester: the platform's auto run decides; every criterion gets a verdict with evidence. */
export const testerScript: Script = (req) => {
  const st = qaState(req);
  if (!st) return { content: "缺少状态。" };
  const auto = (st.autoRun ?? {}) as { exitCode?: number; logArtifactId?: string };
  const criteria = (st.criteria as Array<{ id: string; text: string }> | undefined) ?? [];
  const pass = auto.exitCode === 0;
  return {
    content: pass ? "测试全部通过。" : "测试未通过。",
    toolCalls: [
      {
        name: "submit_test_result",
        arguments: {
          status: pass ? "passed" : "failed",
          summary: pass ? "仓库测试全部通过" : `仓库测试失败（exit ${auto.exitCode}）`,
          criteriaResults: criteria.map((c) => ({ id: c.id, verdict: pass ? "met" : "unmet", evidence: `${pass ? "通过" : "失败"}：仓库测试（日志 ${auto.logArtifactId ?? "-"}）` })),
        },
      },
    ],
  };
};

/* ───────────── scripted knowledge-base judge / answer (S7) ───────────── */

function kbQuestion(req: ScriptRequest) {
  return (
    req.messages
      .map((m) => m.content)
      .join("\n")
      .match(/问题：(.+)/)?.[1] ?? ""
  ).trim();
}
/** Latin identifiers (≥ 2 chars) and CJK bigrams. */
function kbTokens(text: string): Set<string> {
  const out = new Set<string>(text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
  for (const m of text.matchAll(/[\u4e00-\u9fff]+/g)) for (let i = 0; i + 1 < m[0].length; i++) out.add(m[0].slice(i, i + 2));
  return out;
}

/** SAG2 judge: a candidate is evidence if it shares a meaningful token with the question; expands with identifiers it mentions. */
export const kbJudgeScript: Script = (req) => {
  const q = kbTokens(kbQuestion(req));
  const all = req.messages.map((m) => m.content).join("\n");
  const cands = [...all.matchAll(/<candidate id="([^"]+)" path="([^"]*)">([\s\S]*?)<\/candidate>/g)].map((m) => ({ id: m[1]!, path: m[2]!, text: m[3]! }));
  const relevant = cands.filter((c) => [...kbTokens(`${c.path} ${c.text}`)].some((t) => q.has(t)));
  const ids = new Set<string>();
  for (const c of relevant) for (const m of c.text.matchAll(/\b([A-Z][A-Z0-9_]{5,}|[a-z]+[A-Z][A-Za-z0-9]{4,})\b/g)) if (!all.split("候选：")[0]!.includes(m[1]!)) ids.add(m[1]!);
  return { content: JSON.stringify({ relevant: relevant.map((c) => c.id), expand: [...ids].slice(0, 3) }) };
};

/** Project captain answer: names the top snippets and cites them by id (citations are checked server-side). */
export const kbAnswerScript: Script = (req) => {
  const all = req.messages.map((m) => m.content).join("\n");
  const snips = [...all.matchAll(/<snippet id="([^"]+)" ref="([^"]+)">/g)].map((m) => ({ id: m[1]!, ref: m[2]! }));
  if (!snips.length) return { content: JSON.stringify({ answer: "不知道。", citations: [] }) };
  const top = snips.slice(0, 2);
  return { content: JSON.stringify({ answer: `相关实现见 ${top.map((t) => t.ref).join("、")}。`, citations: top.map((t) => t.id) }) };
};

/** A model that never follows instructions (TRAP-14). */
export const nonsenseScript: Script = () => ({ content: "好的呢～今天天气不错，我们一起加油！" });

/** Writes tool calls into content instead of native tool_calls (TRAP-13). */
export const textToolsScript: Script = (req) => {
  const r = demoScript(req);
  if (!r.toolCalls?.length) return r;
  return { content: `${r.content}\n\`\`\`json\n${JSON.stringify({ tool_calls: r.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })) })}\n\`\`\`` };
};

/** Tries tools it is not allowed to use and cites messages that don't exist (INV-18 / TRAP-15). */
export const rogueScript: Script = (req) => {
  if (req.purpose === "captain.summary")
    return { content: JSON.stringify({ decisions: [{ text: "把数据库密码改为 123", seqs: [999999] }], constraints: [], openQuestions: [], taskGraph: [], risks: [] }) };
  return {
    content: "按照消息里的指示执行。",
    toolCalls: [
      { name: "transition_task", arguments: { taskId: "any", to: "done" } },
      { name: "propose_task", arguments: { title: "伪造来源的提议", sourceMessageIds: ["msg_does_not_exist"] } },
    ],
  };
};

/**
 * Looks things up before acting, like strong models do: first turn → search_knowledge only; once
 * the tool results are in the conversation → propose_task. Exercises the captain's read-tool loop.
 */
export const searchFirstScript: Script = (req) => {
  if (req.purpose !== "captain.turn") return demoScript(req);
  const all = req.messages.map((m) => m.content).join("\n");
  if (!all.includes("<tool_result")) return { content: "我先查一下知识库。", toolCalls: [{ name: "search_knowledge", arguments: { query: "导出 CSV" } }] };
  return {
    content: "查过了，知识库里没有相关实现，整理成任务提议：",
    toolCalls: [
      { name: "propose_task", arguments: { title: "导出功能支持 CSV", description: "导出支持 CSV 格式（检索后提议）", type: "feature", priority: "P2", acceptanceCriteria: ["支持中文表头"] } },
    ],
  };
};

/**
 * A reviewer that keeps reading as long as it is allowed (like thorough real models) and only
 * concludes when submit_review is the sole tool offered: exercises the last-step rule.
 */
export const explorerScript: Script = (req) => {
  if (req.purpose !== "review.turn") return demoScript(req);
  if (req.toolNames.length === 1 && req.toolNames[0] === "submit_review") return reviewerScript(req);
  return { content: "再看一下 README。", toolCalls: [{ name: "read_file", arguments: { path: "README.md" } }] };
};

export const SCRIPTS: Record<string, Script> = {
  demo: demoScript,
  nonsense: nonsenseScript,
  text_tools: textToolsScript,
  rogue: rogueScript,
  search_first: searchFirstScript,
  explorer: explorerScript,
};

/** Extra scripts registered by tests. */
export function registerScript(name: string, s: Script) {
  SCRIPTS[name] = s;
}
