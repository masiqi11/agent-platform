import { useMutation, useQuery } from "@tanstack/react-query";
import { RotateCcw, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, unwrap } from "@/lib/api";
import { queryClient } from "@/lib/query";

const dlKey = ["admin-dead-letters"] as const;
type DeadLetter = Awaited<ReturnType<typeof fetchDl>>[number];
const fetchDl = () => unwrap(api.api.v1.admin["dead-letters"].get({ query: { state: "open" } }));
const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: dlKey });
  void queryClient.invalidateQueries({ queryKey: ["admin-system"] });
};

/** ADM-补4: failed events / jobs that ran out of retries — replay after fixing the cause, or discard with a reason. */
export function DeadLetterPanel() {
  const q = useQuery({ queryKey: dlKey, queryFn: fetchDl, refetchInterval: 20_000 });
  const [discarding, setDiscarding] = useState<DeadLetter | null>(null);
  const replay = useMutation({
    mutationFn: (id: string) => unwrap(api.api.v1.admin["dead-letters"]({ id }).replay.post()),
    onSuccess: () => {
      toast.success("已重放");
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "重放失败"),
  });
  const rows = q.data ?? [];
  return (
    <section aria-labelledby="dl-title">
      <h2 id="dl-title" className="mb-2 text-sm font-semibold">
        死信 {rows.length > 0 && <span className="font-normal text-muted-foreground">· {rows.length} 条待处理</span>}
      </h2>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>来源</TableHead>
              <TableHead>内容</TableHead>
              <TableHead>错误</TableHead>
              <TableHead className="text-right">尝试</TableHead>
              <TableHead>时间</TableHead>
              <TableHead className="w-44" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                  {q.isPending ? "加载中…" : "没有待处理的死信"}
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.id} data-testid="dead-letter-row">
                <TableCell className="whitespace-nowrap text-xs">{r.source === "job" ? "作业" : r.source === "event" ? `事件 → ${r.consumer}` : r.source}</TableCell>
                <TableCell className="font-mono text-xs">{r.summary}</TableCell>
                <TableCell className="max-w-96 truncate text-xs text-muted-foreground" title={r.error}>
                  {r.error}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.attempts}</TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString("zh-CN")}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="outline" disabled={replay.isPending} onClick={() => replay.mutate(r.id)}>
                      <RotateCcw className="size-3.5" /> 重放
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDiscarding(r)} aria-label={`丢弃 ${r.summary}`}>
                      <Trash2 className="size-3.5" /> 丢弃
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <DiscardDialog key={discarding?.id ?? "none"} row={discarding} onClose={() => setDiscarding(null)} />
    </section>
  );
}

function DiscardDialog({ row, onClose }: { row: DeadLetter | null; onClose(): void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={row !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>丢弃这条死信？</DialogTitle>
          <DialogDescription>它不会再被处理；记录保留，丢弃人和原因写入审计日志。</DialogDescription>
        </DialogHeader>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="原因（必填），例如：已手工补数据" aria-label="丢弃原因" />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={reason.trim().length < 2 || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await unwrap(api.api.v1.admin["dead-letters"]({ id: row!.id }).discard.post({ reason: reason.trim() }));
                toast.success("已丢弃");
                refresh();
                onClose();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "操作失败");
              } finally {
                setBusy(false);
              }
            }}
          >
            丢弃
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const KIND: Record<string, string> = { event: "事件", job: "作业", llm: "模型", audit: "审计" };

/** FR-OBS-02: everything behind a trace id (from an error message / x-request-id) or behind a task. */
export function TracePanel() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState<{ traceId?: string; taskId?: string } | null>(null);
  const q = useQuery({
    queryKey: ["admin-trace", query],
    queryFn: () => unwrap(api.api.v1.admin.traces.get({ query: query! })),
    enabled: query !== null,
  });
  const submit = () => {
    const v = input.trim();
    if (!v) return;
    setQuery(v.startsWith("tsk_") ? { taskId: v } : { traceId: v });
  };
  return (
    <section aria-labelledby="trace-title">
      <h2 id="trace-title" className="mb-2 text-sm font-semibold">
        链路追踪
      </h2>
      <form
        className="mb-2 flex max-w-xl gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="追踪标识（trc_…，见错误提示）或任务 ID（tsk_…）" aria-label="追踪标识或任务 ID" className="font-mono" />
        <Button type="submit" variant="outline">
          <Search className="size-4" /> 查询
        </Button>
      </form>
      {query && (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>追踪标识</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(q.data?.items ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                    {q.isPending ? "查询中…" : "没有找到记录"}
                  </TableCell>
                </TableRow>
              )}
              {(q.data?.items ?? []).map((i, n) => (
                <TableRow key={`${i.kind}-${i.ref}-${n}`} data-testid="trace-row">
                  <TableCell className="whitespace-nowrap text-xs tabular-nums">{new Date(i.at).toLocaleTimeString("zh-CN")}</TableCell>
                  <TableCell className="text-xs">{KIND[i.kind] ?? i.kind}</TableCell>
                  <TableCell className="font-mono text-xs">{i.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{i.status ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{i.traceId}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
