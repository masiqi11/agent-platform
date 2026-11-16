/**
 * Knowledge base primitives (§12.9): what gets indexed (KB-补1), how files are chunked
 * (code by declaration, docs by heading), and Reciprocal Rank Fusion for hybrid retrieval.
 * Pure functions — the server indexes, the web explains.
 */
import { tokenize } from "./text";

export interface Chunk {
  symbol: string | null;
  startLine: number;
  endLine: number;
  text: string;
}

/** Chunker / tokenizer version: changing either means a full rebuild (§8.7). */
export const KB_CHUNKER_VERSION = "chunk@1+tok@1";
export const KB_MAX_FILE_BYTES = 1_000_000;
const MAX_CHUNK_LINES = 80;

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rs|rb|php|cs|swift|scala|sql|sh)$/i;
const DOC_EXT = /\.(md|mdx|markdown|txt|rst|adoc)$/i;

/** KB-补1 defaults: binaries, lock files, build output, minified/vendored code, secrets material. */
export const KB_DEFAULT_EXCLUDES: readonly string[] = [
  "node_modules/",
  "vendor/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".git/",
  ".next/",
  "target/",
  "*.lock",
  "bun.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "*.min.js",
  "*.min.css",
  "*.map",
  ".env*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.crt",
  "id_rsa*",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.ico",
  "*.pdf",
  "*.zip",
  "*.gz",
  "*.tar",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.mp4",
  "*.mp3",
  "*.wasm",
  "*.so",
  "*.dylib",
  "*.exe",
];

/** Minimal glob: `dir/` prefixes anywhere in the path, `*` within a segment, plain names match any segment. */
export function matchesPattern(path: string, pattern: string): boolean {
  const p = path.replace(/^\/+/, "");
  if (pattern.endsWith("/")) {
    const dir = pattern.slice(0, -1);
    return p === dir || p.startsWith(`${dir}/`) || p.includes(`/${dir}/`);
  }
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
  const base = p.split("/").pop() ?? p;
  return re.test(p) || re.test(base);
}

/** Why a file is not indexed, or null when it is. */
export function exclusionReason(path: string, size: number, extra: readonly string[] = []): string | null {
  if (size > KB_MAX_FILE_BYTES) return "too_large";
  for (const pat of [...KB_DEFAULT_EXCLUDES, ...extra]) if (matchesPattern(path, pat)) return `excluded:${pat}`;
  if (!CODE_EXT.test(path) && !DOC_EXT.test(path) && !/(^|\/)(README|CHANGELOG|LICENSE|Dockerfile|Makefile)[^/]*$/i.test(path) && !/\.(json|ya?ml|toml|ini|cfg|proto|graphql)$/i.test(path))
    return "unsupported_type";
  return null;
}

export function isCodePath(path: string) {
  return CODE_EXT.test(path);
}

