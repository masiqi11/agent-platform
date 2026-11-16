import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Bot, CircleDot, KanbanSquare, MessagesSquare, Users } from "lucide-react";
import type { ReactNode } from "react";
import { PrincipalAvatar } from "@/components/agent-avatar";
import { StatusDot } from "@/components/badges";
import { EmptyState, ErrorState, PageHeader, PageSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { api, unwrap } from "@/lib/api";
import { relativeTime } from "@/lib/i18n";
import { AGENT_ROLE_LABEL, useAgents, useGroups, useProject, useProjects } from "@/lib/projects";
import { qk } from "@/lib/query";

function Panel({ title, icon: Icon, action, children }: { title: string; icon: typeof Bot; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="ml-auto">{action}</div>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function ProjectHomePage({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const card = useProjects().data?.find((p) => p.id === projectId);
  const agents = useAgents(projectId);
  const groups = useGroups(projectId);
  const members = useQuery({ queryKey: qk.projectMembers(projectId), queryFn: () => unwrap(api.api.v1.projects({ id: projectId }).members.get()) });
  if (project.isPending) return <PageSkeleton />;
  if (project.error) return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;
  const p = project.data;
  const counts = card?.counts ?? { inProgress: 0, blocked: 0, inReview: 0, total: 0 };
  const unread = (groups.data ?? []).reduce((n, g) => n + g.unread, 0);
  const humans = (members.data ?? []).filter((m) => m.kind !== "agent");
  return (
    <div className="space-y-5">
      <PageHeader
        title={p.name}
        description={
          <span className="flex items-center gap-2">
            <span className="rounded bg-muted px-1.5 font-mono text-xs">{p.key}</span>
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
          ["进行中", counts.inProgress, "text-info"],
          ["阻塞", counts.blocked, "text-danger"],
          ["待评审", counts.inReview, "text-attention"],
          ["任务总数", counts.total, "text-foreground"],
        ].map(([label, n, cls]) => (
          <div key={label as string} className="rounded-xl border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${cls as string}`}>{n}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Panel title="迷你看板" icon={KanbanSquare}>
            {counts.total === 0 ? (
              <EmptyState icon={KanbanSquare} title="还没有任务" body="在群里描述需求并 @项目船长，它会提议拆分任务，确认后出现在看板上。" />
            ) : (
              <p className="text-sm text-muted-foreground">共 {counts.total} 个任务。</p>
            )}
          </Panel>
          <Panel title="风险与阻塞" icon={AlertTriangle}>
            {counts.blocked === 0 ? <EmptyState icon={CircleDot} title="一切正常" body="没有阻塞或超时的任务。" /> : <p className="text-sm text-danger">{counts.blocked} 个任务处于阻塞状态。</p>}
          </Panel>
        </div>
        <div className="space-y-4">
          <Panel
            title="Agent"
            icon={Bot}
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
              <ul className="space-y-2">
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
          <Panel title={`成员 · ${humans.length}`} icon={Users}>
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
