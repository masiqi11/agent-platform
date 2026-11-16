import { Check, CircleDashed, FlaskConical, GitMerge, MessageSquareWarning, RotateCcw, ShieldCheck, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { ErrorState, PageSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api";
import { MQ_STATUS, qualityKeys, useTaskGate, useTaskReviews, useTaskTests } from "@/lib/code";
import { queryClient } from "@/lib/query";
import { tk, type TaskDetail } from "@/lib/tasks";
import { cn } from "@/lib/utils";

const short = (s?: string | null) => (s ? s.slice(0, 8) : "—");
const fmt = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const VERDICT: Record<string, { label: string; cls: string }> = {
  met: { label: "满足", cls: "text-ok" },
  unmet: { label: "未满足", cls: "text-danger" },
  na: { label: "不适用", cls: "text-muted-foreground" },
};

function refreshAll(taskId: string) {
  for (const k of [qualityKeys.gate(taskId), qualityKeys.reviews(taskId), qualityKeys.tests(taskId), tk.task(taskId)]) void queryClient.invalidateQueries({ queryKey: k });
}

/**
 * Merge gate (§12.8, TRAP-8): each item with its state for the current head, the merge-queue
 * position/status, the release record and the rollback entry (GIT-补6).
 */
export function MergeGatePanel({ task: t }: { task: TaskDetail }) {
  const q = useTaskGate(t.id);
  const nav = useNavigate();
  const canControl = t.myRoles.includes("human_owner") || t.myRoles.includes("maintainer");
  if (q.isPending) return <PageSkeleton rows={2} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const g = q.data;
  const mq = g.merge;
  const st = mq ? MQ_STATUS[mq.status] : null;
  const relevant = t.status === "testing" || t.status === "done" || Boolean(mq);
  async function retry() {
    try {
      await unwrap(api.api.v1.tasks({ id: t.id }).merge.retry.post());
      toast.success("已重新检查并入队");
      refreshAll(t.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    }
  }
  async function rollback() {
    try {
      const r = await unwrap(api.api.v1.tasks({ id: t.id }).rollback.post());
      toast.success(`已创建回滚任务 ${r.ref}`);
      void nav({ to: "/projects/$projectId/tasks/$taskId", params: { projectId: t.projectId, taskId: r.id } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "创建失败");
    }
  }
  return (
    <section className="rounded-xl border bg-card p-4 text-sm" data-testid="merge-gate">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <GitMerge className="size-4" /> 合并门禁
        {relevant && (
          <span className={cn("ml-auto rounded-full px-2 py-0.5 text-xs font-normal", g.ok ? "bg-ok-soft text-ok" : "bg-muted text-muted-foreground")}>
            {g.ok ? "已满足" : `缺 ${g.missing.length} 项`}
          </span>
        )}
      </h2>
      <ul className="space-y-1.5">
        {g.items.map((i) => (
          <li key={i.key} className="flex items-center gap-2">
            {i.ok ? <Check className="size-4 text-ok" aria-label="已满足" /> : <CircleDashed className="size-4 text-muted-foreground/60" aria-label="未满足" />}
            <span className={cn(!i.ok && "text-muted-foreground")}>{i.label}</span>
          </li>
        ))}
      </ul>
      {g.queue.paused && (
        <p className="mt-3 rounded-md bg-danger-soft/50 px-2.5 py-1.5 text-xs text-danger">合并队列已暂停{g.queue.reason === "main_red" ? `：默认分支 ${short(g.queue.sha)} 流水线失败` : ""}</p>
      )}
      {mq && st && (
        <div className="mt-3 space-y-1 border-t pt-3" data-testid="merge-queue-status">
          <p className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">合并队列</span>
            <span className={cn("rounded-full px-2 py-0.5 text-xs", st.cls)}>{st.label}</span>
            {mq.rebasedSha && mq.rebasedSha !== mq.headSha && <span className="font-mono text-[11px] text-muted-foreground">变基后 {short(mq.rebasedSha)}</span>}
          </p>
          {mq.lastError && mq.status !== "merged" && <p className="text-xs text-danger">{mq.lastError}</p>}
          {mq.conflictFiles.length > 0 && (
            <ul className="list-inside list-disc font-mono text-xs text-danger">
              {mq.conflictFiles.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          {canControl && (mq.status === "needs_human" || mq.status === "failed") && t.status === "testing" && (
            <Button size="sm" variant="outline" className="mt-1 w-full" onClick={() => void retry()}>
              <RotateCcw className="size-3.5" /> 重新检查并入队
            </Button>
          )}
        </div>
      )}
      {g.release && (
        <div className="mt-3 space-y-0.5 border-t pt-3 text-xs" data-testid="release-record">
          <p className="font-medium text-foreground">发布记录</p>
          <p className="text-muted-foreground">
            {g.release.mrRef ?? "—"} · 合并提交 <span className="font-mono">{short(g.release.mergeCommit)}</span> · {fmt(g.release.createdAt)}
          </p>
          {t.status === "done" && canControl && (
            <Button size="sm" variant="ghost" className="mt-1 h-7 w-full text-danger" onClick={() => void rollback()}>
              <Undo2 className="size-3.5" /> 创建回滚任务
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/** Review rounds, commit-bound (stale ones marked), with the human reviewer's form (TSK-补5). */
export function ReviewsSection({ task: t }: { task: TaskDetail }) {
  const q = useTaskReviews(t.id);
  const [open, setOpen] = useState(false);
  const canReview = (t.myRoles.includes("human_reviewer") || t.myRoles.includes("maintainer")) && (t.status === "in_review" || t.status === "testing");
  return (
    <section data-testid="reviews">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="size-4" /> 评审
        {canReview && (
          <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => setOpen(true)}>
            人类评审
          </Button>
        )}
      </h2>
      {q.isPending ? (
        <PageSkeleton rows={2} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">提交评审后，评审 Agent 会在独立检出里逐条对照验收标准评审。</p>
      ) : (
        <ol className="space-y-2">
          {q.data.map((r) => (
            <li key={r.id} className={cn("rounded-lg border bg-card px-3 py-2 text-sm", !r.current && "opacity-70")} data-testid="review-round">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">第 {r.round} 轮</span>
                <span className={cn("rounded-full px-2 py-0.5 text-xs", r.verdict === "approved" ? "bg-ok-soft text-ok" : "bg-attention-soft")}>{r.verdict === "approved" ? "通过" : "要求修改"}</span>
                <span className={cn("text-xs", r.reviewer.kind === "agent" ? "text-agent" : "text-foreground")}>
                  {r.reviewer.name}
                  {r.reviewer.kind === "human" ? "（人类）" : ""}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">@{short(r.headSha)}</span>
                {!r.current && <span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">针对旧提交，已失效</span>}
                <span className="ml-auto text-xs text-muted-foreground">{fmt(r.createdAt)}</span>
              </div>
              {r.comments.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {r.comments.map((c, i) => (
                    <li key={i} className="flex gap-2 text-sm">
                      <MessageSquareWarning className="mt-0.5 size-3.5 shrink-0 text-attention" />
                      <span>
                        {c.path && (
                          <span className="mr-1 font-mono text-xs text-muted-foreground">
                            {c.path}
                            {c.line ? `:${c.line}` : ""}
                          </span>
                        )}
                        {c.body}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
      {open && <HumanReviewDialog taskId={t.id} criteria={t.acceptanceCriteria} onClose={() => setOpen(false)} />}
    </section>
  );
}

function HumanReviewDialog({ taskId, criteria, onClose }: { taskId: string; criteria: TaskDetail["acceptanceCriteria"]; onClose(): void }) {
  const [summary, setSummary] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(verdict: "approved" | "changes_requested") {
    setBusy(true);
    try {
      await unwrap(
        api.api.v1.tasks({ id: taskId }).reviews.post({
          verdict,
          summary: summary.trim() || undefined,
          comments: verdict === "changes_requested" && summary.trim() ? [{ ...(path.trim() ? { path: path.trim() } : {}), body: summary.trim() }] : undefined,
          criteria: verdict === "approved" ? Object.fromEntries(criteria.map((c) => [c.id, "met" as const])) : undefined,
        }),
      );
      toast.success(verdict === "approved" ? "评审已通过" : "已要求修改");
      refreshAll(taskId);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "提交失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>人类评审</DialogTitle>
          <DialogDescription>人类评审的结论优先于评审 Agent；结论绑定当前提交，之后有新提交会自动失效。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} placeholder="评审意见（要求修改时必填）" aria-label="评审意见" />
          <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="相关文件（可选），如 src/gateway.ts" className="font-mono text-sm" aria-label="相关文件" />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="outline" className="text-danger" disabled={busy || !summary.trim()} onClick={() => void submit("changes_requested")}>
            要求修改
          </Button>
          <Button disabled={busy} onClick={() => void submit("approved")}>
            通过
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Test runs (FR-REL-03): status per commit, per-criterion results with evidence. */
export function TestsSection({ task: t }: { task: TaskDetail }) {
  const q = useTaskTests(t.id);
  return (
    <section data-testid="tests">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <FlaskConical className="size-4" /> 测试
      </h2>
      {q.isPending ? (
        <PageSkeleton rows={2} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">评审通过后，测试 Agent 会在独立环境里运行测试，并逐条给出验收标准结论。</p>
      ) : (
        <ol className="space-y-2">
          {q.data.map((r) => (
            <li key={r.id} className={cn("rounded-lg border bg-card px-3 py-2 text-sm", !r.current && "opacity-70")} data-testid="test-run">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">第 {r.attempt} 次</span>
                <span className={cn("rounded-full px-2 py-0.5 text-xs", r.status === "passed" ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger")}>{r.status === "passed" ? "通过" : "未通过"}</span>
                <span className="text-xs">{r.tester.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">@{short(r.headSha)}</span>
                {r.durationMs !== null && <span className="text-xs text-muted-foreground tabular-nums">{(r.durationMs / 1000).toFixed(1)} s</span>}
                {!r.current && <span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">针对旧提交，已失效</span>}
                <span className="ml-auto text-xs text-muted-foreground">{fmt(r.createdAt)}</span>
              </div>
              <ul className="mt-1.5 space-y-0.5">
                {r.criteriaResults.map((c) => {
                  const v = VERDICT[c.verdict];
                  return (
                    <li key={c.id} className="flex gap-2 text-xs">
                      <span className={cn("w-12 shrink-0", v?.cls)}>{v?.label ?? c.verdict}</span>
                      <span className="min-w-0 flex-1">
                        {c.text}
                        {c.evidence && <span className="ml-1 text-muted-foreground">— {c.evidence}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