/** Lines that start a top-level declaration in common languages. */
const DECL =
  /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|interface\s+([A-Za-z_$][\w$]*)|type\s+([A-Za-z_$][\w$]*)\s*=|enum\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:])|^(?:async\s+)?def\s+([A-Za-z_]\w*)|^class\s+([A-Za-z_]\w*)|^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|^(?:test|describe|it)\(\s*["'`]([^"'`]{1,60})/;

function splitLong(lines: string[], start: number, symbol: string | null): Chunk[] {
  const out: Chunk[] = [];
  for (let i = 0; i < lines.length; i += MAX_CHUNK_LINES) {
    const part = lines.slice(i, i + MAX_CHUNK_LINES);
    out.push({ symbol, startLine: start + i, endLine: start + i + part.length - 1, text: part.join("\n") });
  }
  return out;
}

/**
 * Code: one chunk per top-level declaration (leading comments stay with it); the preamble
 * (imports) is its own chunk; long blocks are split. Keeps path/symbol/lines for citations.
 */
export function chunkCode(text: string): Chunk[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const starts: Array<{ line: number; symbol: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s/.test(l)) continue;
    const m = l.match(DECL);
    if (!m) continue;
    const sym = m.slice(1).find((x) => x) ?? null;
    if (!sym) continue;
    // Pull directly preceding comment lines into the declaration.
    let s = i;
    while (s > 0 && /^\s*(\/\/|\/\*|\*|#)/.test(lines[s - 1]!) && !starts.some((x) => x.line === s - 1)) s--;
    starts.push({ line: s, symbol: sym });
  }
  if (!starts.length) return splitLong(lines, 1, null).filter((c) => c.text.trim());
  const out: Chunk[] = [];
  if (starts[0]!.line > 0) out.push(...splitLong(lines.slice(0, starts[0]!.line), 1, null));
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k]!.line;
    const to = k + 1 < starts.length ? starts[k + 1]!.line : lines.length;
    out.push(...splitLong(lines.slice(from, to), from + 1, starts[k]!.symbol));
  }
  return out.filter((c) => c.text.trim()).map((c) => ({ ...c, text: c.text.replace(/\n+$/, "") }));
}

/** Docs: one chunk per heading section (heading text is the symbol); long sections are split. */
export function chunkDoc(text: string): Chunk[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: Chunk[] = [];
  let start = 0;
  let title: string | null = null;
  const flush = (end: number) => {
    const part = lines.slice(start, end);
    if (part.join("").trim()) out.push(...splitLong(part, start + 1, title));
  };
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i]!.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (h && i > start) {
      flush(i);
      start = i;
    }
    if (h) title = h[1]!.slice(0, 120);
  }
  flush(lines.length);
  return out.map((c) => ({ ...c, text: c.text.replace(/\n+$/, "") }));
}

export function chunkFile(path: string, text: string): Chunk[] {
  if (isCodePath(path)) return chunkCode(text);
  if (DOC_EXT.test(path) || /README|CHANGELOG/i.test(path)) return chunkDoc(text);
  return splitLong(text.replace(/\r\n/g, "\n").split("\n"), 1, null).filter((c) => c.text.trim());
}

/** Reciprocal Rank Fusion (k = 60): robust to incomparable per-route scores. */
export function rrf(lists: Array<Array<{ id: string }>>, k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((item, rank) => scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank + 1)));
  return scores;
}

export type KbRoute = "bm25" | "sag2" | "vector";
export const KB_ROUTES: readonly KbRoute[] = ["bm25", "sag2", "vector"];

/** Question/function bigrams that carry no topic (KB queries only; the index is unchanged). */
export const KB_STOP_TERMS = new Set([
  "怎么",
  "么写",
  "么做",
  "么办",
  "什么",
  "为什",
  "是什",
  "哪个",
  "哪些",
  "哪里",
  "在哪",
  "如何",
  "多少",
  "是多",
  "的是",
  "是怎",
  "怎样",
  "一下",
  "请问",
  "可以",
  "有没",
  "没有",
  "我们",
  "这个",
  "那个",
  "相关",
  "里的",
  "中的",
]);

/**
 * KB query terms: Latin/identifier words and CJK bigrams, minus stop terms. CJK unigrams are only
 * used when the query has no bigram at all — an OR of single characters matches everything (TRAP-3).
 */
export function kbQueryTerms(q: string): string[] {
  const toks = [...new Set(tokenize(q))].map((t) => t.replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean);
  const isCjkUni = (t: string) => t.length === 1 && /[㐀-鿿豈-﫿]/.test(t);
  const strong = toks.filter((t) => !isCjkUni(t) && !KB_STOP_TERMS.has(t) && !(t.length === 1 && /[a-z0-9]/.test(t)));
  return strong.length ? strong : toks.filter((t) => !KB_STOP_TERMS.has(t));
}

/** OR-tsquery over {@link kbQueryTerms}, safe for `to_tsquery('simple', …)`. */
export const kbTsQuery = (q: string): string =>
  kbQueryTerms(q)
    .map((t) => `'${t}'`)
    .join(" | ");
