import { useMutation } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, newIdempotencyKey, unwrap } from "@/lib/api";
import { useAgents } from "@/lib/projects";
import { queryClient } from "@/lib/query";
import { PRIORITY_TONE, STATUS_LABEL, STATUS_TONE, type TaskStatus } from "@/lib/tasks";
import { cn } from "@/lib/utils";

export function StatusPill({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", STATUS_TONE[status] ?? "bg-muted", className)}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
export function PriorityPill({ priority }: { priority: string }) {
  return <span className={cn("inline-flex rounded px-1.5 py-px font-mono text-[10px] font-semibold", PRIORITY_TONE[priority] ?? "bg-muted")}>{priority}</span>;
}

/** Turns an illegal_transition error into "缺少：A、B" (§13.3: snap back and say what's missing). */
export function transitionErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.details as { missingLabels?: string[] } | undefined;
    if (d?.missingLabels?.length) return `不能变更：缺少 ${d.missingLabels.join("、")}`;
    return e.message;
  }
  return e instanceof Error ? e.message : "操作失败";
}

export async function runTransition(task: { id: string; version: number; projectId: string }, to: TaskStatus, extra: { reason?: string; needs?: string } = {}) {
  const r = await unwrap(api.api.v1.tasks({ id: task.id }).transition.post({ to, ...extra }, { headers: { "if-match": String(task.version) } }));
  void queryClient.invalidateQueries({ queryKey: ["tasks", task.projectId] });
  // Wait for the task's new version before the caller reports success: the next edit on the page
  // must not be sent with the old If-Match (#8: transition then criteria → 409).
  await queryClient.invalidateQueries({ queryKey: ["task", task.id] });
  void queryClient.invalidateQueries({ queryKey: ["task-timeline", task.id] });
  return r;
}

/** Transitions that need words from a human: blocked (reason + who decides) and cancel (reason). */
export const NEEDS_INPUT: Partial<Record<TaskStatus, { reason: string; needs?: string }>> = {
  blocked: { reason: "阻塞原因", needs: "需要谁决策" },
  cancelled: { reason: "取消原因" },
};

export function TransitionDialog({ open, to, onClose, onSubmit }: { open: boolean; to: TaskStatus | null; onClose: () => void; onSubmit: (v: { reason: string; needs?: string }) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [needs, setNeeds] = useState("");
  const [busy, setBusy] = useState(false);
  const cfg = to ? NEEDS_INPUT[to] : undefined;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>变更为「{to ? STATUS_LABEL[to] : ""}」</DialogTitle>
          <DialogDescription>这次变更需要留下说明，会写入时间线和审计。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tr-reason">{cfg?.reason ?? "原因"}</Label>
            <Textarea id="tr-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          </div>
          {cfg?.needs && (
            <div className="space-y-1.5">
              <Label htmlFor="tr-needs">{cfg.needs}</Label>
              <Input id="tr-needs" value={needs} onChange={(e) => setNeeds(e.target.value)} placeholder="例如：@王经理 确认接口口径" />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={busy || !reason.trim() || (Boolean(cfg?.needs) && !needs.trim())}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit({ reason: reason.trim(), needs: cfg?.needs ? needs.trim() : undefined });
              } finally {
                setBusy(false);
              }
            }}
          >
            确认变更
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface CreateTaskSeed {
  title?: string;
  description?: string;
  groupId?: string;
  sourceMessageIds?: string[];
}

export function CreateTaskDialog({
  projectId,
  open,
  onClose,
  seed,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  seed?: CreateTaskSeed;
  onCreated?: (t: { id: string; ref: string }) => void;
}) {
  const agents = useAgents(projectId);
  const [title, setTitle] = useState(seed?.title ?? "");
  const [description, setDescription] = useState(seed?.description ?? "");
  const [priority, setPriority] = useState<"P0" | "P1" | "P2" | "P3">("P2");
  const [type, setType] = useState<"feature" | "bug" | "hotfix" | "chore">("feature");
  const [assignee, setAssignee] = useState<string>("none");
  const [criteria, setCriteria] = useState<string[]>([""]);
  const [idem] = useState(newIdempotencyKey);
  const devs = (agents.data ?? []).filter((a) => a.role === "dev" && a.status === "active");
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.api.v1.tasks.post(
          {
            projectId,
            title: title.trim(),
            description,
            priority,
            type,
            assigneeAgentId: assignee === "none" ? null : assignee,
            acceptanceCriteria: criteria.map((c) => c.trim()).filter(Boolean),
            groupId: seed?.groupId ?? null,
            sourceMessageIds: seed?.sourceMessageIds,
          },
          { headers: { "idempotency-key": idem } },
        ),
      ),
    onSuccess: (t) => {
      toast.success(`已创建 ${t.ref}`);
      void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
      onCreated?.(t);
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "创建失败"),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
          <DialogDescription>{seed?.sourceMessageIds?.length ? "来源消息会挂在任务上，便于追溯。" : "你会成为这个任务的人类 owner。"}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) m.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="task-title">标题</Label>
            <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus placeholder="例如：支付回调签名校验" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-desc">描述</Label>
            <Textarea id="task-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>类型</Label>
              <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
                <SelectTrigger aria-label="类型">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="feature">功能</SelectItem>
                  <SelectItem value="bug">缺陷</SelectItem>
                  <SelectItem value="hotfix">热修复</SelectItem>
                  <SelectItem value="chore">杂项</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>优先级</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as typeof priority)}>
                <SelectTrigger aria-label="优先级">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["P0", "P1", "P2", "P3"] as const).map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>负责 Agent</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger aria-label="负责 Agent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">暂不分配</SelectItem>
                  {devs.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>验收标准</Label>
            <div className="space-y-1.5">
              {criteria.map((c, i) => (
                <div key={i} className="flex gap-1.5">
                  <Input
                    aria-label={`验收标准 ${i + 1}`}
                    value={c}
                    onChange={(e) => setCriteria((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))}
                    placeholder="可验证的一句话，例如：伪造签名返回 401"
                  />
                  {criteria.length > 1 && (
                    <Button type="button" variant="ghost" size="icon" aria-label="删除这条" onClick={() => setCriteria((xs) => xs.filter((_, j) => j !== i))}>
                      <X className="size-4" />
                    </Button>
                  )}
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" onClick={() => setCriteria((xs) => [...xs, ""])}>
                <Plus className="size-3.5" /> 添加一条
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={!title.trim() || m.isPending}>
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
