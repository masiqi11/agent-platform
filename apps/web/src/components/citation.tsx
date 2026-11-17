import { FileCode2, History } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorState, PageSkeleton } from "@/components/states";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useKbFile } from "@/lib/knowledge";
import { cn } from "@/lib/utils";

export interface CitationRef {
  projectId: string;
  projectKey?: string;
  repoId: string | null;
  repoName: string | null;
  path: string;
  commit: string;
  startLine: number;
  endLine: number;
  sourceKind?: string;
}

/**
 * A clickable citation (FR-KB-06): repo · path:lines · short commit. Code and docs open the file at
 * that exact commit with the cited lines highlighted; decisions/summaries have no file to open.
 */
export function CitationChip({ c, className }: { c: CitationRef; className?: string }) {
  const [open, setOpen] = useState(false);
  const label = `${c.repoName ? `${c.repoName}/` : ""}${c.path}${c.repoId ? `:${c.startLine}-${c.endLine}` : ""}`;
  const chip = (
    <span className="inline-flex items-center gap-1">
      <FileCode2 className="size-3" />
      {c.projectKey && <span className="text-muted-foreground">{c.projectKey}·</span>}
      {label}
      {c.repoId && <span className="text-muted-foreground">@{c.commit.slice(0, 7)}</span>}
    </span>
  );
  const cls = cn("rounded-md border bg-card px-1.5 py-0.5 font-mono text-[11px] text-left", className);
  if (!c.repoId) return <span className={cls}>{chip}</span>;
  return (
    <>
      <button type="button" className={cn(cls, "hover:border-ring/50 hover:text-foreground")} onClick={() => setOpen(true)} data-testid="citation">
        {chip}
      </button>
      {open && <CitationDialog c={c} onClose={() => setOpen(false)} />}
    </>
  );
}

function CitationDialog({ c, onClose }: { c: CitationRef; onClose: () => void }) {
  const f = useKbFile({ projectId: c.projectId, repoId: c.repoId!, path: c.path, commit: c.commit });
  const first = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (f.data) first.current?.scrollIntoView({ block: "center" });
  }, [f.data]);
  const lines = f.data?.content.split("\n") ?? [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl gap-3" data-testid="citation-viewer">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            {c.repoName}/{c.path}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2 text-xs">
            <span>
              commit <span className="font-mono">{c.commit.slice(0, 12)}</span> · 第 {c.startLine}–{c.endLine} 行
            </span>
            {f.data?.stale && (
              <span className="inline-flex items-center gap-1 rounded-full bg-attention-soft px-2 py-0.5 text-attention">
                <History className="size-3" /> 该文件在默认分支上已有更新（{f.data.headCommit.slice(0, 7)}），此处为引用时的版本
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        {f.isPending ? (
          <PageSkeleton rows={6} />
        ) : f.error ? (
          <ErrorState error={f.error} />
        ) : (
          <div className="max-h-[60vh] overflow-auto rounded-lg border bg-muted/40">
            <pre className="py-2 font-mono text-[12.5px] leading-relaxed">
              {lines.map((l, i) => {
                const n = i + 1;
                const hit = n >= c.startLine && n <= c.endLine;
                return (
                  <div key={n} ref={n === c.startLine ? first : undefined} className={cn("flex", hit && "bg-agent/10")} data-hit={hit || undefined}>
                    <span className={cn("w-10 shrink-0 select-none pr-3 text-right text-muted-foreground", hit && "text-agent")}>{n}</span>
                    <span className="whitespace-pre pr-3">{l || " "}</span>
                  </div>
                );
              })}
            </pre>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
