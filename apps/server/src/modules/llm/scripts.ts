import type { ParsedToolCall } from "@ap/shared";

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

export const SCRIPTS: Record<string, Script> = {
  demo: demoScript,
  nonsense: nonsenseScript,
  text_tools: textToolsScript,
  rogue: rogueScript,
};

/** Extra scripts registered by tests. */
export function registerScript(name: string, s: Script) {
  SCRIPTS[name] = s;
}
