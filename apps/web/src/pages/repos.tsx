import { AlertTriangle, CheckCircle2, Copy, GitFork, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { StatusDot } from "@/components/badges";
import { EmptyState, ErrorState, PageHeader, PageSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api";
import { MQ_STATUS, REPO_STATUS, codeKeys, qualityKeys, useMergeQueue, useRepos, type Repo } from "@/lib/code";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { useProject } from "@/lib/projects";
import { queryClient } from "@/lib/query";

const fmt = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

type Check = { ok: boolean; defaultBranch: string; defaultBranchProtected: boolean; canPush: boolean; warnings: string[]; detail: string };

/** Project repositories + binding wizard (§12.7 仓库绑定向导: connectivity and permission checks). */
export function ReposPage({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const repos = useRepos(projectId);
  const [open, setOpen] = useState(false);
  const canManage = project.data?.canManage ?? false;
  const refresh = () => queryClient.invalidateQueries({ queryKey: codeKeys.repos(projectId) });

  async function recheck(r: Repo) {
    try {
      const c = await unwrap(api.api.v1.repos({ id: r.id }).check.post());
      toast[c.ok ? "success" : "error"](c.ok ? `连通性正常：${c.detail}` : c.detail);
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "检查失败");
    }
  }

  if (repos.isPending || project.isPending) return <PageSkeleton />;
  if (repos.error) return <ErrorState error={repos.error} onRetry={() => void repos.refetch()} />;
  return (
    <div className="space-y-5">
      <PageHeader
        title="仓库"
        description="开发 Agent 在这些仓库上建分支、提交、开 MR。凭据加密保存，只显示末 4 位；Agent 的沙箱里拿不到任何凭据。"
        actions={
          canManage && (
            <Button onClick={() => setOpen(true)}>
              <Plus className="size-4" /> 绑定仓库
            </Button>
          )
        }
      />
      {repos.data.length === 0 ? (
        <EmptyState
          icon={GitFork}
          title="还没有绑定仓库"
          body="绑定后，分配给开发 Agent 的任务会在独立分支上自动开发、推送并创建 MR。"
          action={
            canManage && (
              <Button onClick={() => setOpen(true)}>
                <Plus className="size-4" /> 绑定仓库
              </Button>
            )
          }
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {repos.data.map((r) => {
            const st = REPO_STATUS[r.status] ?? { label: r.status, tone: "attention" as const };
            return (
              <article key={r.id} className="rounded-xl border bg-card p-4 text-sm" data-testid="repo-card">
                <div className="flex items-start gap-3">
                  <span className="grid size-9 place-items-center rounded-lg bg-muted">
                    <GitFork className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{r.name}</p>
                    <p className="truncate text-xs text-muted-foreground" title={r.url}>
                      {r.provider === "gitlab" ? r.url : "本地仓库（开发 / 演示）"} · 默认分支 <span className="font-mono">{r.defaultBranch}</span>
                    </p>
                  </div>
                  <StatusDot tone={st.tone} label={st.label} />
                </div>
                <dl className="mt-3 grid grid-cols-[88px_1fr] gap-y-1 text-xs">
                  <dt className="text-muted-foreground">测试命令</dt>
                  <dd className="font-mono">{r.testCommand ?? "—"}</dd>
                  <dt className="text-muted-foreground">沙箱镜像</dt>
                  <dd className="font-mono">{r.image ?? "按部署默认"}</dd>
                  {r.provider === "gitlab" && (
                    <>
                      <dt className="text-muted-foreground">令牌</dt>
                      <dd className="font-mono">{r.tokenLast4 ? `••••${r.tokenLast4}` : "—"}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">默认分支保护</dt>
                  <dd>{r.lastCheck ? r.lastCheck.defaultBranchProtected ? "已保护" : <span className="text-attention">未保护</span> : "—"}</dd>
                </dl>
                {r.lastCheck && r.lastCheck.warnings.length > 0 && (
                  <ul className="mt-2 space-y-1 rounded-md bg-attention-soft/40 px-2.5 py-2 text-xs">
                    {r.lastCheck.warnings.map((w) => (
                      <li key={w} className="flex gap-1.5">
                        <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {w}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  {r.lastCheck ? `上次检查 ${fmt(r.lastCheck.at)}：${r.lastCheck.detail}` : "尚未检查"}
                  {canManage && (
                    <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={() => void recheck(r)}>
                      <RefreshCw className="size-3.5" /> 重新检查
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <MergeQueuePanel projectId={projectId} canManage={canManage} />
      {open && <BindDialog projectId={projectId} onClose={() => setOpen(false)} onDone={() => void refresh()} />}
    </div>
  );
}

/** The project's merge queue (FR-GIT-05): the only merger; paused when the default branch is red (GIT-补4). */
function MergeQueuePanel({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const q = useMergeQueue(projectId);
  if (q.isPending) return <PageSkeleton rows={2} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const { state, items } = q.data;
  async function resume() {
    try {
      await unwrap(api.api.v1.projects({ id: projectId })["merge-queue"].resume.post());
      toast.success("合并队列已恢复");
      void queryClient.invalidateQueries({ queryKey: qualityKeys.queue(projectId) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    }
  }
  return (
    <section className="space-y-2" data-testid="merge-queue">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        合并队列
        <span className="text-xs font-normal text-muted-foreground">变基 → CI → 合并 → 关闭 Issue；失败项转人工，不阻塞后续</span>
      </h2>
      {state.paused && (
        <div className="flex items-center gap-2 rounded-lg border border-danger/40 bg-danger-soft/40 px-3 py-2 text-sm">
          <AlertTriangle className="size-4 text-danger" />
          已暂停{state.reason === "main_red" ? `：默认分支 ${String(state.sha ?? "").slice(0, 8)} 流水线失败，恢复绿色后自动继续` : ""}
          {canManage && (
            <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => void resume()}>
              手动恢复
            </Button>
          )}
        </div>
      )}
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">队列为空。门禁全部满足（评审、测试、CI，以及按策略需要的合并审批）的任务会自动入队。</p>
      ) : (
        <ul className="divide-y rounded-xl border bg-card text-sm">
          {items.map((i) => {
            const st = MQ_STATUS[i.status] ?? { label: i.status, cls: "bg-muted" };
            return (
              <li key={i.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: i.taskId }} className="min-w-0 flex-1 truncate hover:underline">
                  <span className="font-mono text-muted-foreground">{i.ref}</span> {i.title}
                </Link>
                <span className={cn("rounded-full px-2 py-0.5 text-xs", st.cls)}>{st.label}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{(i.mergeSha ?? i.rebasedSha ?? i.headSha ?? "").slice(0, 8)}</span>
                {i.lastError && i.status !== "merged" && <span className="w-full text-xs text-danger">{i.lastError}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function CheckResult({ c }: { c: Check }) {
  return (
    <div className={c.ok ? "rounded-md border border-ok/30 bg-ok-soft/30 p-3 text-sm" : "rounded-md border border-danger/30 bg-danger-soft/30 p-3 text-sm"} data-testid="repo-check">
      <p className="flex items-center gap-1.5 font-medium">
        {c.ok ? <CheckCircle2 className="size-4 text-ok" /> : <AlertTriangle className="size-4 text-danger" />}
        {c.ok ? "连通性与权限检查通过" : "检查未通过"}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{c.detail}</p>
      <ul className="mt-2 space-y-0.5 text-xs">
        <li className="flex items-center gap-1.5">
          <ShieldCheck className="size-3" /> 默认分支 {c.defaultBranch}：{c.defaultBranchProtected ? "已保护" : "未保护"}
        </li>
        <li>可推送任务分支：{c.canPush ? "是" : "否"}</li>
        {c.warnings.map((w) => (
          <li key={w} className="text-attention">
            ⚠ {w}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BindDialog({ projectId, onClose, onDone }: { projectId: string; onClose(): void; onDone(): void }) {
  const [provider, setProvider] = useState<"local" | "gitlab">("local");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [caCert, setCaCert] = useState("");
  const [testCommand, setTestCommand] = useState("bun test");
  const [image, setImage] = useState("");
  const [check, setCheck] = useState<Check | null>(null);
  const [result, setResult] = useState<{ check: Check; webhook: { url: string; secret: string } | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const body = () => ({
    provider,
    name: name.trim(),
    testCommand: testCommand.trim() || undefined,
    image: image.trim() || undefined,
    ...(provider === "gitlab" ? { url: url.trim(), token: token.trim(), caCert: caCert.trim() || undefined } : {}),
  });
  const valid = /^[a-z0-9][a-z0-9._-]{0,62}$/.test(name.trim()) && (provider === "local" || (url.trim().startsWith("http") && token.trim().length > 8));

  async function preflight() {
    setBusy(true);
    try {
      setCheck(await unwrap(api.api.v1.projects({ id: projectId }).repos.preflight.post(body())));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "检查失败");
    } finally {
      setBusy(false);
    }
  }
  async function bind() {
    setBusy(true);
    try {
      const r = await unwrap(api.api.v1.projects({ id: projectId }).repos.post(body()));
      setResult({ check: r.check, webhook: r.webhook });
      setToken("");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "绑定失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{result ? "仓库已绑定" : "绑定仓库"}</DialogTitle>
          <DialogDescription>{result ? "以下信息只显示这一次，请现在复制。" : "平台只用最小权限：推送任务分支、创建 MR 与 Issue。默认分支只允许合并队列更新。"}</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-3">
            <CheckResult c={result.check} />
            {result.webhook && (
              <div className="space-y-2 rounded-md border p-3 text-sm">
                <p className="font-medium">在 GitLab 项目 → Settings → Webhooks 添加：</p>
                {(
                  [
                    ["URL", result.webhook.url],
                    ["Secret token", result.webhook.secret],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className="w-24 shrink-0 text-xs text-muted-foreground">{k}</span>
                    <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 text-xs">{v}</code>
                    <Button size="icon" variant="ghost" className="size-7" aria-label={`复制 ${k}`} onClick={() => void navigator.clipboard.writeText(v).then(() => toast.success("已复制"))}>
                      <Copy className="size-3.5" />
                    </Button>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">勾选 Pipeline、Merge request、Issues、Comments 事件。webhook 丢失时平台会轮询兜底。</p>
              </div>
            )}
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="grid grid-cols-[140px_1fr] gap-3">
              <div className="grid gap-1.5">
                <Label>类型</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => {
                    setProvider(v as "local" | "gitlab");
                    setCheck(null);
                  }}
                >
                  <SelectTrigger aria-label="仓库类型">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">本地仓库</SelectItem>
                    <SelectItem value="gitlab">GitLab</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="repo-name">名称</Label>
                <Input id="repo-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="payments" className="font-mono" />
              </div>
            </div>
            {provider === "local" ? (
              <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">在服务器的 LOCAL_SCM_DIR 下新建一个本地裸仓库，适合开发、演示与离线测试；Issue、MR、CI 由平台模拟。</p>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="repo-url">项目地址</Label>
                  <Input id="repo-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://gitlab.example.com/team/payments" />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="repo-token">项目访问令牌（Developer，scope: api）</Label>
                  <Input id="repo-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="glpat-…" />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="repo-ca">自签名 CA（可选，PEM）</Label>
                  <Textarea id="repo-ca" rows={2} value={caCert} onChange={(e) => setCaCert(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" className="font-mono text-xs" />
                </div>
              </>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="repo-test">测试命令</Label>
                <Input id="repo-test" value={testCommand} onChange={(e) => setTestCommand(e.target.value)} className="font-mono" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="repo-image">沙箱镜像（可选）</Label>
                <Input id="repo-image" value={image} onChange={(e) => setImage(e.target.value)} placeholder="按部署默认" className="font-mono" />
              </div>
            </div>
            {check && <CheckResult c={check} />}
          </div>
        )}
        <DialogFooter>
          {result ? (
            <Button onClick={onClose}>完成</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                取消
              </Button>
              {provider === "gitlab" && (
                <Button variant="outline" disabled={!valid || busy} onClick={() => void preflight()}>
                  检查连通性
                </Button>
              )}
              <Button disabled={!valid || busy || (provider === "gitlab" && !check?.ok)} onClick={() => void bind()}>
                绑定
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
