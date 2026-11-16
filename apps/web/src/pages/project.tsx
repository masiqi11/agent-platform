import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Bot, CircleDot, KanbanSquare, MessagesSquare } from "lucide-react";
import type { ReactNode } from "react";
import { PrincipalAvatar } from "@/components/agent-avatar";
import { StatusDot } from "@/components/badges";
import { ErrorState, PageHeader, PageSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { api, unwrap } from "@/lib/api";
import { relativeTime } from "@/lib/i18n";
import { AGENT_ROLE_LABEL, useAgents, useGroups, useProject, useProjects } from "@/lib/projects";
import { qk } from "@/lib/query";
import { COLUMNS, useTasks } from "@/lib/tasks";
import { cn } from "@/lib/utils";

/** Soft card with a dotted section heading (v2 visual language: dot + small title, no heavy rule). */
function Panel({ title, dot, count, action, children }: { title: string; dot: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card px-5 pt-4 pb-5">
      <header className="mb-3 flex items-center gap-2">
        <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
        <h2 className="text-[13px] font-medium text-muted-foreground">{title}</h2>
        {count !== undefined && <span className="text-[13px] text-muted-foreground tabular-nums">{count}</span>}
        <div className="ml-auto">{action}</div>
      </header>
      {children}
    </section>
  );
}

function QuietEmpty({ icon: Icon, title, body }: { icon: typeof Bot; title: string; body: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-muted/50 px-4 py-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-card text-muted-foreground">
        <Icon className="size-4" aria-hidden />
      </span>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

export function ProjectHomePage({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const card = useProjects().data?.find((p) => p.id === projectId);
  const agents = useAgents(projectId);
  const groups = useGroups(projectId);
  const members = useQuery({ queryKey: qk.projectMembers(projectId), queryFn: () => unwrap(api.api.v1.projects({ id: projectId }).members.get()) });
  const tasks = useTasks(projectId);
  if (project.isPending) return <PageSkeleton />;
  if (project.error) return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;
  const p = project.data;
  const counts = card?.counts ?? { inProgress: 0, blocked: 0, inReview: 0, total: 0 };
  const unread = (groups.data ?? []).reduce((n, g) => n + g.unread, 0);
  const humans = (members.data ?? []).filter((m) => m.kind !== "agent");
  const list = tasks.data ?? [];
  const risks = list.filter((t) => t.status === "blocked" || (t.priority === "P0" && t.status !== "done" && t.status !== "cancelled"));
  return (
    <div className="space-y-5">
      <PageHeader
        title={p.name}
        description={
          <span className="flex items-center gap-2">
            <span className="rounded-md bg-accent px-1.5 font-mono text-xs text-accent-foreground">{p.key}</span>
            {p.status === "archived" && <span className="rounded bg-muted px-1.5 text-xs">已归档 · 只读</span>}
            <span>{p.description || "暂无描述"}</span>
          </span>
        }
        actions={
          <Button asChild>
            <Link to="/projects/$projectId/chat" params={{ projectId }} search={{ g: p.mainGroupId ?? undefined }}>
              <MessagesSquare className="size-4" /> 进入对话{unread > 0 ? ` · ${unread} 未读` : ""}
            </Link>
          </Button>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["进行中", counts.inProgress, "bg-info"],
          ["阻塞", counts.blocked, "bg-danger"],
          ["待评审", counts.inReview, "bg-agent"],
          ["任务总数", counts.total, "bg-idle"],
        ].map(([label, n, dot]) => (
          <div key={label as string} className="rounded-2xl border bg-card px-5 py-4">
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", dot as string)} aria-hidden />
              {label}
            </p>
            <p className="mt-1.5 text-[26px] leading-none font-semibold tabular-nums">{n}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Panel
            title="迷你看板"
            dot="bg-primary"
            action={
              <Button variant="ghost" size="sm" asChild>
                <Link to="/projects/$projectId/board" params={{ projectId }}>
                  打开看板
                </Link>
              </Button>
            }
          >
            {list.length === 0 ? (
              <QuietEmpty icon={KanbanSquare} title="还没有任务" body="在群里描述需求并 @项目船长，它会提议拆分任务，确认后出现在看板上。" />
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="mini-board">
                {COLUMNS.filter((c) => c.status !== "done" || list.some((t) => t.status === "done"))
                  .slice(0, 8)
                  .map((c) => {
                    const items = list.filter((t) => t.status === c.status);
                    return (
                      <div key={c.status} className={cn("rounded-xl px-3 py-2.5", c.tint)}>
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className={cn("size-1.5 rounded-full", c.dot)} />
                          {c.label}
                          <span className="ml-auto tabular-nums">{items.length}</span>
                        </p>
                        <ul className="mt-1.5 space-y-1">
                          {items.slice(0, 2).map((t) => (
                            <li key={t.id}>
                              <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: t.id }} className="line-clamp-1 text-[13px] hover:underline">
                                {t.title}
                              </Link>
                            </li>
                          ))}
                          {items.length > 2 && <li className="text-[11px] text-muted-foreground">还有 {items.length - 2} 个</li>}
                        </ul>
                      </div>
                    );
                  })}
              </div>
            )}
          </Panel>
          <Panel title="风险与阻塞" dot="bg-danger" count={risks.length}>
            {risks.length === 0 ? (
              <QuietEmpty icon={CircleDot} title="一切正常" body="没有阻塞或 P0 任务。" />
            ) : (
              <ul className="space-y-2">
                {risks.map((t) => (
                  <li key={t.id} className="flex items-start gap-2.5 text-sm">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
                    <div className="min-w-0">
                      <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: t.id }} className="font-medium hover:underline">
                        {t.ref} {t.title}
                      </Link>
                      {t.blockedReason && <p className="text-xs text-muted-foreground">{t.blockedReason}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <div className="space-y-4">
          <Panel
            title="Agent"
            dot="bg-agent"
            count={agents.data?.length}
            action={
              <Button variant="ghost" size="sm" asChild>
                <Link to="/projects/$projectId/agents" params={{ projectId }}>
                  管理
                </Link>
              </Button>
            }
          >
            {agents.isPending ? (
              <PageSkeleton rows={2} />
            ) : (
              <ul className="space-y-2.5">
                {(agents.data ?? []).map((a) => (
                  <li key={a.id} className="flex items-center gap-2.5">
                    <PrincipalAvatar name={a.name} kind="agent" size="sm" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{a.name}</p>
                      <p className="text-[11px] text-muted-foreground">{AGENT_ROLE_LABEL[a.role] ?? a.role}</p>
                    </div>
                    <span className="ml-auto">
                      <StatusDot
                        tone={a.status === "active" ? "ok" : a.status === "paused" ? "attention" : "idle"}
                        label={a.status === "active" ? "空闲" : a.status === "paused" ? "已暂停" : "已停用"}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="成员" dot="bg-ok" count={humans.length}>
            <ul className="space-y-2">
              {humans.map((m) => (
                <li key={m.principalId} className="flex items-center gap-2.5 text-sm">
                  <PrincipalAvatar name={m.name} kind="human" size="sm" />
                  <span className="truncate">{m.name}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">{m.role === "maintainer" ? "维护者" : m.role === "viewer" ? "访客" : "成员"}</span>
                </li>
              ))}
            </ul>
            {card?.lastActivityAt && <p className="mt-3 text-[11px] text-muted-foreground">最近活动 {relativeTime(card.lastActivityAt)}</p>}
          </Panel>
        </div>
      </div>
    </div>
  );
}
