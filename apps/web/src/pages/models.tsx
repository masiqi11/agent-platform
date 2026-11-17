import { useMutation, useQuery } from "@tanstack/react-query";
import { Cpu, Gauge, Globe2, HardDrive, KeyRound, Layers, PauseCircle, PlayCircle, Plug, Plus, Wallet } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorState, PageHeader, PageSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, unwrap } from "@/lib/api";
import { ck, useModels } from "@/lib/captain";
import { useProjects } from "@/lib/projects";
import { queryClient } from "@/lib/query";
import { cn } from "@/lib/utils";

const fmt = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function PauseCard() {
  const q = useQuery({ queryKey: ck.paused, queryFn: () => unwrap(api.api.v1.admin.agents.pause.get()) });
  const m = useMutation({
    mutationFn: (paused: boolean) => unwrap(api.api.v1.admin.agents.pause.post({ paused })),
    onSuccess: (r) => {
      queryClient.setQueryData(ck.paused, r);
      toast.success(r.paused ? "所有 Agent 已暂停" : "Agent 已恢复");
    },
    onError: (e) => toast.error(e.message),
  });
  const paused = q.data?.paused ?? false;
  return (
    <Card className={cn("gap-2 py-4", paused && "border-danger/40 bg-danger-soft/30")}>
      <CardContent className="flex items-center gap-3 px-4">
        <span className={cn("grid size-9 place-items-center rounded-full", paused ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok")}>
          {paused ? <PauseCircle className="size-5" /> : <PlayCircle className="size-5" />}
        </span>
        <div className="flex-1">
          <p className="text-sm font-medium">{paused ? "所有 Agent 已暂停" : "Agent 正常运行"}</p>
          <p className="text-xs text-muted-foreground">一键暂停：船长与开发 Agent 不再响应新的唤醒；进行中的步骤结束后停下。</p>
        </div>
        <Switch checked={paused} onCheckedChange={(v) => m.mutate(v)} aria-label="暂停所有 Agent" data-testid="pause-switch" />
      </CardContent>
    </Card>
  );
}

function AddProviderDialog({ open, onOpenChange }: { open: boolean; onOpenChange(v: boolean): void }) {
  const [name, setName] = useState("本地 Ollama");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434");
  const [dialect, setDialect] = useState<"openai" | "ollama">("ollama");
  const [isExternal, setExternal] = useState(false);
  const [apiKey, setKey] = useState("");
  const [model, setModel] = useState("gemma4:e2b");
  const [ctx, setCtx] = useState(8192);
  const [tools, setTools] = useState(true);
  const [json, setJson] = useState(true);
  const [thinkOff, setThinkOff] = useState(true);
  const [purpose, setPurpose] = useState<"chat" | "embed">("chat");
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.api.v1.admin.models.providers.post({
          name,
          baseUrl,
          dialect,
          isExternal,
          apiKey: apiKey || undefined,
          models: [purpose === "embed" ? { name: model, embeddingDim: 768 } : { name: model, contextWindow: ctx, supportsTools: tools, supportsJson: json, thinkOff }],
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ck.models });
      toast.success("已登记模型供应商");
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>登记模型供应商</DialogTitle>
          <DialogDescription>密钥加密保存，界面只显示末 4 位。外部供应商会受项目的数据外发策略约束。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>名称</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>协议</Label>
              <Select value={dialect} onValueChange={(v) => setDialect(v as "openai" | "ollama")}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ollama">Ollama 原生（/api/chat）</SelectItem>
                  <SelectItem value="openai">OpenAI 兼容（/v1/chat/completions）</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Base URL</Label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="font-mono text-xs" />
          </div>
          <div className="space-y-1.5">
            <Label>API Key（可选）</Label>
            <Input type="password" value={apiKey} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label>用途</Label>
            <Select
              value={purpose}
              onValueChange={(v) => {
                setPurpose(v as "chat" | "embed");
                if (v === "embed" && model === "gemma4:e2b") setModel("embeddinggemma");
                if (v === "chat" && model === "embeddinggemma") setModel("gemma4:e2b");
              }}
            >
              <SelectTrigger className="w-full" aria-label="用途">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="chat">对话模型（船长与 Agent）</SelectItem>
                <SelectItem value="embed">嵌入模型（知识库向量检索，须为 768 维）</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className={cn("grid gap-3", purpose === "chat" && "grid-cols-[1fr_120px]")}>
            <div className="space-y-1.5">
              <Label>模型名</Label>
              <Input value={model} onChange={(e) => setModel(e.target.value)} className="font-mono text-xs" />
            </div>
            {purpose === "chat" && (
              <div className="space-y-1.5">
                <Label>上下文窗口</Label>
                <Input type="number" value={ctx} onChange={(e) => setCtx(Number(e.target.value))} />
              </div>
            )}
          </div>
          {purpose === "embed" && <p className="text-xs text-muted-foreground">向量列固定为 768 维。本地可用 embeddinggemma（多语言）或 nomic-embed-text。登记后在「知识库嵌入」里选用。</p>}
          <div className="flex flex-wrap gap-4 text-sm">
            {(purpose === "embed"
              ? ([["外部供应商", isExternal, setExternal]] as const)
              : ([
                  ["工具调用", tools, setTools],
                  ["JSON 模式", json, setJson],
                  ["关闭思考（think:false）", thinkOff, setThinkOff],
                  ["外部供应商", isExternal, setExternal],
                ] as const)
            ).map(([l, v, set]) => (
              <label key={l} className="flex items-center gap-1.5">
                <Checkbox checked={v} onCheckedChange={(c) => set(c === true)} /> {l}
              </label>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !name || !baseUrl || !model}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProviderCard({ p, defaultModel, embeddingModel }: { p: NonNullable<ReturnType<typeof useModels>["data"]>["providers"][number]; defaultModel: string; embeddingModel: string | null }) {
  const [result, setResult] = useState<string | null>(null);
  const test = useMutation({
    mutationFn: () => unwrap(api.api.v1.admin.models.providers({ id: p.id }).test.post()),
    onSuccess: (r) => setResult(r.ok ? `连通 · ${(r.latencyMs / 1000).toFixed(1)}s` : `失败：${r.error ?? ""}`),
  });
  const setDefault = useMutation({
    mutationFn: (name: string) => unwrap(api.api.v1.admin.models.default.put({ name })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ck.models }),
    onError: (e) => toast.error(e.message),
  });
  const scripted = p.kind === "scripted";
  return (
    <div className="rounded-xl border bg-card p-4" data-testid="provider-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("grid size-8 place-items-center rounded-lg", p.isExternal ? "bg-attention-soft text-attention" : "bg-accent text-primary")}>
          {p.isExternal ? <Globe2 className="size-4" /> : scripted ? <Cpu className="size-4" /> : <HardDrive className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{p.name}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{p.baseUrl}</p>
        </div>
        <span className="rounded-full bg-muted px-2 py-px text-[11px]">{scripted ? "脚本模型" : p.dialect === "ollama" ? "Ollama 原生" : "OpenAI 兼容"}</span>
        <span className={cn("rounded-full px-2 py-px text-[11px]", p.isExternal ? "bg-attention-soft" : "bg-ok-soft text-ok")}>{p.isExternal ? "外部" : "本地"}</span>
        {p.circuit !== "closed" && <span className="rounded-full bg-danger-soft px-2 py-px text-[11px] text-danger">熔断中</span>}
        {p.keyLast4 && (
          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
            <KeyRound className="size-3" />
            ••••{p.keyLast4}
          </span>
        )}
        {!scripted && (
          <Button size="sm" variant="outline" className="h-7" disabled={test.isPending} onClick={() => test.mutate()}>
            <Plug className="size-3.5" /> {test.isPending ? "测试中…" : "连通性测试"}
          </Button>
        )}
      </div>
      {result && <p className={cn("mt-2 text-xs", result.startsWith("连通") ? "text-ok" : "text-danger")}>{result}</p>}
      <div className="mt-3 divide-y rounded-lg border">
        {p.models.map((m) => (
          <div key={m.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
            <span className="font-mono">{m.name}</span>
            {m.name === defaultModel && <span className="rounded-full bg-primary px-1.5 py-px text-[10px] text-primary-foreground">租户默认</span>}
            {m.name === embeddingModel && <span className="rounded-full bg-agent px-1.5 py-px text-[10px] text-white">知识库嵌入</span>}
            <span className="text-[11px] text-muted-foreground">
              {m.embeddingDim ? (
                `嵌入 · ${m.embeddingDim} 维`
              ) : (
                <>
                  {fmt(m.contextWindow)} 上下文{m.supportsTools ? " · 工具" : ""}
                  {m.supportsJson ? " · JSON" : ""}
                  {m.thinkOff ? " · think:false" : ""}
                </>
              )}
            </span>
            {m.notes && <span className="text-[11px] text-muted-foreground">· {m.notes}</span>}
            {!m.embeddingDim && m.name !== defaultModel && (
              <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" onClick={() => setDefault.mutate(m.name)}>
                设为默认
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** §8.7: which model embeds the knowledge base. Changing it rebuilds every index (queries keep the old one until each switch). */
function EmbeddingCard() {
  const q = useModels();
  const [pending, setPending] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (name: string | null) => unwrap(api.api.v1.admin.models.embedding.put({ name })),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ck.models });
      toast.success(r.changed ? `已切换，已排队重建 ${r.rebuildQueued} 个索引` : "未变化");
      setPending(null);
    },
    onError: (e) => toast.error(e.message),
  });
  if (!q.data) return null;
  const options = q.data.providers.flatMap((p) => p.models.filter((m) => m.embeddingDim === 768).map((m) => ({ name: m.name, provider: p.name, external: p.isExternal })));
  const current = q.data.embeddingModel ?? "__off";
  const value = pending ?? current;
  return (
    <div className="rounded-xl border bg-card p-4" data-testid="embedding-card">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Layers className="size-4" /> 知识库嵌入
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">知识库向量检索用的模型（768 维）。切换后所有项目的索引会在后台全量重建，重建完成前查询仍用旧索引。</p>
      <div className="mt-3 flex gap-2">
        <Select value={value} onValueChange={setPending}>
          <SelectTrigger className="min-w-0 flex-1 truncate" aria-label="嵌入模型">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.name} value={o.name}>
                {o.name} · {o.provider}
                {o.external ? "（外部）" : ""}
              </SelectItem>
            ))}
            <SelectItem value="__off">关闭向量检索</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" className="shrink-0" disabled={value === current || save.isPending} onClick={() => save.mutate(value === "__off" ? null : value)}>
          切换
        </Button>
      </div>
    </div>
  );
}

function BudgetCard() {
  const projects = useProjects();
  const usage = useQuery({ queryKey: ck.usage, queryFn: () => unwrap(api.api.v1.admin.usage.get({ query: { days: 7 } })) });
  const [scope, setScope] = useState("tenant");
  const [limit, setLimit] = useState("");
  const save = useMutation({
    mutationFn: async () => {
      const me = await unwrap(api.api.v1.me.get());
      return unwrap(
        api.api.v1.admin.budgets.put({ scopeType: scope === "tenant" ? "tenant" : "project", scopeId: scope === "tenant" ? me.tenant.id : scope, limitTokens: limit ? Number(limit) : null }),
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ck.usage });
      toast.success("预算已更新");
    },
    onError: (e) => toast.error(e.message),
  });
  const pname = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id;
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Wallet className="size-4 text-attention" /> 预算
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        {(usage.data?.budgets ?? []).length === 0 ? (
          <p className="text-[13px] text-muted-foreground">未设置预算上限（不限）。超出预算时 Agent 会暂停并通知 Maintainer。</p>
        ) : (
          <ul className="space-y-2">
            {usage.data!.budgets.map((b) => {
              const pct = b.limitTokens ? Math.min(100, Math.round((b.usedTokens / b.limitTokens) * 100)) : 0;
              return (
                <li key={b.id} className="text-[13px]">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{b.scopeType === "tenant" ? "整个租户" : pname(b.scopeId)}</span>
                    {b.status === "exceeded" && <span className="rounded-full bg-danger-soft px-1.5 text-[11px] text-danger">已超限</span>}
                    <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                      {fmt(b.usedTokens)} / {b.limitTokens ? fmt(b.limitTokens) : "∞"} tokens
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-muted">
                    <div className={cn("h-full rounded-full", pct >= 100 ? "bg-danger" : pct > 80 ? "bg-attention" : "bg-primary")} style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex gap-2">
          <Select value={scope} onValueChange={setScope}>
            <SelectTrigger className="w-40" aria-label="预算范围">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tenant">整个租户</SelectItem>
              {(projects.data ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ""))} placeholder="token 上限，留空=不限" />
          <Button variant="secondary" onClick={() => save.mutate()} disabled={save.isPending}>
            保存
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function UsageCard() {
  const usage = useQuery({ queryKey: ck.usage, queryFn: () => unwrap(api.api.v1.admin.usage.get({ query: { days: 7 } })) });
  const rows = usage.data?.byModel ?? [];
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Gauge className="size-4 text-info" /> 近 7 天用量
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        {rows.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">还没有模型调用。</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模型</TableHead>
                <TableHead>用途</TableHead>
                <TableHead className="text-right">调用</TableHead>
                <TableHead className="text-right">失败</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">平均耗时</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={`${r.model}-${r.purpose}`}>
                  <TableCell className="font-mono text-xs">{r.model}</TableCell>
                  <TableCell className="text-xs">{r.purpose}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.calls}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", r.errors > 0 && "text-danger")}>{r.errors}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(r.tokensIn + r.tokensOut)}</TableCell>
                  <TableCell className="text-right tabular-nums">{(r.avgLatencyMs / 1000).toFixed(1)}s</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function ModelsPage() {
  const q = useModels();
  const [add, setAdd] = useState(false);
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="模型与预算"
        description="模型供应商、租户默认模型、知识库嵌入模型、Agent 暂停开关、预算与用量。"
        actions={
          <Button onClick={() => setAdd(true)}>
            <Plus className="size-4" /> 登记供应商
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          {q.isPending ? (
            <PageSkeleton rows={3} />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : (
            q.data.providers.map((p) => <ProviderCard key={p.id} p={p} defaultModel={q.data.defaultModel} embeddingModel={q.data.embeddingModel} />)
          )}
          <UsageCard />
        </div>
        <div className="space-y-4">
          <PauseCard />
          <EmbeddingCard />
          <BudgetCard />
        </div>
      </div>
      <AddProviderDialog open={add} onOpenChange={setAdd} />
    </div>
  );
}
