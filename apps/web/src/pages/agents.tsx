import { Bot, MoreHorizontal, Pause, Pencil, Play, Plus, ShieldOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PrincipalAvatar } from "@/components/agent-avatar";
import { StatusDot } from "@/components/badges";
import { EmptyState, ErrorState, PageHeader, PageSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api";
import { useModels } from "@/lib/captain";
import { useMe } from "@/lib/me";
import { useAgentLoad } from "@/lib/code";
import { AGENT_ROLE_LABEL, useAgents, useProject, type Agent } from "@/lib/projects";
import { StatusPill } from "@/components/task-bits";
import { Link } from "@tanstack/react-router";
import { qk, queryClient } from "@/lib/query";

const STATUS: Record<string, { tone: "ok" | "attention" | "idle"; label: string }> = {
  active: { tone: "ok", label: "启用" },
  paused: { tone: "attention", label: "已暂停" },
  disabled: { tone: "idle", label: "已停用" },
};

export function AgentsPage({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const agents = useAgents(projectId);
  const load = useAgentLoad(projectId);
  const [editing, setEditing] = useState<Agent | "new" | null>(null);
  const [disabling, setDisabling] = useState<Agent | null>(null);
  const canManage = project.data?.canManage ?? false;
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.agents(projectId) });

  async function setStatus(a: Agent, status: "active" | "paused") {
    try {
      await unwrap(api.api.v1.agents({ id: a.id }).status.post({ status }));
      toast.success(status === "paused" ? `${a.name} 已暂停` : `${a.name} 已恢复`);
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    }
  }

  if (agents.isPending || project.isPending) return <PageSkeleton />;
  if (agents.error) return <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Agent"
        description={`${project.data?.name ?? ""} 的 Agent 目录。修改配置会生成新版本，进行中的运行继续使用旧版本。`}
        actions={
          canManage && (
            <Button onClick={() => setEditing("new")}>
              <Plus className="size-4" /> 新建 Agent
            </Button>
          )
        }
      />
      {agents.data.length === 0 ? (
        <EmptyState icon={Bot} title="还没有 Agent" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {agents.data.map((a) => {
            const st = STATUS[a.status] ?? STATUS.disabled!;
            const ld = load.data?.find((x) => x.agentId === a.id);
            const model = typeof a.modelPolicy.primary === "string" ? a.modelPolicy.primary : "按租户默认";
            return (
              <article key={a.id} className="rounded-xl border bg-card p-4" data-testid="agent-card">
                <div className="flex items-start gap-3">
                  <PrincipalAvatar name={a.name} kind="agent" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{a.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {AGENT_ROLE_LABEL[a.role] ?? a.role}
                      {a.projectId === null && " · 全局"} · v{a.configVersion}
                    </p>
                  </div>
                  <StatusDot tone={st.tone} label={st.label} />
                  {canManage && a.projectId !== null && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="size-7" aria-label={`${a.name} 操作`}>
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditing(a)}>
                          <Pencil className="size-4" /> 编辑配置
                        </DropdownMenuItem>
                        {a.status === "active" && (
                          <DropdownMenuItem onClick={() => void setStatus(a, "paused")}>
                            <Pause className="size-4" /> 暂停
                          </DropdownMenuItem>
                        )}
                        {a.status !== "active" && (
                          <DropdownMenuItem onClick={() => void setStatus(a, "active")}>
                            <Play className="size-4" /> 恢复
                          </DropdownMenuItem>
                        )}
                        {a.role !== "sub_captain" && a.status !== "disabled" && (
                          <DropdownMenuItem variant="destructive" onClick={() => setDisabling(a)}>
                            <ShieldOff className="size-4" /> 停用
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
                <p className="mt-3 line-clamp-2 min-h-10 text-sm text-muted-foreground">{a.instructions || "使用角色默认指令。"}</p>
                <dl className="mt-3 grid grid-cols-2 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">模型</dt>
                  <dd className="truncate font-mono">{model}</dd>
                  <dt className="text-muted-foreground">并发上限</dt>
                  <dd>{a.maxConcurrency}</dd>
                  <dt className="text-muted-foreground">工具</dt>
                  <dd className="truncate" title={a.toolAllowlist.join(", ")}>
                    {a.toolAllowlist.length} 个
                  </dd>
                  {ld && a.role !== "sub_captain" && (
                    <>
                      <dt className="text-muted-foreground">负载</dt>
                      <dd className="tabular-nums" data-testid="agent-load">
                        运行 {ld.running}/{ld.maxConcurrency}
                        {ld.queued > 0 && <span className="text-attention"> · 排队 {ld.queued}</span>} · 在手 {ld.activeTasks}
                      </dd>
                    </>
                  )}
                </dl>
                {ld && ld.recentTasks.length > 0 && (
                  <ul className="mt-3 space-y-1 border-t pt-2 text-xs">
                    {ld.recentTasks.slice(0, 3).map((rt) => (
                      <li key={rt.id} className="flex items-center gap-2">
                        <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: rt.id }} className="min-w-0 flex-1 truncate hover:underline">
                          <span className="font-mono text-muted-foreground">{rt.ref}</span> {rt.title}
                        </Link>
                        <StatusPill status={rt.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </div>
      )}
      <AgentDialog key={editing === null ? "none" : editing === "new" ? "new" : editing.id} projectId={projectId} agent={editing} onClose={() => setEditing(null)} onSaved={() => void refresh()} />
      <DisableDialog key={disabling?.id ?? "none"} agent={disabling} onClose={() => setDisabling(null)} onDone={() => void refresh()} />
    </div>
  );
}

function AgentDialog({ projectId, agent, onClose, onSaved }: { projectId: string; agent: Agent | "new" | null; onClose(): void; onSaved(): void }) {
  const isNew = agent === "new";
  const existing = agent && agent !== "new" ? agent : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [role, setRole] = useState<"dev" | "reviewer" | "tester">("dev");
  const [instructions, setInstructions] = useState(existing?.instructions ?? "");
  const [model, setModel] = useState(typeof existing?.modelPolicy.primary === "string" ? existing.modelPolicy.primary : "");
  const [fallback, setFallback] = useState(typeof existing?.modelPolicy.fallback === "string" ? existing.modelPolicy.fallback : "");
  const [conc, setConc] = useState(existing?.maxConcurrency ?? 1);
  const [busy, setBusy] = useState(false);
  const { data: me } = useMe();
  const models = useModels(me?.tenantRole === "owner" || me?.tenantRole === "admin");
  const modelNames = (models.data?.providers ?? []).flatMap((p) => p.models.map((m) => m.name));
  async function save() {
    setBusy(true);
    try {
      const common = {
        name: name.trim(),
        instructions,
        maxConcurrency: conc,
        modelPolicy: { ...(model.trim() ? { primary: model.trim() } : {}), ...(fallback.trim() ? { fallback: fallback.trim() } : {}) },
      };
      if (isNew) await unwrap(api.api.v1.projects({ id: projectId }).agents.post({ ...common, role }));
      else if (agent) await unwrap(api.api.v1.agents({ id: agent.id }).patch(common));
      toast.success(isNew ? "Agent 已创建" : "已保存，新配置对之后的运行生效");
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={agent !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? "新建 Agent" : "编辑 Agent"}</DialogTitle>
          <DialogDescription>Agent 是项目成员，可以被 @、分配任务；权限不会超过它的工具白名单。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="agent-name">名称</Label>
            <Input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="例如：开发 Agent A" />
          </div>
          {isNew && (
            <div className="grid gap-1.5">
              <Label>角色</Label>
              <Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
                <SelectTrigger aria-label="角色">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dev">开发</SelectItem>
                  <SelectItem value="reviewer">评审</SelectItem>
                  <SelectItem value="tester">测试</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="agent-ins">附加指令</Label>
            <Textarea id="agent-ins" value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={4} placeholder="补充到角色默认指令之后，例如代码风格约定。" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="agent-fallback">备用模型（主模型失败或熔断时使用）</Label>
            <Input id="agent-fallback" list="model-options" value={fallback} onChange={(e) => setFallback(e.target.value)} placeholder="可留空" className="font-mono" />
          </div>
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="agent-model">模型（留空用租户默认）</Label>
              <Input id="agent-model" list="model-options" value={model} onChange={(e) => setModel(e.target.value)} placeholder={models.data?.defaultModel ?? "gemma4:e2b"} className="font-mono" />
              <datalist id="model-options">
                {modelNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="agent-conc">并发上限</Label>
              <Input id="agent-conc" type="number" min={1} max={20} value={conc} onChange={(e) => setConc(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={!name.trim() || busy}>
            {isNew ? "创建" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DisableDialog({ agent, onClose, onDone }: { agent: Agent | null; onClose(): void; onDone(): void }) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open={agent !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>停用 {agent?.name}？</DialogTitle>
          <DialogDescription>停用后它的凭据立即失效、不再被唤醒；历史消息与运行记录保留。</DialogDescription>
        </DialogHeader>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="停用原因（必填）" aria-label="停用原因" />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={reason.trim().length < 2}
            onClick={async () => {
              try {
                await unwrap(api.api.v1.agents({ id: agent!.id }).status.post({ status: "disabled", reason }));
                toast.success("已停用");
                onDone();
                onClose();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "操作失败");
              }
            }}
          >
            停用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
