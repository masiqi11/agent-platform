import { cn } from "@/lib/utils";

const ROLE: Record<string, { label: string; cls: string }> = {
  owner: { label: "负责人", cls: "bg-attention-soft text-foreground ring-attention/40" },
  admin: { label: "管理员", cls: "bg-info-soft text-foreground ring-info/40" },
  member: { label: "成员", cls: "bg-idle-soft text-foreground ring-idle/30" },
  viewer: { label: "只读", cls: "bg-idle-soft text-muted-foreground ring-idle/30" },
  auditor: { label: "审计员", cls: "bg-agent-soft text-foreground ring-agent/40" },
};

export function RoleBadge({ role }: { role: string }) {
  const r = ROLE[role] ?? { label: role, cls: "bg-muted" };
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", r.cls)}>{r.label}</span>;
}

export function StatusDot({ tone, label }: { tone: "ok" | "danger" | "idle" | "attention" | "info"; label: string }) {
  const c = { ok: "bg-ok", danger: "bg-danger", idle: "bg-idle", attention: "bg-attention", info: "bg-info" }[tone];
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className={cn("size-2 rounded-full", c)} aria-hidden />
      {label}
    </span>
  );
}
