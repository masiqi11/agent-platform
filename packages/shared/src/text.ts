/** Text utilities shared by server and web. Pure functions, no runtime-specific APIs. */

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * Application-side tokenizer for Chinese+Latin full-text search (spec §8.7).
 * Latin/digit runs → lowercased words; CJK runs → unigrams + bigrams.
 * Changing this algorithm is an index version change.
 */
export const TOKENIZER_VERSION = "t1";
export function tokenize(input: string): string[] {
  const out: string[] = [];
  const text = input.normalize("NFKC").toLowerCase();
  let latin = "";
  let cjk = "";
  const flushLatin = () => {
    if (latin.length > 0) {
      out.push(latin);
      // split snake/camel-ish identifiers so `payment_timeout` matches `timeout`
      const parts = latin.split(/[_.\-/]+/).filter((p) => p.length > 1);
      if (parts.length > 1) out.push(...parts);
    }
    latin = "";
  };
  const flushCjk = () => {
    for (let i = 0; i < cjk.length; i++) {
      out.push(cjk[i]!);
      if (i + 1 < cjk.length) out.push(cjk.slice(i, i + 2));
    }
    cjk = "";
  };
  for (const ch of text) {
    if (CJK.test(ch)) {
      flushLatin();
      cjk += ch;
    } else if (/[a-z0-9_.\-/]/.test(ch)) {
      flushCjk();
      latin += ch;
    } else {
      flushLatin();
      flushCjk();
    }
  }
  flushLatin();
  flushCjk();
  return out.map((t) => t.replace(/^[.\-/]+|[.\-/]+$/g, "")).filter((t) => t.length > 0 && t.length < 64);
}

/** Space-joined tokens, fed to `to_tsvector('simple', …)`. */
export const tokensForIndex = (s: string): string => tokenize(s).join(" ");

/** Builds a tsquery string (OR of tokens) safe for `to_tsquery('simple', …)`. */
export function toTsQuery(q: string): string {
  const toks = [...new Set(tokenize(q))].map((t) => t.replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean);
  return toks.map((t) => `'${t}'`).join(" | ");
}

export interface MentionCandidate {
  principalId: string;
  name: string;
  kind: "human" | "agent" | "system";
  active?: boolean;
}
export interface MentionResult {
  principalIds: string[];
  all: boolean;
  /** Names that matched more than one candidate; the client must disambiguate. */
  ambiguous: string[];
  unknown: string[];
}

/**
 * Server-side mention parsing (GRP 实现规则). Supports `@name`, `@"name with space"`,
 * explicit `@[principal_id]` (written by the client after disambiguation) and `@所有人`.
 */
export function parseMentions(body: string, candidates: MentionCandidate[]): MentionResult {
  const res: MentionResult = { principalIds: [], all: false, ambiguous: [], unknown: [] };
  const add = (id: string) => {
    if (!res.principalIds.includes(id)) res.principalIds.push(id);
  };
  const re = /@(?:\[([a-z]+_[A-Za-z0-9]+)\]|"([^"\n]{1,64})"|“([^”\n]{1,64})”|([\p{L}\p{N}_\-.]{1,64}))/gu;
  for (const m of body.matchAll(re)) {
    const explicitId = m[1];
    if (explicitId) {
      if (candidates.some((c) => c.principalId === explicitId)) add(explicitId);
      else res.unknown.push(explicitId);
      continue;
    }
    const name = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (name === "所有人" || name.toLowerCase() === "all") {
      res.all = true;
      continue;
    }
    let matches = candidates.filter((c) => c.name === name);
    if (matches.length === 0 && m[4]) {
      // `@支付船长，帮我` – try the longest candidate name that prefixes the token
      const pref = candidates.filter((c) => name.startsWith(c.name)).sort((a, b) => b.name.length - a.name.length);
      if (pref.length > 0) matches = candidates.filter((c) => c.name === pref[0]!.name);
    }
    if (matches.length === 1) add(matches[0]!.principalId);
    else if (matches.length > 1) res.ambiguous.push(name);
    else res.unknown.push(name);
  }
  return res;
}

/**
 * Extracts acceptance criteria from free text, one per list line (TRAP-04: newlines are preserved,
 * never split on whitespace).
 */
export function parseAcceptanceCriteria(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(验收标准|验收|acceptance( criteria)?)\s*[:：]?\s*$/i.test(line)) {
      inSection = true;
      continue;
    }
    const m = line.match(/^(?:[-*•·]|\d+[.)、]|\[[ xX]?\]|[-*]\s*\[[ xX]?\])\s*(.+)$/);
    if (m && m[1]) out.push(m[1].trim());
    else if (inSection && line.length > 0 && !/[:：]$/.test(line)) out.push(line);
    else if (line.length === 0) inSection = inSection && out.length === 0;
  }
  return out.filter((s) => s.length > 0);
}

/** Parses `/command args` keeping newlines in args (TRAP-04). */
export function parseCommand(body: string): { name: string; args: string } | null {
  const m = body.match(/^\/([a-z]+)(?:[ \t]+|\n|$)([\s\S]*)$/);
  if (!m || !m[1]) return null;
  return { name: m[1], args: (m[2] ?? "").replace(/\s+$/, "") };
}

/** Canonical JSON: sorted keys, no whitespace (TRAP-02). */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? JSON.stringify(v) : "null";
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return "null";
}

/** Common secret patterns (LLM-10, GIT-补8, KB-补1). */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{8,}/gi,
];

export function findSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const re of SECRET_PATTERNS) for (const m of text.matchAll(new RegExp(re.source, re.flags))) hits.push(m[0]);
  return hits;
}

export function redact(text: string, exactValues: readonly string[] = []): string {
  let out = text;
  for (const v of exactValues) if (v && v.length >= 4) out = out.split(v).join("[REDACTED]");
  for (const re of SECRET_PATTERNS) out = out.replace(new RegExp(re.source, re.flags), "[REDACTED]");
  return out;
}

/** Jaccard similarity on token sets (duplicate detection, CAP-补3). */
export function similarity(a: string, b: string): number {
  const A = new Set(tokenize(a).filter((t) => t.length > 1));
  const B = new Set(tokenize(b).filter((t) => t.length > 1));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Conservative token estimate (SES-补1): CJK chars count 1 each, latin ~4 chars/token, rounded up. */
export function estimateTokens(s: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.0 + other / 3.5);
}

/** Substantive content check (CAP-补6): emoji/greetings alone don't trigger summaries. */
export function isSubstantive(s: string): boolean {
  const t = s.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s!！?？.。,，~～]/gu, "");
  if (t.length < 2) return false;
  return !/^(好的?|收到|ok|okay|谢谢|thx|thanks|哈+|嗯+|在吗|早|晚安|👍)$/i.test(t);
}
