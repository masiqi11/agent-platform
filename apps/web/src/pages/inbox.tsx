import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AtSign, Bell, CheckCheck, GitMerge, HelpCircle, Inbox, ListTodo, Siren, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ProposalPanel } from "@/components/proposal-panel";
import { EmptyState, ErrorState, PageHeader, PageSkeleton } from "@/components/states";
import { StatusPill } from "@/components/task-bits";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { inboxQuery } from "@/lib/inbox";
import { useTask } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { APPROVAL_KIND } from "./task";

const KINDS = [
  { v: "all", label: "全部", icon: Inbox },
  { v: "approval", label: "审批", icon: GitMerge },
  { v: "proposal", label: "提议", icon: Sparkles },
  { v: "mention", label: "@我", icon: AtSign },
  { v: "escalation", label: "升级", icon: Siren },
  { v: "task", label: "任务", icon: ListTodo },
  { v: "question", label: "提问", icon: HelpCircle },
] as const;
const ICON: Record<string, typeof Inbox> = Object.fromEntries(KINDS.map((k) => [k.v, k.icon]));
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  if (m < 1440) return `${Math.round(m / 60)} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN");
};

export function InboxPage() {
  const [kind, setKind] = useState("all");
  const q = useQuery(inboxQuery(kind));
  const [selected, setSelected] = useState<string | null>(null);
  const items = q.data?.items ?? [];
  const current = items.find((i) => i.id === selected) ?? null;

  async function markRead(ids?: string[]) {
    try {
      await unwrap(api.api.v1.inbox.read.post(ids ? { ids } : { all: true }));
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    }
  }
  function open(id: string, read: boolean) {
    setSelected(id);
    if (!read) void markRead([id]);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="收件箱"
        description={q.data ? (q.data.unread ? `${q.data.unread} 条未读 · 只放需要你处理或知道的事` : "全部已读") : undefined}
        actions={
          (q.data?.unread ?? 0) > 0 && (
            <Button variant="outline" size="sm" onClick={() => void markRead()}>
              <CheckCheck className="size-4" /> 全部已读
            </Button>
          )
        }
      />
      <div className="mb-3 flex flex-wrap gap-1" role="tablist" aria-label="类型">
        {KINDS.map((k) => (
          <Button key={k.v} role="tab" aria-selected={kind === k.v} size="sm" variant={kind === k.v ? "secondary" : "ghost"} onClick={() => setKind(k.v)}>
            <k.icon className="size-3.5" /> {k.label}
          </Button>
        ))}
      </div>
      {q.isPending ? (
        <PageSkeleton />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={Bell} title="一切就绪" body={kind === "all" ? "没有需要你处理的事。审批、提议、@你的消息和升级都会出现在这里。" : "这个分类下没有内容。"} />
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
          <ul className="min-h-0 overflow-y-auto rounded-xl border bg-card" data-testid="inbox-list">
            {items.map((i) => {
              const Icon = ICON[i.kind] ?? Bell;
              return (
                <li key={i.id}>
                  <button
                    type="button"
                    onClick={() => open(i.id, i.read)}
                    aria-current={selected === i.id}
                    className={cn(
                      "flex w-full items-start gap-3 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/60",
                      selected === i.id && "bg-accent/60",
                      !i.read && "bg-attention-soft/30",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full",
                        i.kind === "escalation" ? "bg-danger-soft text-danger" : i.kind === "approval" ? "bg-attention-soft" : "bg-muted",
                      )}
                    >
                      <Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("line-clamp-2 text-sm", !i.read && "font-semibold")}>{i.title}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {i.projectKey ?? ""}
                        {i.count > 1 && ` · ${i.count} 条`} · {ago(i.updatedAt)}
                      </span>
                    </span>
                    {!i.read && <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-label="未读" />}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="min-h-0 overflow-y-auto rounded-xl border bg-card p-5" data-testid="inbox-detail">
            {current ? <Detail item={current} /> : <p className="py-16 text-center text-sm text-muted-foreground">选择左侧一条查看详情</p>}
          </div>
        </div>
      )}
    </div>
  );
}

type Item = NonNullable<Awaited<ReturnType<ReturnType<typeof inboxQuery>["queryFn"]>>>["items"][number];

function Detail({ item }: { item: Item }) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-muted-foreground">
          {item.projectName} · {ago(item.updatedAt)}
        </p>
        <h2 className="mt-0.5 text-lg font-semibold">{item.title}</h2>
      </div>
      {item.refType === "approval" ? (
        <ApprovalDetail id={item.refId} />
      ) : item.refType === "proposal" ? (
        <div className="rounded-lg border p-3">
          <ProposalPanel proposalId={item.refId} canDecide />
        </div>
      ) : item.refType === "task" ? (
        <TaskBrief taskId={item.refId} />
      ) : null}
      {item.link && item.projectId && (
        <Link to="/projects/$projectId/chat" params={{ projectId: item.projectId }} search={{ g: item.link.groupId, seq: item.link.seq }} className="inline-block text-sm text-primary hover:underline">
          在群聊中定位 →
        </Link>
      )}
    </div>
  );
}

function TaskBrief({ taskId }: { taskId: string }) {
  const t = useTask(taskId);
  if (t.isPending) return <PageSkeleton rows={2} />;
  if (t.error) return <ErrorState error={t.error} />;
  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{t.data.ref}</span>
        <StatusPill status={t.data.status} />
      </div>
      <p className="mt-1 font-medium">{t.data.title}</p>
      {t.data.blockedReason && t.data.status === "blocked" && <p className="mt-1 text-danger">{t.data.blockedReason}</p>}
      <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId: t.data.projectId, taskId }} className="mt-2 inline-block text-primary hover:underline">
        打开任务 →
      </Link>
    </div>
  );
}

const EVIDENCE_LABEL: Record<string, string> = {
  diff: "变更",
  ci: "CI",
  tests: "测试",
  review: "评审",
  cost: "成本",
  coverage: "覆盖率",
  risk: "风险",
  rollback: "回滚方案",
  mr: "MR",
  summary: "摘要",
};

function ApprovalDetail({ id }: { id: string }) {
  const a = useQuery({ queryKey: ["approval", id], queryFn: () => unwrap(api.api.v1.approvals({ id }).get()) });
  const task = useTask(a.data?.taskId ?? "");
  const [reason, setReason] = useState("");
  const [rejectTo, setRejectTo] = useState<"in_progress" | "blocked">("in_progress");
  const [busy, setBusy] = useState(false);
  if (a.isPending) return <PageSkeleton rows={3} />;
  if (a.error) return <ErrorState error={a.error} onRetry={() => void a.refetch()} />;
  const ap = a.data;
  const f = task.data?.facts;
  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    try {
      await unwrap(api.api.v1.approvals({ id }).decide.post({ decision, reason: reason.trim() || undefined, rejectTo: decision === "reject" ? rejectTo : undefined }));
      toast.success(decision === "approve" ? "已批准" : "已驳回");
      void a.refetch();
      void queryClient.invalidateQueries({ queryKey: ["task", ap.taskId] });
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  // Delivery checks only matter for code-bound approvals (merge / release).
  const checks: [string, boolean | undefined][] =
    f && (ap.kind === "merge" || ap.kind === "release")
      ? [
          ["CI 通过", f.ciPassed],
          ["评审通过", f.reviewApproved],
          ["测试通过", f.testPassed],
          ["证据齐全", f.evidenceComplete],
        ]
      : [];
  return (
    <div className="space-y-4" data-testid="approval-detail">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{APPROVAL_KIND[ap.kind] ?? ap.kind}审批</span>
        {task.data && (
          <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId: task.data.projectId, taskId: ap.taskId }} className="text-primary hover:underline">
            {task.data.ref} {task.data.title}
          </Link>
        )}
        {ap.headSha && <span className="font-mono text-xs text-muted-foreground">@ {ap.headSha.slice(0, 10)}</span>}
      </div>
      <p className="text-sm text-muted-foreground">
        {ap.requestedBy.name} 发起 · {ap.status === "pending" ? `${new Date(ap.expiresAt).toLocaleString("zh-CN")} 前处理，超时不会自动通过` : ap.decidedBy ? `${ap.decidedBy.name} 已处理` : ap.status}
      </p>
      <section>
        <h3 className="mb-1.5 text-sm font-semibold">证据</h3>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {checks.map(([label, ok]) => (
            <div key={label} className={cn("rounded-md border px-2.5 py-1.5 text-sm", ok ? "border-ok/40 bg-ok-soft/50" : "border-danger/30 bg-danger-soft/40")}>
              {ok ? "✓" : "✗"} {label}
            </div>
          ))}
        </div>
        {Object.keys(ap.evidence).length > 0 && (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {Object.entries(ap.evidence).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{EVIDENCE_LABEL[k] ?? k}</dt>
                <dd className="text-sm break-all">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      {ap.status === "pending" ? (
        <section className="space-y-2 border-t pt-3">
          <Textarea aria-label="审批意见" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="意见（驳回时必填）" />
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy} onClick={() => void decide("approve")}>
              批准
            </Button>
            <Button variant="outline" className="text-danger" disabled={busy || !reason.trim()} onClick={() => void decide("reject")}>
              驳回
            </Button>
            <Select value={rejectTo} onValueChange={(v) => setRejectTo(v as typeof rejectTo)}>
              <SelectTrigger className="h-8 w-36" aria-label="驳回到">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="in_progress">驳回到开发中</SelectItem>
                <SelectItem value="blocked">驳回到阻塞</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </section>
      ) : (
        ap.reason && <p className="border-t pt-3 text-sm">意见：{ap.reason}</p>
      )}
    </div>
  );
}
