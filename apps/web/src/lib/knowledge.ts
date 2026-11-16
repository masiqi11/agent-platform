import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "./api";

export const kbKeys = {
  status: (projectId: string) => ["kb-status", projectId] as const,
  catalog: (projectId: string) => ["kb-catalog", projectId] as const,
  file: (projectId: string, repoId: string, path: string, commit: string) => ["kb-file", projectId, repoId, path, commit] as const,
};

export const useKbStatus = (projectId: string) =>
  useQuery({ queryKey: kbKeys.status(projectId), queryFn: () => unwrap(api.api.v1.projects({ id: projectId }).knowledge.status.get()), refetchInterval: 15_000 });
export const useCatalog = (projectId: string) => useQuery({ queryKey: kbKeys.catalog(projectId), queryFn: () => unwrap(api.api.v1.projects({ id: projectId }).catalog.get()) });
export const useKbFile = (c: { projectId: string; repoId: string; path: string; commit: string } | null) =>
  useQuery({
    enabled: Boolean(c),
    queryKey: c ? kbKeys.file(c.projectId, c.repoId, c.path, c.commit) : ["kb-file", "none"],
    queryFn: () => unwrap(api.api.v1.projects({ id: c!.projectId }).knowledge.file.get({ query: { repoId: c!.repoId, path: c!.path, commit: c!.commit } })),
  });

export const kbSearch = (projectId: string, q: string, routes: string[]) => unwrap(api.api.v1.projects({ id: projectId }).knowledge.search.get({ query: { q, routes: routes.join(",") } }));
export const kbAsk = (projectId: string, question: string) => unwrap(api.api.v1.projects({ id: projectId }).knowledge.ask.post({ question }));

export type SearchResult = Awaited<ReturnType<typeof kbSearch>>;
export type SearchHit = SearchResult["results"][number];
export type AskResult = Awaited<ReturnType<typeof kbAsk>>;

/** Route → label + what it does (FR-KB-04: every route is explainable). */
export const ROUTE_INFO: Record<string, { label: string; help: string }> = {
  bm25: { label: "关键词", help: "全文检索（中文二元分词），命中的词越多越靠前。" },
  sag2: { label: "SAG2", help: "先关键词检索，再由模型判断哪些是证据并补充检索词，最多两轮。失败时退回关键词。" },
  vector: { label: "向量", help: "按语义相似度召回。单靠向量命中不算证据，回答时不会引用。" },
};

export const SOURCE_LABEL: Record<string, string> = { code: "代码", doc: "文档", decision: "决策", summary: "群摘要" };
export const CONFIDENCE: Record<string, { label: string; cls: string }> = {
  high: { label: "置信度高", cls: "bg-ok-soft text-ok" },
  medium: { label: "置信度中", cls: "bg-info-soft text-info" },
  low: { label: "置信度低", cls: "bg-attention-soft text-attention" },
};
