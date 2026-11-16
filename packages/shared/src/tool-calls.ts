/**
 * Text-form tool call parsing (TRAP-13 / LLM-02): many OpenAI-compatible local models write
 * tool calls into the content instead of returning structured `tool_calls`.
 */
export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    // tolerate trailing commas and single quotes, which small models often emit
    try {
      return JSON.parse(s.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return undefined;
    }
  }
}

function normalize(v: unknown, allowed?: ReadonlySet<string>): ParsedToolCall[] {
  const arr = Array.isArray(v) ? v : [v];
  const out: ParsedToolCall[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const fn = (o.function && typeof o.function === "object" ? (o.function as Record<string, unknown>) : o) as Record<string, unknown>;
    const name = (fn.name ?? o.tool ?? o.tool_name) as unknown;
    let args = (fn.arguments ?? fn.parameters ?? o.args ?? o.input ?? {}) as unknown;
    if (typeof args === "string") args = tryJson(args) ?? {};
    if (typeof name !== "string" || !name) continue;
    if (allowed && !allowed.has(name)) continue;
    if (!args || typeof args !== "object" || Array.isArray(args)) continue;
    out.push({ name, arguments: args as Record<string, unknown> });
  }
  return out;
}

/** Extracts balanced JSON objects/arrays from free text. */
export function extractJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const m of text.matchAll(/```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/g)) if (m[1]) blocks.push(m[1].trim());
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) if (m[1]) blocks.push(m[1].trim());
  // bare balanced braces
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0 && start >= 0) {
        blocks.push(text.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return blocks;
}

export function parseTextToolCalls(text: string, allowedNames?: readonly string[]): ParsedToolCall[] {
  const allowed = allowedNames ? new Set(allowedNames) : undefined;
  for (const block of extractJsonBlocks(text)) {
    const v = tryJson(block);
    if (v === undefined) continue;
    const calls = normalize((v as Record<string, unknown>)?.tool_calls ?? v, allowed);
    if (calls.length > 0) return calls;
  }
  return [];
}

/** First JSON object in text (for JSON-mode fallbacks). */
export function extractFirstJson(text: string): unknown {
  for (const block of extractJsonBlocks(text)) {
    const v = tryJson(block);
    if (v !== undefined && typeof v === "object") return v;
  }
  return undefined;
}
