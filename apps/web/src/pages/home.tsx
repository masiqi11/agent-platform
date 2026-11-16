import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertOctagon, CheckCircle2, Compass, FolderKanban, GitPullRequest, Inbox, Loader, Plus, Send } from "lucide-react";
import { useState } from "react";
import { PrincipalAvatar } from "@/components/agent-avatar";
import { EmptyState, ErrorState, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, newIdempotencyKey, unwrap } from "@/lib/api";
import { relativeTime, t } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { useProjects, type ProjectCard } from "@/lib/projects";
import { qk, queryClient } from "@/lib/query";
import { cn } from "@/lib/utils";

function Stat({ icon: Icon, n, label, tone }: { icon: typeof Loader; n: number; label: string; tone: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground" title={label}>
      <Icon className={cn("size-3.5", n > 0 ? tone : "text-muted-foreground/60")} aria-hidden />
      <span className={cn("font-medium tabular-nums", n > 0 && "text-foreground")}>{n}</span>
      <span>{label}</span>
    </div>
  );
}

function ProjectCardView({ p }: { p: ProjectCard }) {
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: p.id }}
      className="group flex flex-col rounded-lg border bg-card p-4 transition-colors hover:border-ring/40 focus-visible:border-ring"
      data-testid="project-card"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 font-mono text-xs font-semibold text-primary">{p.key.slice(0, 3)}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium group-hover:text-primary">{p.name}</p>
          <p className="truncate text-xs text-muted-foreground">{p.description || p.key}</p>
        </div>
        {p.counts.blocked > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-foreground">
            <AlertOctagon className="size-3 text-danger" /> 有阻塞
          </span>
        )}
      </div>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1">
        <Stat icon={Loader} n={p.counts.inProgress} label="进行中" tone="text-info" />
        <Stat icon={AlertOctagon} n={p.counts.blocked} label="阻塞" tone="text-danger" />
        <Stat icon={GitPullRequest} n={p.counts.inReview} label="待评审" tone="text-attention" />
      </div>
      <div className="mt-4 flex items-center justify-between border-t pt-3">
        <div className="flex -space-x-1.5">
          {p.agents.slice(0, 5).map((a) => (
            <PrincipalAvatar key={a.id} name={a.name} kind="agent" size="sm" className={cn("ring-2 ring-card", a.status !== "active" && "opacity-40")} />
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{p.lastActivityAt ? `最近活动 ${relativeTime(p.lastActivityAt)}` : "暂无活动"}</span>
      </div>
    </Link>
  );
}

function CreateProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange(v: boolean): void }) {
  const navigate = useNavigate();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [idem] = useState(newIdempotencyKey);
  const m = useMutation({
    mutationFn: () => unwrap(api.api.v1.projects.post({ key, name, description }, { headers: { "idempotency-key": idem } })),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: qk.projects });
      onOpenChange(false);
      void navigate({ to: "/projects/$projectId/chat", params: { projectId: r.id }, search: { g: r.mainGroupId } });
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建项目</DialogTitle>
          <DialogDescription>会同时创建项目主群和项目船长 Agent，你将成为 Maintainer。项目 key 创建后不可修改。</DialogDescription>
        </DialogHeader>
        <form
          id="create-project"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <div className="grid grid-cols-[120px_1fr] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="p-key">Key</Label>
              <Input
                id="p-key"
                value={key}
                onChange={(e) =>
                  setKey(
                    e.target.value
                      .toUpperCase()
                      .replace(/[^A-Z0-9]/g, "")
                      .slice(0, 10),
                  )
                }
                placeholder="PAY"
                className="font-mono"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-name">名称</Label>
              <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="支付服务" required />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-desc">描述</Label>
            <Textarea id="p-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="这个项目负责什么" />
          </div>
          {m.error ? <ErrorState error={m.error} /> : null}
        </form>
        <DialogFooter>
          <Button type="submit" form="create-project" disabled={m.isPending || key.length < 2 || !name}>
            创建项目
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "问全局船长" (FR-CAP global): answers from the project directory + summaries, always with sources (INV-04). */
function AskGlobalCaptain() {
  const [q, setQ] = useState("");
  const m = useMutation({ mutationFn: (question: string) => unwrap(api.api.v1.captain.ask.post({ question })) });
  return (
    <Card className="gap-3 py-4" data-testid="ask-global">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Compass className="size-4 text-agent" /> 问全局船长
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) m.mutate(q.trim());
          }}
        >
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="例如：哪个项目在处理支付回调超时？" aria-label="问全局船长" />
          <Button type="submit" size="icon" aria-label="提问" disabled={m.isPending || !q.trim()}>
            {m.isPending ? <Loader className="size-4 animate-spin" /> : <Send className="size-4" />}
          </Button>
        </form>
        {m.error ? <ErrorState error={m.error} /> : null}
        {m.data && (
          <div className="rounded-lg bg-muted/50 p-3 text-[13.5px] leading-relaxed" data-testid="global-answer">
            <p className="whitespace-pre-wrap">{m.data.answer}</p>
            {m.data.sources.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {m.data.sources.map((s) => (
                  <Link
                    key={s.projectId}
                    to="/projects/$projectId"
                    params={{ projectId: s.projectId }}
                    className="rounded-full border bg-card px-2 py-0.5 font-mono text-[11px] hover:border-ring/50"
                    title={s.snippet}
                  >
                    来源 · {s.key}
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
        {!m.data && <p className="text-xs text-muted-foreground">依据各项目目录与群摘要回答；没有依据时会直接说“未检索到依据”。</p>}
      </CardContent>
    </Card>
  );
}

export function HomePage() {
  const { data: me } = useMe();
  const projects = useProjects();
  const [create, setCreate] = useState(false);
  const canCreate = me?.tenantRole === "owner";
  return (
    <div>
      <PageHeader
        title={t("home.greeting", { name: me?.displayName ?? "" })}
        description={me?.tenant.name}
        actions={
          canCreate ? (
            <Button onClick={() => setCreate(true)} data-testid="new-project">
              <Plus className="size-4" /> 新建项目
            </Button>
          ) : null
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <section aria-labelledby="projects-h">
          <h2 id="projects-h" className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <FolderKanban className="size-4" /> {t("home.projects")}
          </h2>
          {projects.isPending ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-40" />
              ))}
            </div>
          ) : projects.error ? (
            <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
          ) : projects.data.length === 0 ? (
            <EmptyState
              icon={FolderKanban}
              title="暂无项目"
              body={canCreate ? t("home.noProjects") : "你还没有加入任何项目，请联系项目 Maintainer 把你加进来。"}
              action={canCreate ? <Button onClick={() => setCreate(true)}>新建第一个项目</Button> : undefined}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {projects.data.map((p) => (
                <ProjectCardView key={p.id} p={p} />
              ))}
            </div>
          )}
        </section>
        <div className="space-y-4">
          <AskGlobalCaptain />
          <Card className="h-fit gap-3 py-4">
            <CardHeader className="px-4">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Inbox className="size-4 text-attention" /> {t("home.needs")}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4">
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4 text-ok" /> {t("home.nothing")}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
      <CreateProjectDialog open={create} onOpenChange={setCreate} />
    </div>
  );
}
