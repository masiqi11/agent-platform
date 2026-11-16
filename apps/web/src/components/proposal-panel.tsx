import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, Pencil, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { STATUS_LABEL } from "@/lib/tasks";
import { cn } from "@/lib/utils";

const P_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "待确认", cls: "bg-attention-soft text-foreground" },
  accepted: { label: "已确认", cls: "bg-ok-soft text-ok" },
  rejected: { label: "已拒绝", cls: "bg-danger-soft text-danger" },
  expired: { label: "已过期", cls: "bg-muted text-muted-foreground" },
  superseded: { label: "已被取代", cls: "bg-muted text-muted-foreground" },
};
const KIND_LABEL: Record<string, string> = { create_task: "任务提议", transition: "状态变更提议", assign: "分配提议" };

export const proposalQuery = (id: string) => ({ queryKey: ["proposal", id] as const, queryFn: () => unwrap(api.api.v1.proposals({ id }).get()) });
type Proposal = Awaited<ReturnType<ReturnType<typeof proposalQuery>["queryFn"]>>;
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const s = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * A proposal rendered with its inline actions (§13.3 提议卡): accept / edit / reject. Used in the
 * chat card and in the inbox detail. Only humans see actions; the server enforces INV-07 anyway.
 */
export function ProposalPanel({ proposalId, canDecide, compact = false }: { proposalId: string; canDecide: boolean; compact?: boolean }) {
  const q = useQuery(proposalQuery(proposalId));
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  if (q.isPending) return <div className="h-16 animate-pulse rounded-md bg-muted/60" />;
  if (q.error) return <p className="text-sm text-danger">提议加载失败：{q.error.message}</p>;
  const p = q.data;
  const st = P_STATUS[p.status] ?? { label: p.status, cls: "bg-muted" };
  const pl = p.payload;
  const dups = (Array.isArray(pl.duplicates) ? pl.duplicates : []) as Array<{ taskId: string; number: number; title: string; score: number }>;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["proposal", proposalId] });
    void queryClient.invalidateQueries({ queryKey: ["tasks", p.projectId] });
    void queryClient.invalidateQueries({ queryKey: ["inbox"] });
  };
  async function accept() {
    setBusy(true);
    try {
      const r = await unwrap(api.api.v1.proposals({ id: proposalId }).accept.post());
      toast.success(r.resultTaskIds.length ? "已确认并创建任务" : "已确认");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "确认失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={cn("space-y-2", compact && "text-sm")} data-testid="proposal-panel" data-status={p.status}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{KIND_LABEL[p.kind] ?? "提议"}</span>
        <span className={cn("rounded-full px-1.5 py-px text-[11px] font-medium", st.cls)}>{st.label}</span>
        {p.status === "pending" && (
          <span className="ml-auto text-[11px] text-muted-foreground">
            {new Date(p.expiresAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 过期
          </span>
        )}
      </div>
      {p.kind === "create_task" ? (
        <>
          <p className="font-medium">{s(pl.title)}</p>
          {s(pl.description) && <p className="text-sm whitespace-pre-wrap text-muted-foreground">{s(pl.description)}</p>}
          {strs(pl.acceptanceCriteria).length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-sm">
              {strs(pl.acceptanceCriteria).map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
        </>
      ) : p.kind === "transition" ? (
        <p className="text-sm">
          {s(pl.taskRef)} → {STATUS_LABEL[s(pl.to)] ?? s(pl.to)}
          {s(pl.reason) && <span className="text-muted-foreground"> · {s(pl.reason)}</span>}
        </p>
      ) : (
        <p className="text-sm">
          {s(pl.taskRef)} → {s(pl.agentName) || s(pl.assigneeAgentId)}
        </p>
      )}
      {dups.length > 0 && p.status === "pending" && (
        <p className="flex items-start gap-1.5 rounded-md bg-attention-soft px-2 py-1 text-xs">
          <AlertTriangle className="mt-px size-3.5 shrink-0 text-attention" /> 可能重复：{dups.map((d) => `#${d.number} ${d.title}`).join("；")}
        </p>
      )}
      {p.status === "rejected" && p.reason && <p className="text-xs text-muted-foreground">拒绝原因：{p.reason}</p>}
      {p.status === "accepted" && p.resultTaskIds.length > 0 && (
        <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId: p.projectId, taskId: p.resultTaskIds[0]! }} className="inline-block text-sm text-primary hover:underline">
          查看任务 →
        </Link>
      )}
      {p.status === "pending" && canDecide && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Button size="sm" disabled={busy} onClick={() => void accept()}>
            <Check className="size-3.5" /> 确认
          </Button>
          {p.kind === "create_task" && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" /> 编辑
            </Button>
          )}
          <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => setRejecting(true)}>
            <X className="size-3.5" /> 拒绝
          </Button>
        </div>
      )}
      {editing && <EditProposal p={p} onClose={() => setEditing(false)} onSaved={refresh} />}
      {rejecting && <RejectProposal id={proposalId} onClose={() => setRejecting(false)} onDone={refresh} />}
    </div>
  );
}

function EditProposal({ p, onClose, onSaved }: { p: Proposal; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(s(p.payload.title));
  const [description, setDescription] = useState(s(p.payload.description));
  const [criteria, setCriteria] = useState(strs(p.payload.acceptanceCriteria).join("\n"));
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑提议</DialogTitle>
          <DialogDescription>修改后卡片原地更新，不会产生新消息。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pe-title">标题</Label>
            <Input id="pe-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pe-desc">描述</Label>
            <Textarea id="pe-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pe-ac">验收标准（每行一条）</Label>
            <Textarea id="pe-ac" value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={4} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={busy || !title.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await unwrap(
                  api.api.v1.proposals({ id: p.id }).patch({
                    title: title.trim(),
                    description,
                    acceptanceCriteria: criteria
                      .split("\n")
                      .map((x) => x.trim())
                      .filter(Boolean),
                  }),
                );
                onSaved();
                onClose();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "保存失败");
              } finally {
                setBusy(false);
              }
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectProposal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>拒绝提议</DialogTitle>
          <DialogDescription>原因会显示在卡片上，船长下次提议时会参考。</DialogDescription>
        </DialogHeader>
        <Textarea aria-label="拒绝原因" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="例如：已有同类任务 PAY-3" />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !reason.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await unwrap(api.api.v1.proposals({ id }).reject.post({ reason: reason.trim() }));
                onDone();
                onClose();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "操作失败");
              } finally {
                setBusy(false);
              }
            }}
          >
            拒绝
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
