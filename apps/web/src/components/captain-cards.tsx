import { CheckCircle2, Clock, HelpCircle, Landmark, ScrollText, Undo2, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { answerQuestion, decide } from "@/lib/captain";
import { absoluteTime, relativeTime } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const errText = (e: unknown) => (e instanceof Error ? e.message : "操作失败");

/** Captain follow-up question (CAP-补4): options, default, deadline; answering wakes the captain. */
export function QuestionCard({ blocks, body, canAnswer }: { blocks: Record<string, unknown>; body: string; canAnswer: boolean }) {
  const id = typeof blocks.questionId === "string" ? blocks.questionId : "";
  const options = Array.isArray(blocks.options) ? (blocks.options as string[]) : [];
  const def = typeof blocks.defaultOption === "string" ? blocks.defaultOption : null;
  const status = typeof blocks.status === "string" ? blocks.status : "open";
  const deadline = typeof blocks.deadlineAt === "string" ? blocks.deadlineAt : null;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (b: { option?: string; text?: string }) => {
    setBusy(true);
    try {
      await answerQuestion(id, b);
      setText("");
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const STATUS: Record<string, { label: string; cls: string }> = {
    answered: { label: "已回答", cls: "bg-ok-soft text-ok" },
    defaulted: { label: "按默认继续", cls: "bg-idle-soft text-muted-foreground" },
    escalated: { label: "已升级给 Maintainer", cls: "bg-danger-soft text-danger" },
  };
  return (
    <div data-testid="question-card" data-status={status}>
      <p className="flex items-start gap-2 text-[14.5px] font-medium leading-relaxed">
        <HelpCircle className="mt-1 size-4 shrink-0 text-attention" aria-hidden />
        <span>{body}</span>
      </p>
      {status === "open" ? (
        <>
          {options.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-2 pl-6">
              {options.map((o) => (
                <Button key={o} size="sm" variant={o === def ? "default" : "outline"} disabled={!canAnswer || busy} onClick={() => void send({ option: o })}>
                  {o}
                  {o === def && <span className="ml-1 text-[10px] opacity-75">默认</span>}
                </Button>
              ))}
            </div>
          )}
          {canAnswer && (
            <form
              className="mt-2 flex gap-2 pl-6"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) void send({ text });
              }}
            >
              <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="或者直接补充细节…" className="h-8 bg-card text-sm" aria-label="回答" />
              <Button type="submit" size="sm" variant="secondary" disabled={busy || !text.trim()}>
                回答
              </Button>
            </form>
          )}
          {deadline && (
            <p className="mt-2 flex items-center gap-1 pl-6 text-[11.5px] text-muted-foreground" title={absoluteTime(deadline)}>
              <Clock className="size-3" /> {relativeTime(deadline)}到期{def ? `，未回复将按「${def}」继续` : "，未回复将升级给 Maintainer"}
            </p>
          )}
        </>
      ) : (
        <p className="mt-2 flex flex-wrap items-center gap-2 pl-6 text-[13px] text-muted-foreground">
          <span className={cn("rounded-full px-2 py-px text-[11px] font-medium", STATUS[status]?.cls)}>{STATUS[status]?.label ?? status}</span>
          {typeof blocks.answer === "string" && <span className="line-clamp-1">{blocks.answer}</span>}
        </p>
      )}
    </div>
  );
}

