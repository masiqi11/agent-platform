import { useMutation } from "@tanstack/react-query";
import { BookOpen, Bot, Database, Loader, RefreshCw, Search, Send, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { StatusDot } from "@/components/badges";
import { CitationChip } from "@/components/citation";
import { ErrorState, PageHeader, PageSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api";
import { CONFIDENCE, ROUTE_INFO, SOURCE_LABEL, kbAsk, kbKeys, kbSearch, useCatalog, useKbStatus, type SearchHit } from "@/lib/knowledge";
import { useProject } from "@/lib/projects";
import { queryClient } from "@/lib/query";
import { cn } from "@/lib/utils";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

/** 知识库 (§12.9): ask the project captain with citations, explainable hybrid search, index status, catalog. */
export function KnowledgePage({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const status = useKbStatus(projectId);
  const canManage = project.data?.canManage ?? false;
  const reindex = useMutation({
    mutationFn: (full: boolean) => unwrap(api.api.v1.projects({ id: projectId }).knowledge.reindex.post({ full })),
    onSuccess: (r) => {
      toast.success(`已排队 ${r.queued} 个索引任务`);
      void queryClient.invalidateQueries({ queryKey: kbKeys.status(projectId) });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "重建失败"),
  });
  if (project.isPending) return <PageSkeleton />;
  return (
    <div className="space-y-5">
      <PageHeader
        title="知识库"
        description="项目船长基于默认分支的代码与文档、已确认的决策和群摘要回答问题，每个结论都附可点击的出处；没有依据就说“未检索到依据”。你只能检索有权限的项目。"
        actions={
          canManage && (
            <Button variant="outline" onClick={() => reindex.mutate(true)} disabled={reindex.isPending} data-testid="kb-reindex">
              <RefreshCw className={cn("size-4", reindex.isPending && "animate-spin")} /> 全量重建
            </Button>
          )
        }
      />
      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-5">
          <AskCaptain projectId={projectId} />
          <SearchPanel projectId={projectId} />
        </div>
        <div className="space-y-5">
          <Card className="gap-3 py-4" data-testid="kb-status">
            <CardHeader className="px-4">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Database className="size-4" /> 索引状态
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 px-4 text-[13px]">
              {status.isPending ? (
                <PageSkeleton rows={3} />
              ) : status.error ? (
                <ErrorState error={status.error} onRetry={() => void status.refetch()} />
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    共 {status.data.chunks} 个片段 · 嵌入模型 {status.data.embeddingModel ?? "未配置（向量路关闭）"}
                  </p>
                  <ul className="space-y-2">
                    {status.data.indexes.map((ix) => (
                      <li key={ix.repoId ?? "warm"} className="rounded-lg border p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{ix.repoId ? ix.name : "决策与群摘要"}</span>
                          <StatusDot
                            tone={ix.status === "ready" ? (ix.stale ? "attention" : "ok") : ix.status === "failed" ? "danger" : "info"}
                            label={ix.status === "ready" ? (ix.stale ? "落后于默认分支" : "最新") : ix.status === "none" ? "未建索引" : ix.status}
                          />
                        </div>
                        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                          v{ix.version} · {ix.commit ? ix.commit.slice(0, 7) : "—"} · {fmt(ix.updatedAt)}
                        </p>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>
          <CatalogCard projectId={projectId} />
        </div>
      </div>
    </div>
  );
}

function AskCaptain({ projectId }: { projectId: string }) {
  const [q, setQ] = useState("");
  const m = useMutation({ mutationFn: (question: string) => kbAsk(projectId, question) });
  return (
    <Card className="gap-3 py-4" data-testid="kb-ask">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Bot className="size-4 text-agent" /> 问项目船长
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
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="例如：支付回调如何验签？" aria-label="问项目船长" />
          <Button type="submit" size="icon" aria-label="提问" disabled={m.isPending || !q.trim()}>
            {m.isPending ? <Loader className="size-4 animate-spin" /> : <Send className="size-4" />}
          </Button>
        </form>
        {m.error ? <ErrorState error={m.error} /> : null}
        {m.data && (
          <div className="space-y-2 rounded-lg bg-muted/50 p-3 text-[13.5px] leading-relaxed" data-testid="kb-answer">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("rounded-full px-2 py-0.5 text-[11px]", CONFIDENCE[m.data.confidence]?.cls)}>{CONFIDENCE[m.data.confidence]?.label ?? m.data.confidence}</span>
              {m.data.stale && <span className="rounded-full bg-attention-soft px-2 py-0.5 text-[11px] text-attention">索引落后于默认分支</span>}
            </div>
            <p className="whitespace-pre-wrap">{m.data.answer}</p>
            {m.data.citations.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {m.data.citations.map((c) => {
                  const h = m.data.hits.find((x) => x.path === c.path && x.commit === c.commit);
                  return (
                    <CitationChip
                      key={`${c.repoId}:${c.path}:${c.lines?.join("-")}`}
                      c={{ projectId: c.projectId, repoId: c.repoId, repoName: h?.repoName ?? null, path: c.path, commit: c.commit, startLine: c.lines?.[0] ?? 1, endLine: c.lines?.[1] ?? 1 }}
                    />
                  );
                })}
              </div>
            )}
            {m.data.followUp && <p className="text-xs text-muted-foreground">建议：{m.data.followUp}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SearchPanel({ projectId }: { projectId: string }) {
  const [q, setQ] = useState("");
  const [routes, setRoutes] = useState<string[]>(["bm25", "sag2", "vector"]);
  const m = useMutation({ mutationFn: (query: string) => kbSearch(projectId, query, routes) });
  return (
    <Card className="gap-3 py-4" data-testid="kb-search">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Search className="size-4" /> 检索
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
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="关键词、函数名或问题" aria-label="检索知识库" />
          <Button type="submit" variant="secondary" disabled={m.isPending || !q.trim() || routes.length === 0}>
            {m.isPending ? <Loader className="size-4 animate-spin" /> : <Search className="size-4" />} 检索
          </Button>
        </form>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-[13px]">
          {Object.entries(ROUTE_INFO).map(([k, info]) => (
            <label key={k} className="flex cursor-pointer items-center gap-1.5" title={info.help}>
              <Checkbox checked={routes.includes(k)} onCheckedChange={(v) => setRoutes((r) => (v ? [...r, k] : r.filter((x) => x !== k)))} aria-label={`${info.label}路`} />
              {info.label}
              {m.data && <span className="text-xs text-muted-foreground">({m.data.routes[k as "bm25"].enabled ? `${m.data.routes[k as "bm25"].candidates} 候选` : "关闭"})</span>}
            </label>
          ))}
        </div>
        {m.data && Object.values(m.data.routes).some((r) => r.note) && (
          <p className="text-xs text-muted-foreground">
            {Object.entries(m.data.routes)
              .flatMap(([k, r]) => (r.note ? [`${ROUTE_INFO[k]?.label ?? k}：${r.note}`] : []))
              .join("；")}
          </p>
        )}
        {m.error ? <ErrorState error={m.error} /> : null}
        {m.data &&
          (m.data.results.length === 0 ? (
            <p className="text-sm text-muted-foreground">未检索到相关内容。</p>
          ) : (
            <ol className="space-y-2" data-testid="kb-results">
              {m.data.results.map((h) => (
                <ResultRow key={h.id} h={h} />
              ))}
            </ol>
          ))}
      </CardContent>
    </Card>
  );
}

function ResultRow({ h }: { h: SearchHit }) {
  return (
    <li className="rounded-lg border p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{SOURCE_LABEL[h.sourceKind] ?? h.sourceKind}</span>
        <CitationChip c={{ ...h }} />
        {h.symbol && <span className="font-mono text-[11px] text-muted-foreground">{h.symbol}</span>}
        {h.stale && <span className="rounded-full bg-attention-soft px-1.5 py-0.5 text-[10.5px] text-attention">可能过期</span>}
        <span className="ml-auto flex gap-1">
          {h.routes.map((r) => (
            <span key={r.route} className="rounded-full border px-1.5 py-0.5 text-[10.5px] text-muted-foreground" title={`${ROUTE_INFO[r.route]?.help ?? ""} 得分 ${r.score}`}>
              {ROUTE_INFO[r.route]?.label ?? r.route} #{r.rank}
            </span>
          ))}
        </span>
      </div>
      <pre className="mt-1.5 line-clamp-4 whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-muted-foreground">{h.text}</pre>
    </li>
  );
}

function CatalogCard({ projectId }: { projectId: string }) {
  const c = useCatalog(projectId);
  return (
    <Card className="gap-3 py-4" data-testid="kb-catalog">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <BookOpen className="size-4" /> 项目目录
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 px-4 text-[13px]">
        {c.isPending ? (
          <PageSkeleton rows={3} />
        ) : c.error ? (
          <ErrorState error={c.error} />
        ) : (
          <>
            <p>{c.data.project.description || c.data.project.name}</p>
            <p className="text-xs text-muted-foreground">仓库：{c.data.repos.map((r) => r.name).join("、") || "无"}</p>
            {c.data.modules.length > 0 && <p className="text-xs text-muted-foreground">模块：{c.data.modules.map((m) => m.name).join("、")}</p>}
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Users className="size-3" /> 维护者：{c.data.maintainers.join("、") || "—"}
            </p>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Bot className="size-3" /> Agent：{c.data.agents.join("、") || "—"}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
