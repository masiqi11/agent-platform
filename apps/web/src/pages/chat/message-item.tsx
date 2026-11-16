import { CornerUpLeft, FileText, KanbanSquare, ListTodo, ListTree, MoreHorizontal, Paperclip, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { memo, useState } from "react";
import { PrincipalAvatar } from "@/components/agent-avatar";
import { Markdown } from "@/components/markdown";
import { ProposalPanel } from "@/components/proposal-panel";
import { StatusPill } from "@/components/task-bits";
import { Link } from "@tanstack/react-router";
import { useTask } from "@/lib/tasks";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api, unwrap } from "@/lib/api";
import { absoluteTime } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Msg } from "./timeline-store";

const CARD: Record<string, { label: string; cls: string }> = {
  summary_card: { label: "摘要", cls: "border-border bg-card" },
  proposal_card: { label: "任务提议", cls: "border-attention/30 bg-attention-soft/50" },
  task_card: { label: "任务", cls: "border-border bg-card" },
  question: { label: "问题", cls: "border-attention/30 bg-attention-soft/40" },
  decision_card: { label: "决策", cls: "border-ok/30 bg-ok-soft/50" },
};

export interface MessageActions {
  onReply(m: Msg): void;
  onEdit(m: Msg): void;
  onDelete(m: Msg): void;
  onThread(m: Msg): void;
  onOpenThread(threadId: string): void;
  onCreateTask(m: Msg): void;
  onRetry(m: Msg): void;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

async function openAttachment(id: string) {
  const r = await unwrap(api.api.v1.attachments({ id }).link.get());
  window.open(r.url, "_blank", "noopener,noreferrer");
}

export const MessageItem = memo(function MessageItem({
  m,
  compact,
  replies = 0,
  highlight,
  meId,
  canModerate,
  canDecide,
  mentionNames,
  projectKey,
  actions,
}: {
  m: Msg;
  compact: boolean;
  replies?: number;
  highlight: boolean;
  meId: string;
  canModerate: boolean;
  canDecide: boolean;
  mentionNames: string[];
  projectKey: string;
  actions: MessageActions;
}) {
  const isAgent = m.author.kind === "agent";
  const own = m.author.principalId === meId;
  const card = CARD[m.kind];
  const [mountedAt] = useState(() => Date.now()); // edit window evaluated at render start (stable)
  const editable = own && !isAgent && !m.deleted && !m.pending && mountedAt - new Date(m.createdAt).getTime() < 15 * 60_000;
  const deletable = !m.deleted && !m.pending && (own || canModerate);
  const mentionsMe = m.mentions.includes(meId);
  return (
    <div
      className={cn(
        "group relative flex gap-3.5 px-6 transition-colors hover:bg-muted/40",
        compact ? "py-1" : "pt-4 pb-1",
        highlight && "bg-attention-soft/70 hover:bg-attention-soft/70",
        mentionsMe && !highlight && "border-l-2 border-attention bg-attention-soft/25",
        m.pending && "opacity-70",
      )}
      data-seq={m.seq}
      data-testid="message"
    >
      <div className="w-9 shrink-0">
        {compact ? (
          <span className="invisible block pt-1 text-right text-[10px] text-muted-foreground group-hover:visible" title={absoluteTime(m.createdAt)}>
            {fmtTime(m.createdAt)}
          </span>
        ) : (
          <PrincipalAvatar name={m.author.name} kind={m.author.kind} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!compact && (
          <div className="flex items-baseline gap-2">
            <span className={cn("text-[14px] font-semibold", isAgent && "text-agent")}>{m.author.name}</span>
            {isAgent && <span className="rounded bg-agent-soft px-1 py-px text-[10px] font-medium text-agent">Agent</span>}
            {m.author.name !== m.author.currentName && <span className="text-[11px] text-muted-foreground">（现名 {m.author.currentName}）</span>}
            <span className="text-[11px] text-muted-foreground" title={absoluteTime(m.createdAt)}>
              {fmtTime(m.createdAt)}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground/60">#{m.seq > 0 ? m.seq : "…"}</span>
          </div>
        )}
        {m.replyTo && (
          <div className="mt-0.5 mb-1 flex items-center gap-1.5 border-l-2 pl-2 text-xs text-muted-foreground">
            <CornerUpLeft className="size-3" aria-hidden />
            <span className="font-medium">{m.replyTo.authorLabel}</span>
            <span className="truncate">{m.replyTo.excerpt}</span>
          </div>
        )}
        {m.deleted ? (
          <p className="text-sm italic text-muted-foreground">{m.body}</p>
        ) : card ? (
          <div className={cn("mt-1.5 mb-1 max-w-2xl rounded-xl border px-4 py-3", card.cls)}>
            <p className={cn("mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase", (m.kind === "proposal_card" || m.kind === "task_card") && "hidden")}>
              <FileText className="size-3.5" /> {card.label}
              {typeof m.blocks?.title === "string" ? <span className="normal-case tracking-normal text-foreground">· {m.blocks.title}</span> : null}
            </p>
            {m.kind === "proposal_card" && typeof m.blocks?.proposalId === "string" ? (
              <ProposalPanel proposalId={m.blocks.proposalId} canDecide={canDecide} compact />
            ) : m.kind === "task_card" && typeof m.blocks?.taskId === "string" ? (
              <TaskCardInline taskId={m.blocks.taskId} />
            ) : m.kind === "decision_card" && typeof m.blocks?.title === "string" ? (
              <Markdown text={m.body.split("\n").slice(1).join("\n").trim()} className="text-muted-foreground" />
            ) : (
              <Markdown text={m.body} mentionNames={mentionNames} projectKey={projectKey} />
            )}
          </div>
        ) : (
          <Markdown text={m.body} mentionNames={mentionNames} projectKey={projectKey} />
        )}
        {m.attachments.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {m.attachments.map((a) => (
              <button key={a.id} type="button" onClick={() => void openAttachment(a.id)} className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs hover:border-ring/50">
                <Paperclip className="size-3" /> {a.name} <span className="text-muted-foreground">{(a.size / 1024).toFixed(1)} KB</span>
                {a.scanStatus === "unscanned" && <span className="text-muted-foreground">· 未扫描</span>}
              </button>
            ))}
          </div>
        )}
        {m.threadId && replies > 0 && (
          <button
            type="button"
            onClick={() => actions.onOpenThread(m.threadId!)}
            className="mt-1 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-accent"
            data-testid="thread-replies"
          >
            <ListTree className="size-3.5" /> {replies} 条回复 · 查看线程
          </button>
        )}
        <div className="flex gap-2 text-[11px] text-muted-foreground">
          {m.editedAt && !m.deleted && <span title={absoluteTime(m.editedAt)}>（已编辑）</span>}
          {m.correctedAt && <span className="text-attention">已更正</span>}
          {m.pending === "sending" && <span>发送中…</span>}
          {m.pending === "failed" && (
            <button type="button" className="inline-flex items-center gap-1 text-danger hover:underline" onClick={() => actions.onRetry(m)}>
              <RotateCcw className="size-3" /> 发送失败，点击重发
            </button>
          )}
        </div>
      </div>
      {!m.pending && !m.deleted && (
        <div className="absolute -top-3 right-4 hidden items-center rounded-md border bg-popover shadow-sm group-hover:flex group-focus-within:flex">
          <Button variant="ghost" size="icon" className="size-7" aria-label="回复" onClick={() => actions.onReply(m)}>
            <CornerUpLeft className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" aria-label="开线程" onClick={() => actions.onThread(m)}>
            <ListTree className="size-3.5" />
          </Button>
          {canDecide && m.kind === "text" && (
            <Button variant="ghost" size="icon" className="size-7" aria-label="转为任务" title="转为任务" onClick={() => actions.onCreateTask(m)}>
              <ListTodo className="size-3.5" />
            </Button>
          )}
          {(editable || deletable) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" aria-label="更多">
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {editable && (
                  <DropdownMenuItem onClick={() => actions.onEdit(m)}>
                    <Pencil className="size-4" /> 编辑
                  </DropdownMenuItem>
                )}
                {deletable && (
                  <DropdownMenuItem variant="destructive" onClick={() => actions.onDelete(m)}>
                    <Trash2 className="size-4" /> 删除
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </div>
  );
});

/** Task card in the timeline: always shows the live status, not the status at posting time. */
function TaskCardInline({ taskId }: { taskId: string }) {
  const t = useTask(taskId);
  if (t.isPending) return <div className="h-10 animate-pulse rounded bg-muted/60" />;
  if (t.error) return <p className="text-sm text-muted-foreground">任务不可见或已删除</p>;
  return (
    <div className="flex items-center gap-2 text-sm" data-testid="task-card-inline">
      <KanbanSquare className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="font-mono text-xs text-muted-foreground">{t.data.ref}</span>
      <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId: t.data.projectId, taskId }} className="min-w-0 flex-1 truncate font-medium hover:underline">
        {t.data.title}
      </Link>
      <StatusPill status={t.data.status} />
      {t.data.assignee && <span className="text-xs text-agent">{t.data.assignee.name}</span>}
    </div>
  );
}
