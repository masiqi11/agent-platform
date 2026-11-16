import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download, Filter, ShieldAlert, ShieldCheck } from "lucide-react";
import { Fragment, useState } from "react";
import { EmptyState, ErrorState, PageHeader, PageSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, unwrap } from "@/lib/api";
import { absoluteTime, relativeTime, t } from "@/lib/i18n";
import { qk } from "@/lib/query";
import { session } from "@/lib/session";
import { cn } from "@/lib/utils";

type Filters = { actor?: string; action?: string; resourceType?: string; from?: string; to?: string };

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="max-h-64 overflow-auto rounded-md border bg-background p-2.5 font-mono text-xs leading-relaxed">{value == null ? "—" : JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

export function AuditPage() {
  const [draft, setDraft] = useState<Filters>({});
  const [filters, setFilters] = useState<Filters>({});
  const [open, setOpen] = useState<string | null>(null);
  const q = useInfiniteQuery({
    queryKey: qk.audit(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => unwrap(api.api.v1.audit.get({ query: { ...clean(filters), limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } })),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const verify = useMutation({ mutationFn: () => unwrap(api.api.v1.audit.verify.get()) });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];

  async function exportCsv() {
    const params = new URLSearchParams({ ...clean(filters), format: "csv" } as Record<string, string>);
    const res = await fetch(`/api/v1/audit/export?${params}`, { headers: { authorization: `Bearer ${session.get()}` } });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div>
      <PageHeader
        title={t("audit.title")}
        description="所有写操作、登录、授权拒绝都会留痕；记录只追加、带哈希链，数据库层禁止修改与删除。"
        actions={
          <>
            <Button variant="outline" onClick={() => verify.mutate()} disabled={verify.isPending} data-testid="audit-verify">
              <ShieldCheck className="size-4" /> {t("audit.verify")}
            </Button>
            <Button variant="outline" onClick={() => void exportCsv()}>
              <Download className="size-4" /> {t("audit.export")}
            </Button>
          </>
        }
      />
      {verify.data && (
        <div role="status" className={cn("mb-4 flex items-center gap-2 rounded-md border px-3 py-2 text-sm", verify.data.ok ? "border-ok/30 bg-ok-soft" : "border-danger/30 bg-danger-soft")}>
          {verify.data.ok ? <ShieldCheck className="size-4 text-ok" /> : <ShieldAlert className="size-4 text-danger" />}
          {verify.data.ok ? `哈希链完整：${verify.data.count} 条记录校验通过` : `哈希链在 #${verify.data.brokenAt} 处断裂，请立即排查`}
          {verify.data.head ? <span className="ml-auto font-mono text-xs text-muted-foreground">head {verify.data.head.slice(0, 16)}…</span> : null}
        </div>
      )}
      <form
        className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(draft);
        }}
      >
        <Filter className="mb-2 size-4 text-muted-foreground" aria-hidden />
        {(
          [
            ["action", "动作", "如 user.disable"],
            ["resourceType", "资源类型", "如 user"],
            ["actor", "操作者 ID", "prn_…"],
          ] as const
        ).map(([k, l, ph]) => (
          <label key={k} className="grid gap-1 text-xs text-muted-foreground">
            {l}
            <Input className="h-8 w-44" placeholder={ph} value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
          </label>
        ))}
        <label className="grid gap-1 text-xs text-muted-foreground">
          起
          <Input className="h-8 w-40" type="date" value={draft.from ?? ""} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          止
          <Input className="h-8 w-40" type="date" value={draft.to ?? ""} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </label>
        <Button size="sm" type="submit">
          筛选
        </Button>
        {Object.values(filters).some(Boolean) && (
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => {
              setDraft({});
              setFilters({});
            }}
          >
            清除
          </Button>
        )}
      </form>
      {q.isPending ? (
        <PageSkeleton rows={8} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Filter} title={t("audit.empty")} body="调整筛选条件，或稍后再来。" />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-8" />
                <TableHead>时间</TableHead>
                <TableHead>操作者</TableHead>
                <TableHead>动作</TableHead>
                <TableHead>资源</TableHead>
                <TableHead>结果</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <TableRow className="cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id} data-testid="audit-row">
                    <TableCell className="text-muted-foreground">{open === r.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm" title={absoluteTime(r.createdAt)}>
                      {relativeTime(r.createdAt)}
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{r.actorName}</span>
                      <span className="ml-1.5 text-xs text-muted-foreground">{r.actorKind === "agent" ? "Agent" : ""}</span>
                    </TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{r.action}</code>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r.resourceType} <span className="font-mono text-xs">{r.resourceId.slice(0, 14)}</span>
                    </TableCell>
                    <TableCell>
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", r.outcome === "allowed" ? "bg-ok-soft" : "bg-danger-soft")}>{r.outcome === "allowed" ? "允许" : "拒绝"}</span>
                    </TableCell>
                  </TableRow>
                  {open === r.id && (
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableCell />
                      <TableCell colSpan={5} className="py-3">
                        <div className="flex flex-col gap-3 md:flex-row">
                          <JsonBlock label="变更前" value={r.before} />
                          <JsonBlock label="变更后" value={r.after} />
                        </div>
                        <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                          #{r.seq} · trace {r.traceId ?? "—"} · hash {r.hash.slice(0, 20)}…
                        </p>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
          {q.hasNextPage && (
            <div className="border-t p-2 text-center">
              <Button variant="ghost" size="sm" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                加载更多
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function clean(f: Filters) {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as Filters;
}
