import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Landmark, PencilLine, RefreshCw, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { PageSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api";
import { decide, SUMMARY_SECTIONS, useDecisions, useSummary, type SummaryContent } from "@/lib/captain";
import { relativeTime } from "@/lib/i18n";
import { COLUMNS, useTasks } from "@/lib/tasks";
import { cn } from "@/lib/utils";

/** Right-panel section: coloured dot + small heading + count; empty state stays quiet but present. */
export function PanelSection({ dot, title, count, empty, children }: { dot: string; title: string; count?: number; empty?: string; children?: ReactNode }) {
  const isEmpty = count === 0 || (count === undefined && !children);
  return (
    <section className="py-3 first:pt-1">
      <h3 className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
        <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
        {title}
        {count !== undefined && <span className="tabular-nums">{count}</span>}
      </h3>
      {isEmpty ? <p className="pl-3.5 text-[13px] text-muted-foreground/70">{empty ?? "暂无"}</p> : <div className="pl-3.5 text-[13.5px] leading-relaxed">{children}</div>}
    </section>
  );
}

function SeqLink({ projectId, groupId, seq }: { projectId: string; groupId: string; seq: number }) {
  return (
    <Link to="/projects/$projectId/chat" params={{ projectId }} search={{ g: groupId, seq }} className="font-mono text-[11px] text-muted-foreground hover:text-primary hover:underline">
      #{seq}
    </Link>
  );
}

/** Rolling summary maintained by the project captain (CAP-补3/5): sections cite messages by seq. */
export function SummaryTab({ projectId, groupId }: { projectId: string; groupId: string }) {
  const q = useSummary(groupId);
  const [editing, setEditing] = useState(false);
  const refresh = useMutation({
    mutationFn: () => unwrap(api.api.v1.groups({ id: groupId }).summary.refresh.post()),
    onSuccess: () => toast.success("已请船长刷新摘要"),
    onError: (e) => toast.error(e.message),
  });
  if (q.isPending) return <PageSkeleton rows={4} />;
  const s = q.data?.summary ?? null;
  return (
    <div data-testid="summary-tab">
      <div className="mb-1 flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        <Sparkles className="size-3.5 shrink-0 text-agent" />
        {s ? (
          <span className="min-w-0 flex-1">
            第 {s.version} 版 · 覆盖到 #{s.toSeq} · {relativeTime(s.createdAt)}
            {s.corrected ? " · 人工修正" : s.model.includes("heuristic") ? " · 规则兜底" : ""}
          </span>
        ) : (
          <span className="min-w-0 flex-1">船长还没有生成摘要；讨论多起来后会自动生成，也可以现在生成。</span>
        )}
        <Button variant="ghost" size="icon" className="size-6" aria-label="刷新摘要" title="刷新摘要" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          <RefreshCw className={cn("size-3.5", refresh.isPending && "animate-spin")} />
        </Button>
        {s && (
          <Button variant="ghost" size="icon" className="size-6" aria-label="修正摘要" title="修正摘要" onClick={() => setEditing(true)}>
            <PencilLine className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="divide-y">
        {SUMMARY_SECTIONS.map((sec) => {
          const items = s?.content[sec.key] ?? [];
          return (
            <PanelSection key={sec.key} dot={sec.dot} title={sec.label} count={items.length} empty={sec.empty}>
              <ul className="space-y-1.5">
                {items.map((it, i) => (
                  <li key={i}>
                    {it.text}{" "}
                    {it.seqs.slice(0, 3).map((n) => (
                      <SeqLink key={n} projectId={projectId} groupId={groupId} seq={n} />
                    ))}
                  </li>
                ))}
              </ul>
            </PanelSection>
          );
        })}
      </div>
      {s && <CorrectSummaryDialog open={editing} onOpenChange={setEditing} groupId={groupId} content={s.content} />}
    </div>
  );
}

/** Human correction → a new summary version (the old one is kept, CAP-补5). One line per item. */
function CorrectSummaryDialog({ open, onOpenChange, groupId, content }: { open: boolean; onOpenChange(v: boolean): void; groupId: string; content: SummaryContent }) {
  const toText = (k: keyof SummaryContent) => content[k].map((x) => `${x.text}${x.seqs.length ? ` #${x.seqs.join(" #")}` : ""}`).join("\n");
  const [draft, setDraft] = useState(() => Object.fromEntries(SUMMARY_SECTIONS.map((s) => [s.key, toText(s.key)])) as Record<keyof SummaryContent, string>);
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: () => {
      const parse = (txt: string) =>
        txt
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => ({ text: l.replace(/\s*#\d+/g, "").trim() || l, seqs: [...l.matchAll(/#(\d+)/g)].map((x) => Number(x[1])) }));
      const c = Object.fromEntries(SUMMARY_SECTIONS.map((s) => [s.key, parse(draft[s.key])])) as unknown as SummaryContent;
      return unwrap(api.api.v1.groups({ id: groupId }).summary.corrections.post({ content: c, note }));
    },
    onSuccess: () => {
      toast.success("已保存为新版本");
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>修正摘要</DialogTitle>
          <DialogDescription>每行一条，末尾用 #序号 标注来源。保存后生成新版本，旧版本保留可追溯。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
          {SUMMARY_SECTIONS.map((s) => (
            <div key={s.key} className="space-y-1">
              <Label className="flex items-center gap-2 text-xs">
                <span className={cn("size-1.5 rounded-full", s.dot)} /> {s.label}
              </Label>
              <Textarea rows={2} value={draft[s.key]} onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))} />
            </div>
          ))}
          <div className="space-y-1">
            <Label className="text-xs">修正说明</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：补充遗漏的风险" />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>
            保存新版本
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const DECISION_STATUS: Record<string, { label: string; cls: string }> = {
  proposed: { label: "待确认", cls: "bg-attention-soft" },
  confirmed: { label: "已确认", cls: "bg-ok-soft text-ok" },
  rejected: { label: "已驳回", cls: "bg-idle-soft text-muted-foreground" },
  revoked: { label: "已撤销", cls: "bg-idle-soft text-muted-foreground" },
};

export function DecisionsTab({ projectId, groupId, canDecide }: { projectId: string; groupId: string; canDecide: boolean }) {
  const q = useDecisions(groupId);
  const act = useMutation({
    mutationFn: (v: { id: string; action: "confirm" | "reject" | "revoke"; reason?: string }) => decide(v.id, v.action, v.reason),
    onError: (e) => toast.error(e.message),
  });
  if (q.isPending) return <PageSkeleton rows={3} />;
  const decisions = q.data ?? [];
  if (decisions.length === 0)
    return (
      <div className="flex flex-col items-center px-4 py-10 text-center">
        <span className="mb-3 grid size-10 place-items-center rounded-full bg-ok-soft text-ok">
          <Landmark className="size-5" />
        </span>
        <p className="text-sm font-medium">暂无决策</p>
        <p className="mt-1 text-xs text-muted-foreground">船长会从讨论里提炼决策，确认后沉淀在这里。</p>
      </div>
    );
  return (
    <ul className="space-y-2.5 pt-1" data-testid="decisions">
      {decisions.map((d) => (
        <li key={d.id} className="rounded-xl border bg-card p-3.5">
          <p className={cn("flex items-start gap-2 text-sm font-medium", (d.status === "rejected" || d.status === "revoked") && "text-muted-foreground line-through")}>
            <Landmark className="mt-0.5 size-4 shrink-0 text-ok" /> {d.text}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className={cn("rounded-full px-1.5 py-px font-medium", DECISION_STATUS[d.status]?.cls)}>{DECISION_STATUS[d.status]?.label ?? d.status}</span>
            {d.seq !== null && <SeqLink projectId={projectId} groupId={groupId} seq={d.seq} />}
            {d.revokedReason && <span>原因：{d.revokedReason}</span>}
            {canDecide && d.status === "proposed" && (
              <span className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => act.mutate({ id: d.id, action: "confirm" })}>
                  确认
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => {
                    const reason = window.prompt("驳回原因");
                    if (reason?.trim()) act.mutate({ id: d.id, action: "reject", reason });
                  }}
                >
                  驳回
                </Button>
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function TasksTab({ projectId, groupId }: { projectId: string; groupId: string }) {
  const q = useTasks(projectId, { groupId });
  if (q.isPending) return <PageSkeleton rows={3} />;
  const list = q.data ?? [];
  if (list.length === 0)
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm font-medium">暂无关联任务</p>
        <p className="mt-1 text-xs text-muted-foreground">从本群提议并确认、或由消息转成的任务会显示在这里。</p>
      </div>
    );
  return (
    <div className="divide-y" data-testid="group-tasks">
      {COLUMNS.filter((c) => list.some((t) => t.status === c.status)).map((c) => (
        <PanelSection key={c.status} dot={c.dot} title={c.label} count={list.filter((t) => t.status === c.status).length}>
          <ul className="space-y-1">
            {list
              .filter((t) => t.status === c.status)
              .map((t) => (
                <li key={t.id}>
                  <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: t.id }} className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted">
                    <span className="font-mono text-[11px] text-muted-foreground">{t.ref}</span>
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  </Link>
                </li>
              ))}
          </ul>
        </PanelSection>
      ))}
    </div>
  );
}
