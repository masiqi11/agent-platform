import { Bot, Braces, MessageSquareText, Wrench } from "lucide-react";
import { useState } from "react";
import { PrincipalAvatar } from "@/components/agent-avatar";
import { EmptyState, ErrorState, PageHeader, PageSkeleton } from "@/components/states";
import { useSessionDetail, useSessions } from "@/lib/captain";
import { relativeTime } from "@/lib/i18n";
import { AGENT_ROLE_LABEL } from "@/lib/projects";
import { cn } from "@/lib/utils";

const STATUS: Record<string, { label: string; cls: string }> = {
  idle: { label: "空闲", cls: "bg-idle-soft text-muted-foreground" },
  running: { label: "运行中", cls: "bg-info-soft text-info" },
  completed: { label: "已完成", cls: "bg-ok-soft text-ok" },
  suspended: { label: "已暂停", cls: "bg-danger-soft text-danger" },
  interrupted: { label: "已中断", cls: "bg-attention-soft" },
  failed: { label: "失败", cls: "bg-danger-soft text-danger" },
  queued: { label: "排队中", cls: "bg-muted" },
};
const LAYERS: Array<[string, string, string]> = [
  ["system", "系统提示", "bg-idle"],
  ["L0", "L0 触发", "bg-primary"],
  ["L1", "L1 任务", "bg-info"],
  ["L2", "L2 摘要", "bg-ok"],
  ["L3", "L3 近期消息", "bg-agent"],
  ["L4", "L4 检索", "bg-attention"],
  ["L5", "L5 记忆", "bg-danger"],
];

interface Pkg {
  layerTokens?: Record<string, number>;
  recentMessages?: Array<{ id: string; seq: number; author: string; body: string }>;
  policy?: { toolAllowlist?: string[]; permissions?: string[] };
  captainBrief?: Record<string, string[]>;
  trigger?: { kind?: string };
}

/** Context-package inspector (SES-补5): what the model actually saw, per layer. */
function ContextInspector({ pkg }: { pkg: Pkg }) {
  const lt = pkg.layerTokens ?? {};
  const total = Object.values(lt).reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3" data-testid="context-inspector">
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">各层 token（估算，共 {total}）</p>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
          {LAYERS.map(([k, , c]) => (lt[k] ? <div key={k} className={c} style={{ width: `${(lt[k]! / total) * 100}%` }} title={`${k} ${lt[k]}`} /> : null))}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {LAYERS.map(([k, l, c]) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span className={cn("size-1.5 rounded-full", c)} /> {l} {lt[k] ?? 0}
            </span>
          ))}
        </div>
      </div>
      {pkg.policy?.toolAllowlist && (
        <p className="text-[12px]">
          <span className="text-muted-foreground">可用工具：</span>
          <span className="font-mono">{pkg.policy.toolAllowlist.join(", ")}</span>
        </p>
      )}
      {pkg.recentMessages && pkg.recentMessages.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">L3 近期消息（{pkg.recentMessages.length} 条，均以 untrusted 标记传给模型）</p>
          <ul className="max-h-40 space-y-0.5 overflow-y-auto text-[12px]">
            {pkg.recentMessages.map((m) => (
              <li key={m.id} className="truncate">
                <span className="font-mono text-muted-foreground">#{m.seq}</span> <span className="font-medium">{m.author}</span>：{m.body}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SessionDetail({ id }: { id: string }) {
  const q = useSessionDetail(id);
  if (q.isPending) return <PageSkeleton rows={4} />;
  if (q.error) return <ErrorState error={q.error} />;
  const s = q.data;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{s.agentName}</h2>
        <span className={cn("rounded-full px-2 py-px text-[11px]", STATUS[s.status]?.cls)}>{STATUS[s.status]?.label ?? s.status}</span>
        <span className="text-xs text-muted-foreground">
          {s.scopeType} · 模型 {s.model ?? "—"} · {s.steps} 步 · {s.tokensUsed} tokens · 配置 v{s.agentConfigVersion}
        </span>
        {s.stopReason && <span className="text-xs text-muted-foreground">· 停止原因 {s.stopReason}</span>}
      </div>
      <ol className="space-y-2">
        {s.turns.map((t) => (
          <li key={t.idx} className="rounded-lg border bg-card p-3">
            <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              {t.role === "context" ? (
                <Braces className="size-3.5" />
              ) : t.role === "tool" ? (
                <Wrench className="size-3.5" />
              ) : t.role === "assistant" ? (
                <Bot className="size-3.5 text-agent" />
              ) : (
                <MessageSquareText className="size-3.5" />
              )}
              {({ context: "上下文包", assistant: "模型输出", tool: "工具调用", effects: "本轮效果", error: "错误" } as Record<string, string>)[t.role] ?? t.role}
              {(t.tokensIn > 0 || t.tokensOut > 0) && (
                <span className="ml-auto font-mono">
                  in {t.tokensIn} / out {t.tokensOut}
                </span>
              )}
            </p>
            {t.role === "context" && t.contextPackage ? <ContextInspector pkg={t.contextPackage as Pkg} /> : null}
            {t.content && t.role !== "context" && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-[12.5px] leading-relaxed">{t.content}</pre>}
            {t.role === "assistant" && Array.isArray(t.toolCalls) && t.toolCalls.length > 1 && (
              <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px]">{JSON.stringify(t.toolCalls, null, 1)}</pre>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

const SCOPE_LABEL: Record<string, string> = { resident: "常驻", task: "任务", thread: "线程", one_shot: "一次性（摘要）" };

export function SessionsPage({ projectId }: { projectId: string }) {
  const q = useSessions(projectId);
  const [sel, setSel] = useState<string | null>(null);
  const current = sel ?? q.data?.[0]?.id ?? null;
  return (
    <div>
      <PageHeader title="Agent 会话" description="每次唤醒的上下文、模型输出与工具调用（Maintainer 可见）。" />
      {q.isPending ? (
        <PageSkeleton rows={4} />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : q.data.length === 0 ? (
        <EmptyState icon={Bot} title="还没有会话" body="在群里 @船长 后，这里会出现它的会话记录。" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <ul className="space-y-1.5">
            {q.data.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setSel(s.id)}
                  className={cn("flex w-full items-center gap-2.5 rounded-lg border bg-card p-2.5 text-left transition-colors hover:border-ring/40", current === s.id && "border-ring/60 bg-accent/40")}
                  data-testid="session-row"
                >
                  <PrincipalAvatar name={s.agentName} kind="agent" size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {s.agentName} <span className="text-[11px] font-normal text-muted-foreground">{AGENT_ROLE_LABEL[s.role] ?? s.role}</span>
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {SCOPE_LABEL[s.scopeType] ?? s.scopeType} · {s.steps} 步 · {relativeTime(s.updatedAt)}
                    </p>
                  </div>
                  <span className={cn("rounded-full px-1.5 py-px text-[10px]", STATUS[s.status]?.cls)}>{STATUS[s.status]?.label ?? s.status}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0">{current && <SessionDetail id={current} />}</div>
        </div>
      )}
    </div>
  );
}