/** Decision extracted by the captain: humans confirm or reject it inline; confirmed ones can be revoked. */
export function DecisionCard({ blocks, body, canDecide }: { blocks: Record<string, unknown>; body: string; canDecide: boolean }) {
  const id = typeof blocks.decisionId === "string" ? blocks.decisionId : null;
  const status = typeof blocks.status === "string" ? blocks.status : "proposed";
  const title = typeof blocks.title === "string" ? blocks.title : null;
  const [reasonFor, setReasonFor] = useState<"reject" | "revoke" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (action: "confirm" | "reject" | "revoke") => {
    if (!id) return;
    setBusy(true);
    try {
      await decide(id, action, reason || undefined);
      setReasonFor(null);
      setReason("");
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const tone = status === "confirmed" ? "bg-ok-soft text-ok" : status === "proposed" ? "bg-attention-soft text-foreground" : "bg-idle-soft text-muted-foreground";
  const label = ({ proposed: "待确认", confirmed: "已确认", rejected: "已驳回", revoked: "已撤销" } as Record<string, string>)[status] ?? status;
  return (
    <div data-testid="decision-card" data-status={status}>
      <p className="flex items-start gap-2 text-[14.5px] leading-relaxed">
        <Landmark className="mt-1 size-4 shrink-0 text-ok" aria-hidden />
        <span className={cn("font-medium", (status === "rejected" || status === "revoked") && "text-muted-foreground line-through")}>{title ?? body}</span>
      </p>
      {title && body.split("\n").slice(1).join("\n").trim() && <p className="mt-1 pl-6 text-[13px] text-muted-foreground">{body.split("\n").slice(1).join("\n").trim()}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
        <span className={cn("rounded-full px-2 py-px text-[11px] font-medium", tone)}>{label}</span>
        {Array.isArray(blocks.seqs) && blocks.seqs.length > 0 && <span className="font-mono text-[11px] text-muted-foreground">来源 {(blocks.seqs as number[]).map((s) => `#${s}`).join(" ")}</span>}
        {typeof blocks.decidedBy === "string" && <span className="text-[11px] text-muted-foreground">· {blocks.decidedBy}</span>}
        {id && canDecide && status === "proposed" && !reasonFor && (
          <>
            <Button size="sm" className="h-7" disabled={busy} onClick={() => void act("confirm")}>
              <CheckCircle2 className="size-3.5" /> 确认
            </Button>
            <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => setReasonFor("reject")}>
              <XCircle className="size-3.5" /> 驳回
            </Button>
          </>
        )}
        {id && canDecide && status === "confirmed" && !reasonFor && (
          <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => setReasonFor("revoke")}>
            <Undo2 className="size-3.5" /> 撤销
          </Button>
        )}
      </div>
      {reasonFor && (
        <form
          className="mt-2 flex gap-2 pl-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) void act(reasonFor);
          }}
        >
          <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonFor === "reject" ? "驳回原因（必填）" : "撤销原因（必填）"} className="h-8 bg-card text-sm" />
          <Button type="submit" size="sm" variant="secondary" disabled={busy || !reason.trim()}>
            提交
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setReasonFor(null)}>
            取消
          </Button>
        </form>
      )}
    </div>
  );
}

export function SummaryCardInline({ blocks, body, onOpen }: { blocks: Record<string, unknown>; body: string; onOpen?: () => void }) {
  const counts = (blocks.counts ?? {}) as Record<string, number>;
  const LABEL: Record<string, string> = { decisions: "决策", constraints: "约束", openQuestions: "未决问题", taskGraph: "任务脉络", risks: "风险" };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="summary-card">
      <ScrollText className="size-4 text-primary" aria-hidden />
      <span className="font-medium">{body}</span>
      {Object.entries(counts).map(([k, n]) => (
        <span key={k} className="rounded-full bg-muted px-2 py-px text-[11px] text-muted-foreground">
          {LABEL[k] ?? k} {n}
        </span>
      ))}
      {onOpen && (
        <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={onOpen}>
          在右栏查看
        </button>
      )}
    </div>
  );
}

/** Live bubble for a streaming captain reply (LLM-12). */
export function StreamingBubble({ name, text }: { name: string; text: string }) {
  return (
    <div className="flex gap-3.5 px-6 pt-4 pb-1" data-testid="streaming-bubble">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-agent-soft text-xs font-semibold text-agent">{name.slice(0, 1)}</span>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2">
          <span className="text-[14px] font-semibold text-agent">{name}</span>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-agent" /> 正在回复…
          </span>
        </p>
        <p className="mt-0.5 whitespace-pre-wrap text-[14.5px] leading-relaxed text-foreground/90">{text || "思考中…"}</p>
      </div>
    </div>
  );
}
