import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Copy, KeyRound, MoreHorizontal, UserMinus, UserPlus, UserCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { RoleBadge, StatusDot } from "@/components/badges";
import { EmptyState, ErrorState, PageHeader, PageSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, unwrap } from "@/lib/api";
import { relativeTime, absoluteTime, t } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { qk, queryClient } from "@/lib/query";

type Role = "owner" | "admin" | "member" | "viewer" | "auditor";
const ROLES: Array<[Role, string]> = [
  ["member", "成员"],
  ["viewer", "只读"],
  ["admin", "管理员"],
  ["auditor", "审计员"],
  ["owner", "负责人"],
];

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <Input readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
      <Button
        variant="outline"
        size="icon"
        aria-label="复制链接"
        onClick={async () => {
          await navigator.clipboard?.writeText(value).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange(v: boolean): void }) {
  const [role, setRole] = useState<Role>("member");
  const [email, setEmail] = useState("");
  const m = useMutation({ mutationFn: () => unwrap(api.api.v1.invitations.post({ tenantRole: role, ...(email ? { email } : {}) })) });
  const close = (v: boolean) => {
    onOpenChange(v);
    if (!v) {
      m.reset();
      setEmail("");
    }
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("users.invite")}</DialogTitle>
          <DialogDescription>生成一次性邀请链接（72 小时有效）。填写邮箱后只有该邮箱能接受。</DialogDescription>
        </DialogHeader>
        {m.data ? (
          <div className="space-y-2">
            <Label>邀请链接</Label>
            <CopyField value={m.data.url} />
            <p className="text-xs text-muted-foreground">过期时间：{absoluteTime(m.data.expiresAt)}。链接只显示一次。</p>
          </div>
        ) : (
          <form
            id="invite-form"
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="inv-email">邮箱（可选）</Label>
              <Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@company.com" />
            </div>
            <div className="space-y-1.5">
              <Label>租户角色</Label>
              <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {m.error ? <ErrorState error={m.error} /> : null}
          </form>
        )}
        <DialogFooter>
          {m.data ? (
            <Button onClick={() => close(false)}>完成</Button>
          ) : (
            <Button type="submit" form="invite-form" disabled={m.isPending}>
              生成链接
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DisableDialog({ user, onOpenChange }: { user: { id: string; name: string } | null; onOpenChange(v: boolean): void }) {
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => unwrap(api.api.v1.users({ id: user!.id }).patch({ status: "disabled", reason })),
    onSuccess: () => {
      toast.success(`已停用 ${user!.name}，其会话已全部失效`);
      void queryClient.invalidateQueries({ queryKey: qk.users });
      onOpenChange(false);
      setReason("");
    },
  });
  return (
    <Dialog open={Boolean(user)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>停用 {user?.name}？</DialogTitle>
          <DialogDescription>停用后该用户所有会话立即失效。若其是某些任务的唯一 owner，需要先指定继任者。</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="disable-reason">原因（必填，写入审计）</Label>
          <Textarea id="disable-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </div>
        {m.error ? <ErrorState error={m.error} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="destructive" disabled={reason.trim().length < 2 || m.isPending} onClick={() => m.mutate()}>
            确认停用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UsersPage() {
  const { data: me } = useMe();
  const users = useQuery({ queryKey: qk.users, queryFn: () => unwrap(api.api.v1.users.get()) });
  const [invite, setInvite] = useState(false);
  const [disabling, setDisabling] = useState<{ id: string; name: string } | null>(null);
  const [resetUrl, setResetUrl] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (v: { id: string; tenantRole?: Role; status?: "active" }) => unwrap(api.api.v1.users({ id: v.id }).patch({ ...(v.tenantRole ? { tenantRole: v.tenantRole } : {}), ...(v.status ? { status: v.status } : {}) })),
    onSuccess: () => {
      toast.success("已更新");
      void queryClient.invalidateQueries({ queryKey: qk.users });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "更新失败"),
  });
  const reset = useMutation({ mutationFn: (id: string) => unwrap(api.api.v1.users({ id })["reset-link"].post()), onSuccess: (r) => setResetUrl(r.url) });

  return (
    <div>
      <PageHeader
        title={t("users.title")}
        description={users.data ? `${users.data.filter((u) => u.status === "active").length} 位活跃成员` : undefined}
        actions={
          <Button onClick={() => setInvite(true)}>
            <UserPlus className="size-4" /> {t("users.invite")}
          </Button>
        }
      />
      {users.isPending ? (
        <PageSkeleton />
      ) : users.error ? (
        <ErrorState error={users.error} onRetry={() => void users.refetch()} />
      ) : users.data.length <= 1 ? (
        <>
          <UsersTable rows={users.data} meId={me?.userId ?? null} onRole={(id, r) => update.mutate({ id, tenantRole: r })} onDisable={setDisabling} onEnable={(id) => update.mutate({ id, status: "active" })} onReset={(id) => reset.mutate(id)} />
          <div className="mt-6">
            <EmptyState icon={UserPlus} title="邀请你的同事" body={t("users.empty")} action={<Button onClick={() => setInvite(true)}>{t("users.invite")}</Button>} />
          </div>
        </>
      ) : (
        <UsersTable rows={users.data} meId={me?.userId ?? null} onRole={(id, r) => update.mutate({ id, tenantRole: r })} onDisable={setDisabling} onEnable={(id) => update.mutate({ id, status: "active" })} onReset={(id) => reset.mutate(id)} />
      )}
      <InviteDialog open={invite} onOpenChange={setInvite} />
      <DisableDialog user={disabling} onOpenChange={(v) => !v && setDisabling(null)} />
      <Dialog open={Boolean(resetUrl)} onOpenChange={(v) => !v && setResetUrl(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>密码重置链接</DialogTitle>
            <DialogDescription>24 小时内有效，只能使用一次。请通过安全渠道发给对方。</DialogDescription>
          </DialogHeader>
          {resetUrl ? <CopyField value={resetUrl} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

type Row = { id: string; email: string; name: string; tenantRole: string; status: string; createdAt: string };
function UsersTable({ rows, meId, onRole, onDisable, onEnable, onReset }: { rows: Row[]; meId: string | null; onRole(id: string, r: Role): void; onDisable(u: { id: string; name: string }): void; onEnable(id: string): void; onReset(id: string): void }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="pl-4">成员</TableHead>
            <TableHead>角色</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>加入时间</TableHead>
            <TableHead className="w-12" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((u) => (
            <TableRow key={u.id} data-testid="user-row">
              <TableCell className="pl-4">
                <div className="flex items-center gap-3">
                  <span className="grid size-8 place-items-center rounded-full bg-accent text-sm font-medium text-accent-foreground">{u.name.slice(0, 1)}</span>
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {u.name} {u.id === meId ? <span className="text-xs font-normal text-muted-foreground">（你）</span> : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <RoleBadge role={u.tenantRole} />
              </TableCell>
              <TableCell>{u.status === "active" ? <StatusDot tone="ok" label="活跃" /> : <StatusDot tone="idle" label="已停用" />}</TableCell>
              <TableCell className="text-sm text-muted-foreground" title={absoluteTime(u.createdAt)}>
                {relativeTime(u.createdAt)}
              </TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={`管理 ${u.name}`}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {ROLES.filter(([r]) => r !== u.tenantRole).map(([r, l]) => (
                      <DropdownMenuItem key={r} onClick={() => onRole(u.id, r)}>
                        设为{l}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => onReset(u.id)}>
                      <KeyRound className="size-4" /> 生成重置密码链接
                    </DropdownMenuItem>
                    {u.status === "active" ? (
                      <DropdownMenuItem variant="destructive" disabled={u.id === meId} onClick={() => onDisable({ id: u.id, name: u.name })}>
                        <UserMinus className="size-4" /> 停用
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => onEnable(u.id)}>
                        <UserCheck className="size-4" /> 重新启用
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
