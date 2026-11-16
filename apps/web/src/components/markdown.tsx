import { Check, Copy } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Restricted Markdown (§13.6): paragraphs, lists, fenced code (copy button), inline code, bold,
 * italic, blockquote, tables, links. No raw HTML ever: everything renders as React text nodes.
 * Links: http/https only, new tab, rel="noopener noreferrer". Mentions and task refs become chips.
 */
export interface RenderOpts {
  mentionNames?: string[];
  projectKey?: string;
  onTaskRef?(ref: string): void;
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/code relative my-1.5 overflow-hidden rounded-md border bg-muted/60">
      <div className="flex items-center justify-between border-b px-2.5 py-1 text-[11px] text-muted-foreground">
        <span className="font-mono">{lang || "text"}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1 hover:text-foreground"
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          aria-label="复制代码"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />} {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="overflow-x-auto p-2.5 font-mono text-[12.5px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const SAFE_URL = /^https?:\/\/[^\s<>"]+$/i;

function inline(text: string, o: RenderOpts, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const names = [...(o.mentionNames ?? [])].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const mention = names.length ? `@(?:"(?:${names.join("|")})"|(?:${names.join("|")})|所有人)` : "@所有人";
  const taskRef = o.projectKey ? `\\b${o.projectKey}-\\d+\\b|(?<![\\w&])#\\d+\\b` : "(?<![\\w&])#\\d+\\b";
  const re = new RegExp(`(\`[^\`\\n]+\`)|(\\*\\*[^*\\n]+\\*\\*)|(\\[[^\\]\\n]+\\]\\(https?:\\/\\/[^)\\s]+\\))|(https?:\\/\\/[^\\s<>()]+)|(${mention})|(${taskRef})`, "gu");
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${keyBase}-${i++}`;
    const [all, code, bold, mdLink, url, men, ref] = m;
    if (code)
      out.push(
        <code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
          {code.slice(1, -1)}
        </code>,
      );
    else if (bold) out.push(<strong key={k}>{bold.slice(2, -2)}</strong>);
    else if (mdLink) {
      const label = mdLink.slice(1, mdLink.indexOf("]("));
      const href = mdLink.slice(mdLink.indexOf("](") + 2, -1);
      out.push(
        SAFE_URL.test(href) ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
            {label}
          </a>
        ) : (
          label
        ),
      );
    } else if (url)
      out.push(
        SAFE_URL.test(url) ? (
          <a key={k} href={url} target="_blank" rel="noopener noreferrer" className="break-all text-primary underline underline-offset-2">
            {url}
          </a>
        ) : (
          url
        ),
      );
    else if (men)
      out.push(
        <span key={k} className="rounded bg-accent px-1 py-px font-medium text-accent-foreground" data-mention>
          {men.replace(/"/g, "")}
        </span>,
      );
    else if (ref)
      out.push(
        <button key={k} type="button" onClick={() => o.onTaskRef?.(ref)} className="rounded font-mono text-[0.92em] font-medium text-primary hover:underline">
          {ref}
        </button>,
      );
    else out.push(all);
    last = at + all.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className, ...o }: { text: string; className?: string } & RenderOpts) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) buf.push(lines[i++]!);
      i++;
      blocks.push(<CodeBlock key={key++} code={buf.join("\n")} lang={fence[1] ?? ""} />);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/).test(lines[i]!)) items.push(lines[i++]!.replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/, ""));
      const L = ordered ? "ol" : "ul";
      blocks.push(
        <L key={key++} className={cn("my-1 space-y-0.5 pl-5", ordered ? "list-decimal" : "list-disc")}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, o, `${key}-${j}`)}</li>
          ))}
        </L>,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push(
        <blockquote key={key++} className="my-1 border-l-2 pl-3 text-muted-foreground">
          {buf.map((b, j) => (
            <p key={j}>{inline(b, o, `${key}-q${j}`)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const row = (l: string) =>
        l
          .trim()
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim());
      const head = row(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i]!)) body.push(row(lines[i++]!));
      blocks.push(
        <div key={key++} className="my-1.5 overflow-x-auto">
          <table className="text-sm">
            <thead>
              <tr>
                {head.map((h, j) => (
                  <th key={j} className="border-b px-2 py-1 text-left font-medium">
                    {inline(h, o, `${key}-h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k} className="border-b px-2 py-1">
                      {inline(c, o, `${key}-${j}-${k}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !lines[i]!.startsWith("```") && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]!) && !lines[i]!.startsWith(">")) buf.push(lines[i++]!);
    blocks.push(
      <p key={key++} className="my-0.5 whitespace-pre-wrap break-words">
        {buf.map((b, j) => (
          <Fragment key={j}>
            {j > 0 && "\n"}
            {inline(b, o, `${key}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className={cn("text-[14.5px] leading-[1.7]", className)}>{blocks}</div>;
}
