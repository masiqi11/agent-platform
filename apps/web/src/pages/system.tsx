import { Activity, Box, Database, HardDrive, Inbox, Layers, Plug, Timer } from "lucide-react";
import type { ReactNode } from "react";
import { StatusDot } from "@/components/badges";
import { ErrorState, PageHeader, PageSkeleton } from "@/components/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSystemStatus } from "@/lib/code";
import { cn } from "@/lib/utils";

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

function Tile({ icon: Icon, title, tone, value, detail }: { icon: typeof Activity; title: string; tone: "ok" | "attention" | "danger"; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className={cn("rounded-xl border bg-card p-4", tone === "danger" && "border-danger/40", tone === "attention" && "border-attention/50")} data-testid="system-tile">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="size-4" /> {title}
        <span className="ml-auto">
          <StatusDot tone={tone} label={tone === "ok" ? "正常" : tone === "attention" ? "注意" : "异常"} />
        </span>
      </div>
      <p className="mt-2 text-xl font-semibold tabular-nums">{value}</p>
      {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

/** System status (ADM-补3): DB, migration, event lag, jobs, dead letters, sandbox, model providers, disk. */
export function SystemPage() {
  const q = useSystemStatus();
  if (q.isPending) return <PageSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  const migOk = s.migration.current === s.migration.expected;
  return (
    <div className="space-y-5">
      <PageHeader title="系统状态" description={`每 20 秒刷新 · 最近检查 ${new Date(s.checkedAt).toLocaleTimeString("zh-CN")}`} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile icon={Database} title="数据库" tone={s.db.ok ? "ok" : "danger"} value={s.db.ok ? "可用" : "不可用"} detail={`${s.db.latencyMs} ms`} />
        <Tile
          icon={Layers}
          title="迁移版本"
          tone={migOk ? "ok" : "danger"}
          value={<span className="font-mono text-base">{s.migration.current}</span>}
          detail={migOk ? "与代码一致" : `期望 ${s.migration.expected}`}
        />
        <Tile icon={Activity} title="事件消费延迟" tone={s.events.lag > 500 ? "danger" : s.events.lag > 50 ? "attention" : "ok"} value={`${s.events.lag} 条`} detail={`最新 seq ${s.events.headSeq}`} />
        <Tile icon={Timer} title="作业积压" tone={s.jobs.queued > 200 ? "attention" : "ok"} value={`${s.jobs.queued} 排队`} detail={`${s.jobs.running} 运行中 · ${s.jobs.dead} 失败`} />
        <Tile icon={Inbox} title="死信" tone={s.deadLetters > 0 ? "attention" : "ok"} value={s.deadLetters} detail="未重放的失败事件 / 作业" />
        <Tile icon={Box} title="沙箱" tone={s.sandbox.ok ? (s.sandbox.kind === "process" ? "attention" : "ok") : "danger"} value={s.sandbox.kind} detail={s.sandbox.detail} />
        <Tile
          icon={HardDrive}
          title="工作区磁盘"
          tone={!s.disk ? "attention" : s.disk.usedRatio > 0.9 ? "danger" : s.disk.usedRatio > 0.8 ? "attention" : "ok"}
          value={s.disk ? `${Math.round(s.disk.usedRatio * 100)}%` : "未知"}
          detail={s.disk ? `剩余 ${gb(s.disk.freeBytes)} / ${gb(s.disk.totalBytes)}` : undefined}
        />
        <Tile
          icon={Plug}
          title="模型供应商"
          tone={s.providers.some((p) => p.circuit === "open") ? "danger" : "ok"}
          value={`${s.providers.length} 个`}
          detail={s.providers.map((p) => `${p.name}${p.circuit === "open" ? "（熔断）" : ""}`).join("、") || "未配置"}
        />
      </div>
      <section>
        <h2 className="mb-2 text-sm font-semibold">事件消费者</h2>
        <div className="rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead className="text-right">偏移</TableHead>
                <TableHead className="text-right">延迟</TableHead>
                <TableHead>最近错误</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.events.consumers.map((c) => (
                <TableRow key={c.name}>
                  <TableCell className="font-mono">{c.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.offset}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", c.lag > 50 && "text-attention")}>{c.lag}</TableCell>
                  <TableCell className="max-w-80 truncate text-xs text-muted-foreground">{c.lastError ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
