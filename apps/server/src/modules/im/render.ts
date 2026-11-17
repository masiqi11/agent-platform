import type { ImOutMessage } from "./types";

/**
 * IM-补2: what goes out to an IM group. DingTalk's markdown is a small subset (headings, bold,
 * links, lists, quotes; no code fences, no tables, no HTML) with a length cap, so every card has
 * its own IM rendering, rich content is degraded, and overlong content is cut with a Web link.
 * Decisions are never made in IM (IM-补6): proposals, decisions and approvals carry a link only.
 */

export interface RenderInput {
  kind: string;
  body: string;
  blocks: Record<string, unknown> | null;
  authorLabel: string;
  authorKind: string;
  /** Deep link to the message in the Web console. */
  link: string;
  /** principal id → display name, to turn `@[prn_…]` back into readable names. */
  names?: Record<string, string>;
  /** Extra data loaded by the gateway (summary content, task ref/title, approval). */
  extra?: Record<string, unknown>;
}

const TRUNCATED = "…（内容较长，已截断）";

/** Degrades general markdown to the IM subset. */
export function degradeMarkdown(src: string, names: Record<string, string> = {}): string {
  const out: string[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  let fenceLines = 0;
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      fenceLines = 0;
      continue;
    }
    if (inFence) {
      // Code blocks become quoted lines (monospace is not available); long ones are elided.
      fenceLines++;
      if (fenceLines <= 20) out.push(`> ${raw.replace(/\s+$/, "") || " "}`);
      else if (fenceLines === 21) out.push("> …");
      continue;
    }
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(raw)) continue; // table separator
    let line = raw;
    if (/^\s*\|.*\|\s*$/.test(line))
      line = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim())
        .join(" · ");
    line = line
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/`([^`\n]+)`/g, "「$1」")
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      .replace(/@\[([a-z]+_[A-Za-z0-9]+)\]/g, (_, id: string) => `@${names[id] ?? "成员"}`);
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cuts at a line boundary below `max` and appends the Web link (IM-补2). */
export function truncateWithLink(md: string, max: number, link: string): string {
  if (md.length <= max) return md;
  const suffix = `\n\n${TRUNCATED}[在 Web 查看完整内容](${link})`;
  const room = Math.max(0, max - suffix.length);
  let cut = md.slice(0, room);
  const nl = cut.lastIndexOf("\n");
  if (nl > room * 0.6) cut = cut.slice(0, nl);
  // Never leave a half markdown link behind.
  cut = cut.replace(/\[[^\]]*$|\[[^\]]*\]\([^)]*$/, "");
  return `${cut.trimEnd()}${suffix}`;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const APPROVAL_LABEL: Record<string, string> = { merge: "合并审批", release: "发布审批", credential: "凭据审批", budget: "预算审批" };
const SUMMARY_LABEL: Array<[string, string]> = [
  ["decisions", "决定"],
  ["constraints", "约束"],
  ["risks", "风险"],
  ["openQuestions", "未决问题"],
  ["taskGraph", "任务"],
];

/** One IM message per platform message or notice. */
export function renderForIm(r: RenderInput, maxChars: number): ImOutMessage {
  const b = r.blocks ?? {};
  const x = r.extra ?? {};
  const body = degradeMarkdown(r.body, r.names);
  const who = r.authorKind === "agent" ? r.authorLabel : r.authorKind === "human" ? `${r.authorLabel}（Web）` : r.authorLabel;
  let title = r.authorLabel;
  let md: string;
  switch (r.kind) {
    case "proposal_card": {
      const p = (b.payload ?? {}) as Record<string, unknown>;
      const ac = arr(p.acceptanceCriteria).map((c) => (typeof c === "string" ? c : str((c as { text?: unknown }).text)));
      title = `任务提议：${str(p.title) || "新任务"}`;
      md = [
        `### 任务提议：${str(p.title) || "新任务"}`,
        str(p.description) ? degradeMarkdown(str(p.description), r.names) : "",
        ac.length ? `**验收标准**\n\n${ac.map((c) => `- ${c}`).join("\n")}` : "",
        `确认或驳回请到 Web：[打开提议](${r.link})`,
      ]
        .filter(Boolean)
        .join("\n\n");
      break;
    }
    case "task_card":
      title = `任务 ${str(b.ref)}`;
      md = `### 任务 ${str(b.ref)}：${str(b.title)}\n\n[在 Web 查看任务](${str(x.taskLink) || r.link})`;
      break;
    case "summary_card": {
      const c = (x.summary ?? {}) as Record<string, unknown>;
      const parts = SUMMARY_LABEL.map(([k, label]) => {
        const items = arr(c[k])
          .map((i) => str((i as { text?: unknown }).text))
          .filter(Boolean)
          .slice(0, 5);
        return items.length ? `**${label}**\n\n${items.map((t) => `- ${t}`).join("\n")}` : "";
      }).filter(Boolean);
      title = "群摘要";
      md = [
        `### ${body.split("\n")[0] || "群摘要"}`,
        ...(parts.length ? parts : body.split("\n").slice(1).length ? [body.split("\n").slice(1).join("\n")] : []),
        `[在 Web 查看摘要与原消息](${r.link})`,
      ].join("\n\n");
      break;
    }
    case "decision_card":
      title = "待确认的决策";
      md = `### 待确认的决策\n\n${degradeMarkdown(str(b.text) || r.body, r.names)}\n\n确认或驳回请到 Web：[打开](${r.link})`;
      break;
    case "question": {
      const opts = arr(b.options).map(String);
      title = `${r.authorLabel} 追问`;
      md = [`**${who} 追问**`, body, opts.length ? opts.map((o, i) => `${i + 1}. ${o}`).join("\n") : "", "> 在群里 @我 回复即可"].filter(Boolean).join("\n\n");
      break;
    }
    case "approval_notice": {
      title = APPROVAL_LABEL[str(x.approvalKind)] ?? "审批";
      md = `### 需要${title}\n\n任务 ${str(x.taskRef)}：${str(x.taskTitle)}\n\n审批只能在 Web 完成：[打开审批](${r.link})`;
      break;
    }
    case "system":
      title = "系统通知";
      md = body;
      break;
    default:
      md = `**${who}**\n\n${body}`;
  }
  return { title: title.slice(0, 60), markdown: truncateWithLink(md, maxChars, r.link) };
}

/** Plain receipt for command replies. */
export function receipt(text: string): ImOutMessage {
  return { title: "回执", markdown: text };
}
