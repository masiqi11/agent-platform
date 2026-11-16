import { nextStatuses } from "@ap/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertOctagon, Bot, KanbanSquare, Plus, Search } from "lucide-react";
import { useMemo, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { ErrorState, PageHeader, PageSkeleton } from "@/components/states";
import { CreateTaskDialog, NEEDS_INPUT, PriorityPill, runTransition, TransitionDialog, transitionErrorText } from "@/components/task-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMe } from "@/lib/me";
import { useAgents, useProject } from "@/lib/projects";
import { queryClient } from "@/lib/query";
import { COLUMNS, STATUS_LABEL, tk, useTasks, type Task, type TaskFilters, type TaskStatus } from "@/lib/tasks";
import { cn } from "@/lib/utils";

export function BoardPage({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const agents = useAgents(projectId);
  const me = useMe();
  const [q, setQ] = useState("");
  const [assignee, setAssignee] = useState("all");
  const [priority, setPriority] = useState("all");
  const [mine, setMine] = useState(false);
  const filters: TaskFilters = useMemo(
    () => ({
      q: q.trim() || undefined,
      assigneeAgentId: assignee === "all" ? undefined : assignee,
      priority: priority === "all" ? undefined : priority,
      ownerPrincipalId: mine ? me.data?.principalId : undefined,
    }),
    [q, assignee, priority, mine, me.data?.principalId],
  );
  const tasks = useTasks(projectId, filters);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState<Task | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [pending, setPending] = useState<{ task: Task; to: TaskStatus } | null>(null);
  const [snapped, setSnapped] = useState<string | null>(null);
  const navigate = useNavigate();
  const legal = useMemo(() => new Set(dragging ? nextStatuses(dragging.status) : []), [dragging]);
  const key = tk.tasks(projectId, filters);

  async function move(task: Task, to: TaskStatus, extra?: { reason: string; needs?: string }) {
    const before = queryClient.getQueryData<Task[]>(key);
    queryClient.setQueryData<Task[]>(key, (xs) => xs?.map((x) => (x.id === task.id ? { ...x, status: to } : x)));
    try {
      const r = await runTransition(task, to, extra);
      toast.success(`${task.ref} → ${r.label}`);
    } catch (e) {
      queryClient.setQueryData(key, before); // snap back
      setSnapped(task.id);
      setTimeout(() => setSnapped(null), 900);
      toast.error(transitionErrorText(e), { description: `${task.ref} 仍在「${STATUS_LABEL[task.status]}」` });
    }
  }
  function onDrop(e: DragEvent, to: TaskStatus) {
    e.preventDefault();
    setOver(null);
    const t = dragging;
    setDragging(null);
    if (!t || t.status === to) return;
    if (NEEDS_INPUT[to]) return setPending({ task: t, to });
    void move(t, to);
  }

  if (tasks.isPending && !tasks.data) return <PageSkeleton />;
  if (tasks.error) return <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />;
  const list = tasks.data ?? [];
  const devs = (agents.data ?? []).filter((a) => a.role === "dev");
  const filtered = Boolean(filters.q || filters.assigneeAgentId || filters.priority || filters.ownerPrincipalId);
  const canCreate = project.data?.myRole !== "viewer" && project.data?.status !== "archived";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="看板"
        description={`${project.data?.name ?? ""} · 拖动卡片变更状态；不满足门禁时卡片会弹回并说明缺什么。`}
        actions={
          canCreate && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> 新建任务
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2" role="search">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标题或编号" className="h-8 w-56 pl-8" aria-label="搜索任务" />
        </div>
        <Select value={assignee} onValueChange={setAssignee}>
          <SelectTrigger className="h-8 w-40" aria-label="按 Agent 筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部 Agent</SelectItem>
            {devs.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={priority} onValueChange={setPriority}>
          <SelectTrigger className="h-8 w-32" aria-label="按优先级筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部优先级</SelectItem>
            {["P0", "P1", "P2", "P3"].map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant={mine ? "secondary" : "ghost"} aria-pressed={mine} onClick={() => setMine((v) => !v)}>
          我负责的
        </Button>
        {filtered && (
          <Button
            size="sm"
            variant="link"
            onClick={() => {
              setQ("");
              setAssignee("all");
              setPriority("all");
              setMine(false);
            }}
          >
            清除筛选
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{list.filter((x) => x.status !== "cancelled").length} 个任务</span>
      </div>

      {list.length === 0 && !filtered ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-14 text-center">
          <div className="mb-3 grid size-10 place-items-center rounded-full bg-accent text-accent-foreground">
            <KanbanSquare className="size-5" />
          </div>
          <p className="font-medium">还没有任务</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">在群聊里讨论后由船长提议，或者直接新建一个任务。</p>
          {canCreate && (
            <Button className="mt-4" onClick={() => setCreating(true)}>
              <Plus className="size-4" /> 新建任务
            </Button>
          )}
        </div>
      ) : (
        <div className="-mx-1 flex min-h-0 flex-1 gap-3 overflow-x-auto px-1 pb-2" data-testid="board">
          {COLUMNS.map((col) => {
            const items = list.filter((x) => x.status === col.status);
            const isLegal = !dragging || dragging.status === col.status || legal.has(col.status);
            return (
              <section
                key={col.status}
                data-testid={`col-${col.status}`}
                aria-label={col.label}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(col.status);
                }}
                onDragLeave={() => setOver((o) => (o === col.status ? null : o))}
                onDrop={(e) => onDrop(e, col.status)}
                className={cn(
                  "flex w-64 shrink-0 flex-col rounded-xl border transition-colors",
                  col.tint,
                  over === col.status && (isLegal ? "ring-2 ring-ring" : "ring-2 ring-danger/60"),
                  dragging && !isLegal && "opacity-50",
                )}
              >
                <header className="flex items-center gap-2 px-3 pt-3 pb-2">
                  <span className={cn("size-2 rounded-full", col.dot)} aria-hidden />
                  <h2 className="text-sm font-semibold">{col.label}</h2>
                  <span className="ml-auto rounded-full bg-background/70 px-1.5 text-xs text-muted-foreground tabular-nums">{items.length}</span>
                </header>
                <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                  {items.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      projectId={projectId}
                      snapped={snapped === t.id}
                      onDragStart={() => setDragging(t)}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                      onOpen={() => void navigate({ to: "/projects/$projectId/tasks/$taskId", params: { projectId, taskId: t.id } })}
                    />
                  ))}
                  {items.length === 0 && <p className="px-1 py-4 text-center text-xs text-muted-foreground/70">{filtered ? "无匹配" : "暂无"}</p>}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {creating && <CreateTaskDialog projectId={projectId} open onClose={() => setCreating(false)} />}
      <TransitionDialog
        key={pending ? `${pending.task.id}-${pending.to}` : "none"}
        open={Boolean(pending)}
        to={pending?.to ?? null}
        onClose={() => setPending(null)}
        onSubmit={async (v) => {
          if (!pending) return;
          await move(pending.task, pending.to, v);
          setPending(null);
        }}
      />
    </div>
  );
}

function TaskCard({
  task: t,
  projectId,
  snapped,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  task: Task;
  projectId: string;
  snapped: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  return (
    <article
      draggable
      data-testid="task-card"
      data-ref={t.ref}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", t.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cn("group cursor-grab rounded-lg border bg-card p-2.5 shadow-xs transition hover:border-ring/50 active:cursor-grabbing", snapped && "animate-[shake_0.4s] border-danger")}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <Link
          to="/projects/$projectId/tasks/$taskId"
          params={{ projectId, taskId: t.id }}
          className="font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {t.ref}
        </Link>
        <PriorityPill priority={t.priority} />
        {t.type === "bug" || t.type === "hotfix" ? <span className="text-[10px] text-danger">{t.type === "bug" ? "缺陷" : "热修复"}</span> : null}
      </div>
      <button type="button" className="block w-full text-left text-sm leading-snug font-medium hover:underline" onClick={onOpen}>
        {t.title}
      </button>
      {t.status === "blocked" && t.blockedReason && (
        <p className="mt-1.5 flex items-start gap-1 text-xs text-danger">
          <AlertOctagon className="mt-px size-3 shrink-0" /> <span className="line-clamp-2">{t.blockedReason}</span>
        </p>
      )}
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        {t.assignee ? (
          <span className="inline-flex items-center gap-1 text-agent">
            <Bot className="size-3" /> {t.assignee.name}
          </span>
        ) : (
          <span className="italic">未分配</span>
        )}
        {t.acceptanceCriteria.length > 0 && <span className="tabular-nums">· {t.acceptanceCriteria.length} 条验收</span>}
        {t.reworkReviewCount + t.reworkTestCount > 0 && <span className="text-attention">· 返工 {t.reworkReviewCount + t.reworkTestCount}</span>}
        <span className="ml-auto truncate">{t.owners.map((o) => o.name).join("、")}</span>
      </div>
    </article>
  );
}
