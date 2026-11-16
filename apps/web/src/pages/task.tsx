import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Bot, Check, CircleDashed, GitMerge, MessageSquare, Minus, ShieldCheck, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PrincipalAvatar } from "@/components/agent-avatar";
import { Markdown } from "@/components/markdown";
import { ErrorState, PageSkeleton } from "@/components/states";
import { NEEDS_INPUT, PriorityPill, runTransition, StatusPill, TransitionDialog, transitionErrorText } from "@/components/task-bits";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, unwrap } from "@/lib/api";
import { useAgents } from "@/lib/projects";
import { qk, queryClient } from "@/lib/query";
import { STATUS_LABEL, tk, useTask, type TaskDetail, type TaskStatus } from "@/lib/tasks";
import { cn } from "@/lib/utils";

const fmt = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const TYPE_LABEL: Record<string, string> = { feature: "功能", bug: "缺陷", hotfix: "热修复", chore: "杂项" };

/** Gate checklist: what the state machine looks at, in delivery order (§12.6 / §13.3). */
const GATES: { key: keyof TaskDetail["facts"]; label: string }[] = [
  { key: "hasAcceptanceCriteria", label: "验收标准" },
  { key: "hasAssignee", label: "负责 Agent" },
  { key: "hasHumanOwner", label: "人类 owner" },
  { key: "workspaceReady", label: "工作区就绪" },
  { key: "mrOpened", label: "MR 已创建" },
  { key: "ciPassed", label: "CI 通过" },
  { key: "evidenceComplete", label: "证据齐全" },
  { key: "reviewApproved", label: "评审通过" },
  { key: "testPlanExists", label: "测试计划" },
  { key: "testPassed", label: "测试通过" },
  { key: "mergeApproved", label: "合并审批" },
  { key: "merged", label: "已合并" },
];

export function TaskPage({ projectId, taskId }: { projectId: string; taskId: string }) {
  const q = useTask(taskId);
  const [pending, setPending] = useState<TaskStatus | null>(null);
  if (q.isPending) return <PageSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const t = q.data;
  const terminal = t.status === "done" || t.status === "cancelled";

  async function go(to: TaskStatus, extra?: { reason: string; needs?: string }) {
    try {
      const r = await runTransition(t, to, extra);
      toast.success(`${t.ref} → ${r.label}`);
      setPending(null);
    } catch (e) {
      toast.error(transitionErrorText(e));
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <Link to="/projects/$projectId/board" params={{ projectId }} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> 返回看板
      </Link>
      <header className="mb-5 flex flex-wrap items-start gap-3 border-b pb-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono">{t.ref}</span>
            <PriorityPill priority={t.priority} />
            <span>{TYPE_LABEL[t.type] ?? t.type}</span>
            <span>· v{t.version}</span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{t.title}</h1>
          <div className="mt-2 flex items-center gap-2">
            <StatusPill status={t.status} />
            {t.status === "blocked" && t.blockedReason && (
              <span className="text-sm text-danger">
                {t.blockedReason}
                {t.blockedNeeds ? ` · 需要 ${t.blockedNeeds}` : ""}
              </span>
            )}
          </div>
        </div>
        {!terminal && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label="状态变更">
            {t.allowed
              .filter((a) => a.to !== "cancelled")
              .map((a) => (
                <Tooltip key={a.to}>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        size="sm"
                        variant={a.ok ? "default" : "outline"}
                        disabled={!a.ok}
                        onClick={() => (NEEDS_INPUT[a.to as TaskStatus] ? setPending(a.to as TaskStatus) : void go(a.to as TaskStatus))}
                      >
                        → {STATUS_LABEL[a.to]}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {!a.ok && <TooltipContent>{a.reason ?? "不满足条件"}</TooltipContent>}
                </Tooltip>
              ))}
            {t.allowed.some((a) => a.to === "cancelled" && a.ok) && (
              <Button size="sm" variant="ghost" className="text-danger" onClick={() => setPending("cancelled")}>
                取消任务
              </Button>
            )}
          </div>
        )}
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          <section>
            <h2 className="mb-2 text-sm font-semibold">概览</h2>
            {t.description ? <Markdown text={t.description} /> : <p className="text-sm text-muted-foreground italic">暂无描述</p>}
          </section>
          <Criteria task={t} />
          <Timeline taskId={t.id} />
          <Comments taskId={t.id} />
        </div>
        <aside className="space-y-5">
          <section className="rounded-xl border bg-card p-4" data-testid="gate-checklist">
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
              <ShieldCheck className="size-4" /> 门禁清单
            </h2>
            <ul className="space-y-1.5 text-sm">
              {GATES.filter((g) => g.key !== "mergeApproved" || t.facts.mergeApprovalRequired).map((g) => {
                const ok = Boolean(t.facts[g.key]);
                return (
                  <li key={g.key} className="flex items-center gap-2">
                    {ok ? <Check className="size-4 text-ok" aria-label="已满足" /> : <CircleDashed className="size-4 text-muted-foreground/60" aria-label="未满足" />}
                    <span className={cn(!ok && "text-muted-foreground")}>{g.label}</span>
                  </li>
                );
              })}
              {t.facts.openBlockers > 0 && <li className="text-danger">还有 {t.facts.openBlockers} 个未解决的阻塞</li>}
            </ul>
          </section>
          <People task={t} />
          <Approvals task={t} />
          {t.sourceMessageIds.length > 0 && t.groupId && (
            <section className="rounded-xl border bg-card p-4">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                <MessageSquare className="size-4" /> 来源
              </h2>
              <Link to="/projects/$projectId/chat" params={{ projectId }} search={{ g: t.groupId }} className="text-sm text-primary hover:underline">
                在群聊中查看 {t.sourceMessageIds.length} 条来源消息
              </Link>
            </section>
          )}
        </aside>
      </div>
      <TransitionDialog key={pending ?? "none"} open={Boolean(pending)} to={pending} onClose={() => setPending(null)} onSubmit={(v) => go(pending!, v)} />
    </div>
  );
}

