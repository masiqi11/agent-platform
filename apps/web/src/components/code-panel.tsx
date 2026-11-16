import { AlertTriangle, ExternalLink, FileText, GitBranch, GitPullRequest, Hand, Square, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorState, PageSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api";
import { CI_LABEL, SESSION_STOP, codeKeys, useTaskCode } from "@/lib/code";
import { queryClient } from "@/lib/query";
import { tk, type TaskDetail } from "@/lib/tasks";
import { cn } from "@/lib/utils";

const short = (s?: string | null) => (s ? s.slice(0, 8) : "—");
const bytes = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const ART_LABEL: Record<string, string> = { patch: "补丁", log: "日志", test_report: "测试报告", screenshot: "截图", coverage: "覆盖率", doc: "文档" };

/**
 * Task "code" section (§13.3 任务详情 · S5): branch, MR, CI for the current head, diff scope,
 * evidence artifacts, model cost and the agent's sessions; owners can take over / hand back.
 */
export function CodePanel({ task: t }: { task: TaskDetail }) {
  const q = useTaskCode(t.id);
  const [taking, setTaking] = useState(false);
  const canControl = t.myRoles.includes("human_owner") || t.myRoles.includes("maintainer");
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: codeKeys.taskCode(t.id) });
    void queryClient.invalidateQueries({ queryKey: tk.task(t.id) });
  };
  async function handback() {
    try {
      await unwrap(api.api.v1.tasks({ id: t.id }).handback.post());
      toast.success("已交还给 Agent");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    }
  }
  async function cancelSession(id: string) {
    try {
      await unwrap(api.api.v1.sessions({ id }).cancel.post({ reason: "人工取消" }));
      toast.success("会话已取消");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    }
  }

  if (q.isPending) return <PageSkeleton rows={2} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const c = q.data;
  const terminal = t.status === "done" || t.status === "cancelled";
  return (
    <section data-testid="code-panel" className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">代码</h2>
        {c.takenOverBy && <span className="rounded-full bg-attention-soft px-2 py-0.5 text-xs">已被人工接管，Agent 暂停处理</span>}
        {canControl && !terminal && (
          <div className="ml-auto flex gap-1.5">
            {c.takenOverBy ? (
              <Button size="sm" variant="outline" onClick={() => void handback()}>
                <Undo2 className="size-3.5" /> 交还 Agent
              </Button>
            ) : (
              t.assignee && (
                <Button size="sm" variant="outline" onClick={() => setTaking(true)}>
                  <Hand className="size-3.5" /> 人工接管
                </Button>
              )
            )}
          </div>
        )}
      </div>
      {c.workspaces.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
          {t.assignee ? "负责 Agent 开始工作后会在这里显示分支、MR 与 CI。" : "分配开发 Agent 并进入「就绪」后，Agent 会创建工作区开始开发。"}
        </p>
      ) : (
        c.workspaces.map((w) => {
          const ci = w.ci as { status?: string; sha?: string; url?: string } | null;
          const ciTone = CI_LABEL[ci?.status ?? ""];
          const stale = ci?.sha && w.headCommit && ci.sha !== w.headCommit;
          const diff = w.diffStat as { files?: number; additions?: number; deletions?: number; humanReviewRequired?: boolean; reasons?: string[] } | null;
          return (
            <div key={w.id} className="rounded-lg border bg-card text-sm" data-testid="workspace">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-3 py-2">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <GitBranch className="size-4 text-muted-foreground" />
                  <span className="text-muted-foreground">{w.repoName} /</span>
                  <span className="font-mono">{w.branch}</span>
                </span>
                <span className="font-mono text-xs text-muted-foreground" title={w.headCommit ?? ""}>
                  {short(w.baseCommit)} → {short(w.headCommit)}
                </span>
                {w.status === "released" && <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">工作区已回收</span>}
              </div>
              <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 px-3 py-2.5">
                <dt className="text-muted-foreground">MR</dt>
                <dd>
                  {w.mrRef ? (
                    w.mrUrl && w.provider === "gitlab" ? (
                      <a href={w.mrUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                        <GitPullRequest className="size-3.5" /> {w.mrRef} <ExternalLink className="size-3" />
                      </a>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <GitPullRequest className="size-3.5" /> {w.mrRef}
                        <span className="text-xs text-muted-foreground">（本地仓库）</span>
                      </span>
                    )
                  ) : (
                    <span className="text-muted-foreground">未创建</span>
                  )}
                </dd>
                <dt className="text-muted-foreground">CI</dt>
                <dd className="flex items-center gap-2" data-testid="ci-status">
                  {ciTone ? <span className={cn("rounded-full px-2 py-0.5 text-xs", ciTone.cls)}>{ciTone.label}</span> : <span className="text-muted-foreground">未运行</span>}
                  {ci?.sha && <span className="font-mono text-xs text-muted-foreground">@{short(ci.sha)}</span>}
                  {stale && <span className="text-xs text-attention">（针对旧提交）</span>}
                </dd>
                <dt className="text-muted-foreground">改动</dt>
                <dd>
                  {diff ? (
                    <span className="tabular-nums">
                      {diff.files} 个文件 <span className="text-ok">+{diff.additions}</span> <span className="text-danger">−{diff.deletions}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">暂无提交</span>
                  )}
                </dd>
              </dl>
              {diff?.humanReviewRequired && (
                <p className="flex items-start gap-1.5 border-t bg-attention-soft/40 px-3 py-2 text-xs">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  需要人类评审：{(diff.reasons ?? []).join("；")}
                </p>
              )}
            </div>
          );
        })
      )}
      {c.artifacts.length > 0 && (
        <div className="rounded-lg border bg-card px-3 py-2 text-sm">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">证据产物</h3>
          <ul className="space-y-1">
            {c.artifacts.map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                <FileText className="size-3.5 text-muted-foreground" />
                <span className="rounded bg-muted px-1.5 text-xs">{ART_LABEL[a.kind] ?? a.kind}</span>
                <span className="truncate font-mono text-xs">{a.name}</span>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{bytes(a.size)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="rounded-lg border bg-card px-3 py-2 text-sm" data-testid="task-cost">
        <div className="flex items-center gap-3">
          <h3 className="text-xs font-medium text-muted-foreground">成本</h3>
          <span className="tabular-nums">{c.cost.calls} 次模型调用</span>
          <span className="tabular-nums">{c.cost.tokens.toLocaleString()} tokens</span>
          <span className="tabular-nums">${c.cost.costUsd.toFixed(4)}</span>
        </div>
        {c.cost.sessions.length > 0 && (
          <ul className="mt-1.5 space-y-1 border-t pt-1.5">
            {c.cost.sessions.map((s) => {
              const live = ["running", "queued", "idle", "suspended", "interrupted"].includes(s.status);
              return (
                <li key={s.id} className="flex items-center gap-2 text-xs">
                  <span className={cn("size-2 rounded-full", s.status === "running" ? "bg-info" : live ? "bg-idle" : "bg-muted-foreground/30")} />
                  <span className="font-mono text-muted-foreground">{s.id.slice(-8)}</span>
                  <span>{s.status === "running" ? "运行中" : (SESSION_STOP[s.stopReason ?? ""] ?? s.stopReason ?? s.status)}</span>
                  <span className="text-muted-foreground tabular-nums">{s.steps} 步</span>
                  {canControl && live && (
                    <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs text-danger" onClick={() => void cancelSession(s.id)}>
                      <Square className="size-3" /> 取消会话
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <TakeoverDialog taskId={t.id} open={taking} onClose={() => setTaking(false)} onDone={refresh} />
    </section>
  );
}

function TakeoverDialog({ taskId, open, onClose, onDone }: { taskId: string; open: boolean; onClose(): void; onDone(): void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>人工接管任务？</DialogTitle>
          <DialogDescription>Agent 的会话会立即结束，之后不再被唤醒；分支与 MR 保留，你可以自己提交。接管人之后不能再评审这个任务。</DialogDescription>
        </DialogHeader>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="接管原因（必填）" aria-label="接管原因" />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!reason.trim() || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await unwrap(api.api.v1.tasks({ id: taskId }).takeover.post({ reason: reason.trim() }));
                toast.success("已接管");
                onDone();
                onClose();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "操作失败");
              } finally {
                setBusy(false);
              }
            }}
          >
            接管
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
