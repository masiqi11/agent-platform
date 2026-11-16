import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Landmark, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { PageSkeleton } from "@/components/states";
import { qk } from "@/lib/query";
import { COLUMNS, useTasks } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { TimelineState } from "./timeline-store";

/** Right-panel section: coloured dot + small heading + count; empty state stays quiet but present. */
export function PanelSection({ dot, title, count, empty, children }: { dot: string; title: string; count?: number; empty?: string; children?: ReactNode }) {
  const isEmpty = count === 0 || (count === undefined && !children);
  return (
    <section className="py-3 first:pt-1">
      <h3 className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
        <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
        {title}
        {count !== undefined && <span className="tabular-nums">{count}</span>}
      </h3>
      {isEmpty ? <p className="pl-3.5 text-[13px] text-muted-foreground/70">{empty ?? "暂无"}</p> : <div className="pl-3.5 text-[13.5px] leading-relaxed">{children}</div>}
    </section>
  );
}

/** Decision cards already in the loaded timeline (the decisions API arrives with the captain, S4). */
function useGroupDecisions(groupId: string) {
  const tl = useQuery<TimelineState>({ queryKey: qk.timeline(groupId), enabled: false });
  return (tl.data?.items ?? [])
    .filter((m) => m.kind === "decision_card" && !m.deleted)
    .map((m) => ({
      id: m.id,
      seq: m.seq,
      title: typeof m.blocks?.title === "string" ? m.blocks.title : m.body.split("\n")[0]!,
      body: m.body.split("\n").slice(1).join(" ").trim(),
      status: typeof m.blocks?.status === "string" ? m.blocks.status : "proposed",
    }));
}

export function SummaryTab({ projectId, groupId }: { projectId: string; groupId: string }) {
  const decisions = useGroupDecisions(groupId);
  const tasks = useTasks(projectId, { groupId });
  const risks = (tasks.data ?? []).filter((t) => t.status === "blocked" || t.priority === "P0");
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        <Sparkles className="size-3.5 shrink-0 text-agent" />
        <span>本群摘要由项目船长维护（S4 接入）；下面先汇总群内已有的决策与风险。</span>
      </div>
      <div className="divide-y">
        <PanelSection dot="bg-ok" title="决策" count={decisions.length} empty="还没有确认的决策">
          <ul className="space-y-1.5">
            {decisions.map((d) => (
              <li key={d.id}>
                {d.title} <span className="font-mono text-[11px] text-muted-foreground">#{d.seq}</span>
              </li>
            ))}
          </ul>
        </PanelSection>
        <PanelSection dot="bg-attention" title="未决问题" count={0} empty="船长会从讨论里提炼待回答的问题" />
        <PanelSection dot="bg-info" title="约束" count={0} />
        <PanelSection dot="bg-danger" title="风险与线索" count={risks.length} empty="没有阻塞或 P0 任务">
          <ul className="space-y-1.5">
            {risks.map((t) => (
              <li key={t.id}>
                <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: t.id }} className="hover:underline">
                  {t.title}
                </Link>{" "}
                <span className="font-mono text-[11px] text-muted-foreground">{t.ref}</span>
              </li>
            ))}
          </ul>
        </PanelSection>
      </div>
    </div>
  );
}

export function DecisionsTab({ groupId }: { groupId: string }) {
  const decisions = useGroupDecisions(groupId);
  if (decisions.length === 0)
    return (
      <div className="flex flex-col items-center px-4 py-10 text-center">
        <span className="mb-3 grid size-10 place-items-center rounded-full bg-ok-soft text-ok">
          <Landmark className="size-5" />
        </span>
        <p className="text-sm font-medium">暂无决策</p>
        <p className="mt-1 text-xs text-muted-foreground">被确认的决策会沉淀在这里，并同步到知识库。</p>
      </div>
    );
  return (
    <ul className="space-y-2.5 pt-1" data-testid="decisions">
      {decisions.map((d) => (
        <li key={d.id} className="rounded-xl border bg-card p-3.5">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Landmark className="size-4 text-ok" /> {d.title}
          </p>
          {d.body && <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{d.body}</p>}
          <p className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className={cn("rounded-full px-1.5 py-px", d.status === "confirmed" ? "bg-ok-soft text-ok" : "bg-attention-soft")}>{d.status === "confirmed" ? "已确认" : "待确认"}</span>
            <span className="font-mono">来源 #{d.seq}</span>
          </p>
        </li>
      ))}
    </ul>
  );
}

export function TasksTab({ projectId, groupId }: { projectId: string; groupId: string }) {
  const q = useTasks(projectId, { groupId });
  if (q.isPending) return <PageSkeleton rows={3} />;
  const list = q.data ?? [];
  if (list.length === 0)
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm font-medium">暂无关联任务</p>
        <p className="mt-1 text-xs text-muted-foreground">从本群提议并确认、或由消息转成的任务会显示在这里。</p>
      </div>
    );
  return (
    <div className="divide-y" data-testid="group-tasks">
      {COLUMNS.filter((c) => list.some((t) => t.status === c.status)).map((c) => (
        <PanelSection key={c.status} dot={c.dot} title={c.label} count={list.filter((t) => t.status === c.status).length}>
          <ul className="space-y-1">
            {list
              .filter((t) => t.status === c.status)
              .map((t) => (
                <li key={t.id}>
                  <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: t.id }} className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted">
                    <span className="font-mono text-[11px] text-muted-foreground">{t.ref}</span>
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  </Link>
                </li>
              ))}
          </ul>
        </PanelSection>
      ))}
    </div>
  );
}