function Criteria({ task: t }: { task: TaskDetail }) {
  const editable = t.status !== "done" && t.status !== "cancelled";
  async function setVerdict(id: string, verdict: "met" | "unmet" | "na") {
    try {
      await unwrap(
        api.api.v1.tasks({ id: t.id }).patch({ acceptanceCriteria: t.acceptanceCriteria.map((c) => (c.id === id ? { ...c, verdict } : c)) }, { headers: { "if-match": String(t.version) } }),
      );
      void queryClient.invalidateQueries({ queryKey: tk.task(t.id) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败");
    }
  }
  const met = t.acceptanceCriteria.filter((c) => c.verdict === "met").length;
  return (
    <section data-testid="criteria">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        验收标准{" "}
        <span className="text-xs font-normal text-muted-foreground tabular-nums">
          {met}/{t.acceptanceCriteria.length} 已满足
        </span>
      </h2>
      {t.acceptanceCriteria.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">还没有验收标准。没有验收标准的任务不能进入「就绪」。</p>
      ) : (
        <ol className="divide-y rounded-lg border">
          {t.acceptanceCriteria.map((c, i) => (
            <li key={c.id} className="flex items-start gap-3 px-3 py-2">
              <span className="mt-0.5 font-mono text-xs text-muted-foreground">{i + 1}</span>
              <span className={cn("flex-1 text-sm", c.verdict === "met" && "text-muted-foreground line-through decoration-ok/60")}>{c.text}</span>
              <div className="flex gap-0.5" role="group" aria-label={`第 ${i + 1} 条结论`}>
                {(
                  [
                    ["met", Check, "满足", "text-ok"],
                    ["unmet", X, "未满足", "text-danger"],
                    ["na", Minus, "不适用", "text-muted-foreground"],
                  ] as const
                ).map(([v, Icon, label, cls]) => (
                  <button
                    key={v}
                    type="button"
                    disabled={!editable}
                    aria-pressed={c.verdict === v}
                    title={label}
                    aria-label={label}
                    onClick={() => void setVerdict(c.id, v)}
                    className={cn("grid size-6 place-items-center rounded hover:bg-muted disabled:opacity-50", c.verdict === v ? cn("bg-muted", cls) : "text-muted-foreground/50")}
                  >
                    <Icon className="size-3.5" />
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const EVENT_LABEL: Record<string, string> = {
  "task.created": "创建了任务",
  "task.assigned": "分配了 Agent",
  "task.updated": "更新了任务",
  "task.comment_added": "发表了评论",
  "task.follow_up_created": "创建了后续任务",
  "approval.requested": "发起了审批",
  "approval.decided": "处理了审批",
  "approval.invalidated": "审批因新提交失效",
  "approval.expired": "审批已超时",
  "escalation.raised": "触发升级",
};

function Timeline({ taskId }: { taskId: string }) {
  const q = useQuery({ queryKey: tk.timeline(taskId), queryFn: () => unwrap(api.api.v1.tasks({ id: taskId }).timeline.get()) });
  return (
    <section data-testid="timeline">
      <h2 className="mb-2 text-sm font-semibold">时间线</h2>
      {q.isPending ? (
        <PageSkeleton rows={3} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <ol className="relative space-y-3 border-l pl-4">
          {q.data.map((e) => {
            const p = e.payload as { from?: string; to?: string; reason?: string | null; missing?: string[]; level?: number };
            const denied = e.type === "task.transition_denied";
            return (
              <li key={e.seq} className="relative text-sm">
                <span
                  className={cn("absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-background", denied ? "bg-danger" : e.type === "task.status_changed" ? "bg-primary" : "bg-idle")}
                />
                <span className={cn("font-medium", e.actor.kind === "agent" && "text-agent")}>{e.actor.name}</span>{" "}
                {e.type === "task.status_changed" ? (
                  <>
                    将状态 <StatusPill status={p.from ?? ""} /> → <StatusPill status={p.to ?? ""} />
                  </>
                ) : denied ? (
                  <span className="text-danger">
                    尝试变更为「{STATUS_LABEL[p.to ?? ""]}」被拒绝{p.missing?.length ? `（缺少 ${p.missing.length} 项）` : ""}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{EVENT_LABEL[e.type] ?? e.type}</span>
                )}
                <span className="ml-2 text-xs text-muted-foreground">{fmt(e.createdAt)}</span>
                {p.reason ? <p className="mt-0.5 text-xs text-muted-foreground">“{p.reason}”</p> : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Comments({ taskId }: { taskId: string }) {
  const q = useQuery({ queryKey: tk.comments(taskId), queryFn: () => unwrap(api.api.v1.tasks({ id: taskId }).comments.get()) });
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold">评论</h2>
      <div className="space-y-3">
        {(q.data ?? []).map((c) => (
          <div key={c.id} className="flex gap-2.5">
            <PrincipalAvatar name={c.author.name} kind={c.author.kind === "agent" ? "agent" : "human"} size="sm" />
            <div className="min-w-0 flex-1 rounded-lg border bg-card px-3 py-2">
              <p className="mb-0.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{c.author.name}</span> · {fmt(c.createdAt)}
              </p>
              <Markdown text={c.body} />
            </div>
          </div>
        ))}
        {q.data?.length === 0 && <p className="text-sm text-muted-foreground">还没有评论。</p>}
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!body.trim()) return;
            setBusy(true);
            try {
              await unwrap(api.api.v1.tasks({ id: taskId }).comments.post({ body: body.trim() }));
              setBody("");
              void q.refetch();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "评论失败");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="写评论，支持 Markdown" rows={2} aria-label="评论" />
          <div className="flex justify-end">
            <Button size="sm" type="submit" disabled={busy || !body.trim()}>
              发表评论
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}

function People({ task: t }: { task: TaskDetail }) {
  const members = useQuery({ queryKey: qk.projectMembers(t.projectId), queryFn: () => unwrap(api.api.v1.projects({ id: t.projectId }).members.get()) });
  const [adding, setAdding] = useState(false);
  const agents = useAgents(t.projectId);
  const devs = (agents.data ?? []).filter((a) => a.role === "dev" && (a.status === "active" || a.id === t.assignee?.id));
  async function assign(agentId: string | null) {
    try {
      await unwrap(api.api.v1.tasks({ id: t.id }).patch({ assigneeAgentId: agentId }, { headers: { "if-match": String(t.version) } }));
      toast.success(agentId ? "已分配" : "已取消分配");
      void queryClient.invalidateQueries({ queryKey: tk.task(t.id) });
      void queryClient.invalidateQueries({ queryKey: ["tasks", t.projectId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "分配失败");
    }
  }
  const humans = (members.data ?? []).filter((m) => m.kind === "human" && !t.owners.some((o) => o.principalId === m.principalId) && m.role !== "viewer");
  async function addOwner(pid: string) {
    try {
      await unwrap(api.api.v1.tasks({ id: t.id }).owners({ principalId: pid }).put({ role: "owner" }));
      setAdding(false);
      void queryClient.invalidateQueries({ queryKey: tk.task(t.id) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "添加失败");
    }
  }
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4 text-sm">
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">负责 Agent</h3>
        {t.status === "done" || t.status === "cancelled" ? (
          t.assignee ? (
            <span className="inline-flex items-center gap-1.5 text-agent">
              <Bot className="size-4" /> {t.assignee.name}
            </span>
          ) : (
            <span className="text-muted-foreground italic">未分配</span>
          )
        ) : (
          <Select value={t.assignee?.id ?? "none"} onValueChange={(v) => void assign(v === "none" ? null : v)}>
            <SelectTrigger className="h-8" aria-label="负责 Agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">未分配</SelectItem>
              {devs.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <div>
        <h3 className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
          人类 owner
          {!adding && t.status !== "done" && (
            <button type="button" className="ml-auto inline-flex items-center gap-1 text-primary hover:underline" onClick={() => setAdding(true)}>
              <UserPlus className="size-3" /> 添加
            </button>
          )}
        </h3>
        <ul className="space-y-1">
          {t.owners.map((o) => (
            <li key={o.principalId} className="flex items-center gap-2">
              <PrincipalAvatar name={o.name} kind="human" size="sm" /> {o.name}
            </li>
          ))}
        </ul>
        {adding && (
          <Select onValueChange={(v) => void addOwner(v)}>
            <SelectTrigger className="mt-2 h-8" aria-label="选择 owner">
              <SelectValue placeholder="选择成员" />
            </SelectTrigger>
            <SelectContent>
              {humans.map((m) => (
                <SelectItem key={m.principalId} value={m.principalId}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {t.reviewers.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">人类评审</h3>
          {t.reviewers.map((o) => o.name).join("、")}
        </div>
      )}
      {t.dueAt && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">截止</h3>
          {fmt(t.dueAt)}
        </div>
      )}
    </section>
  );
}

const APPROVAL_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "待审批", cls: "bg-attention-soft" },
  approved: { label: "已通过", cls: "bg-ok-soft text-ok" },
  rejected: { label: "已驳回", cls: "bg-danger-soft text-danger" },
  expired: { label: "已超时", cls: "bg-muted text-muted-foreground" },
  invalidated: { label: "已失效", cls: "bg-muted text-muted-foreground" },
};
export const APPROVAL_KIND: Record<string, string> = { merge: "合并", release: "发布", credential: "凭据", budget: "预算" };

function Approvals({ task: t }: { task: TaskDetail }) {
  const q = useQuery({ queryKey: tk.approvals(t.id), queryFn: () => unwrap(api.api.v1.tasks({ id: t.id }).approvals.get()) });
  const canRequest = t.facts.mergeApprovalRequired && !t.facts.mergeApproved && (t.status === "testing" || t.status === "in_review");
  return (
    <section className="rounded-xl border bg-card p-4 text-sm">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <GitMerge className="size-4" /> 审批
      </h2>
      {(q.data ?? []).length === 0 && <p className="text-muted-foreground">暂无审批</p>}
      <ul className="space-y-2">
        {(q.data ?? []).map((a) => {
          const st = APPROVAL_STATUS[a.status] ?? { label: a.status, cls: "bg-muted" };
          return (
            <li key={a.id} className="rounded-md border px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <span className="font-medium">{APPROVAL_KIND[a.kind] ?? a.kind}</span>
                <span className={cn("rounded-full px-1.5 text-xs", st.cls)}>{st.label}</span>
                {a.headSha && <span className="ml-auto font-mono text-[11px] text-muted-foreground">{a.headSha.slice(0, 7)}</span>}
              </div>
              <p className="text-xs text-muted-foreground">
                {a.requestedBy.name} 发起
                {a.decidedBy ? ` · ${a.decidedBy.name} 处理` : ` · ${fmt(a.expiresAt)} 前`}
              </p>
              {a.reason && <p className="mt-0.5 text-xs">“{a.reason}”</p>}
            </li>
          );
        })}
      </ul>
      {canRequest && (
        <Button
          size="sm"
          variant="outline"
          className="mt-2 w-full"
          onClick={async () => {
            try {
              await unwrap(api.api.v1.tasks({ id: t.id }).approvals.post({ kind: "merge" }));
              toast.success("已发起合并审批");
              void q.refetch();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "发起失败");
            }
          }}
        >
          发起合并审批
        </Button>
      )}
    </section>
  );
}
