import { MessageCircle, Plus, Unlink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { StatusDot } from "@/components/badges";
import { EmptyState, ErrorState, PageHeader, PageSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, unwrap } from "@/lib/api";
import { INVALID_REASON, MODE_LABEL, imKeys, useBindings, useImProviders, useMyIdentities, type Binding } from "@/lib/im";
import { useGroups, useProject } from "@/lib/projects";
import { queryClient } from "@/lib/query";

const fmt = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
type Settings = { quietHours?: { start: string; end: string; tz?: string } | null; summaryMinIntervalMin?: number; mirrorHumans?: boolean };

/**
 * IM group bindings (§12.3, FR-IM-02). IM is an entry point and a notification channel only:
 * proposals, decisions and approvals are always made here in the Web (INV-06, IM-补6).
 */
export function ImPage({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const bindings = useBindings(projectId);
  const providers = useImProviders();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Binding | null>(null);
  const canManage = project.data?.canManage ?? false;
  const refresh = () => queryClient.invalidateQueries({ queryKey: imKeys.bindings(projectId) });
  const configured = (providers.data ?? []).length > 0;

  async function unbind(b: Binding) {
    if (!window.confirm(`解除与「${b.chatTitle ?? b.externalChatId}」的绑定？之后群消息不再同步。`)) return;
    try {
      await unwrap(api.api.v1.bindings({ id: b.id }).delete());
      toast.success("已解除绑定");
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    }
  }

  if (bindings.isPending || project.isPending) return <PageSkeleton />;
  if (bindings.error) return <ErrorState error={bindings.error} onRetry={() => void bindings.refetch()} />;
  const key = project.data?.key ?? "";
  return (
    <div className="space-y-5">
      <PageHeader
        title="IM 群"
        description="把钉钉群绑定到项目群：群里 @机器人 的消息进入平台，船长回复、任务卡片和摘要同步回群。提议确认与审批只在 Web 进行。"
        actions={
          canManage &&
          configured && (
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" /> 绑定群
            </Button>
          )
        }
      />
      {!configured && (
        <div className="rounded-xl border border-attention/40 bg-attention-soft/40 px-4 py-3 text-sm" role="status">
          平台还没有配置 IM 应用。管理员需在部署配置中填写钉钉企业内部应用的 Client ID / Secret（见部署文档「接入钉钉」）。
        </div>
      )}
      {bindings.data.length === 0 ? (
        <EmptyState
          icon={MessageCircle}
          title="还没有绑定 IM 群"
          body={`最简单的方式：在钉钉群里 @机器人 发送「/bind ${key}」（需要已绑定身份的 Maintainer）。身份绑定在右下角用户菜单 →「IM 身份」。`}
        />
      ) : (
        <ul className="space-y-3" data-testid="bindings">
          {bindings.data.map((b) => (
            <li key={b.id} className="rounded-2xl border bg-card px-5 py-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium">{b.chatTitle ?? b.externalChatId}</span>
                <span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">{b.providerLabel}</span>
                <StatusDot tone={b.status === "active" ? "ok" : "danger"} label={b.status === "active" ? "同步中" : `已失效：${INVALID_REASON[b.invalidReason ?? ""] ?? b.invalidReason ?? ""}`} />
                {canManage && b.status === "active" && (
                  <span className="ml-auto flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(b)}>
                      设置
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void unbind(b)}>
                      <Unlink className="size-4" /> 解绑
                    </Button>
                  </span>
                )}
              </div>
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-[13px] text-muted-foreground sm:grid-cols-2">
                <div>
                  平台群：<span className="text-foreground">{b.groupName}</span>
                </div>
                <div>
                  接收模式：<span className="text-foreground">{MODE_LABEL[b.mode] ?? b.mode}</span>
                </div>
                <div>
                  免打扰：
                  <span className="text-foreground">
                    {(b.settings as Settings).quietHours ? `${(b.settings as Settings).quietHours!.start}–${(b.settings as Settings).quietHours!.end}` : "未设置"}
                  </span>
                </div>
                <div>
                  出站：已发 {b.deliveries?.sent ?? 0}
                  {(b.deliveries?.dead ?? 0) > 0 && <span className="text-danger"> · 死信 {b.deliveries?.dead}</span>}
                  {(b.deliveries?.pending ?? 0) + (b.deliveries?.failed ?? 0) > 0 && <span> · 待发 {(b.deliveries?.pending ?? 0) + (b.deliveries?.failed ?? 0)}</span>}
                </div>
                <div className="sm:col-span-2">{b.status === "active" ? `绑定于 ${fmt(b.createdAt)}` : b.invalidatedAt ? `失效于 ${fmt(b.invalidatedAt)}，可重新绑定` : ""}</div>
              </dl>
            </li>
          ))}
        </ul>
      )}
      {adding && <AddBinding projectId={projectId} providers={providers.data ?? []} onClose={() => setAdding(false)} onDone={() => void refresh()} />}
      {editing && <EditBinding b={editing} onClose={() => setEditing(null)} onDone={() => void refresh()} />}
    </div>
  );
}

function AddBinding({ projectId, providers, onClose, onDone }: { projectId: string; providers: Array<{ provider: string; label: string }>; onClose(): void; onDone(): void }) {
  const groups = useGroups(projectId);
  const [provider, setProvider] = useState(providers[0]?.provider ?? "dingtalk");
  const [groupId, setGroupId] = useState("");
  const [chatId, setChatId] = useState("");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"at_only" | "passive">("at_only");
  const [busy, setBusy] = useState(false);
  const gid = groupId || groups.data?.find((g) => g.kind === "main")?.id || "";
  async function submit() {
    setBusy(true);
    try {
      await unwrap(api.api.v1.bindings.post({ groupId: gid, provider, externalChatId: chatId.trim(), chatTitle: title.trim() || undefined, mode }));
      toast.success("已绑定");
      onDone();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "绑定失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>绑定 IM 群</DialogTitle>
          <DialogDescription>一个外部群只能绑定一个平台群。通常更方便的做法是在群里 @机器人 发送 /bind。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>IM</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.provider} value={p.provider}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>平台群</Label>
            <Select value={gid} onValueChange={setGroupId}>
              <SelectTrigger>
                <SelectValue placeholder="选择群" />
              </SelectTrigger>
              <SelectContent>
                {(groups.data ?? []).map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="im-chat">外部群 ID（openConversationId）</Label>
            <Input id="im-chat" value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="cid…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="im-title">群名称（可选）</Label>
            <Input id="im-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>接收模式</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as "at_only" | "passive")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="at_only">仅 @机器人（推荐）</SelectItem>
                <SelectItem value="passive">接收全部消息（应用需有群消息权限；摘要批处理）</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy || !chatId.trim() || !gid} onClick={() => void submit()}>
            绑定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditBinding({ b, onClose, onDone }: { b: Binding; onClose(): void; onDone(): void }) {
  const s = b.settings as Settings;
  const [mode, setMode] = useState(b.mode as "at_only" | "passive");
  const [quiet, setQuiet] = useState(Boolean(s.quietHours));
  const [start, setStart] = useState(s.quietHours?.start ?? "22:00");
  const [end, setEnd] = useState(s.quietHours?.end ?? "08:00");
  const [interval, setInterval] = useState(String(s.summaryMinIntervalMin ?? 60));
  const [mirrorHumans, setMirrorHumans] = useState(Boolean(s.mirrorHumans));
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await unwrap(
        api.api.v1.bindings({ id: b.id }).patch({
          mode,
          settings: { quietHours: quiet ? { start, end, tz: s.quietHours?.tz } : null, summaryMinIntervalMin: Number(interval) || 0, mirrorHumans },
        }),
      );
      toast.success("已保存");
      onDone();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>同步设置 · {b.chatTitle ?? b.externalChatId}</DialogTitle>
          <DialogDescription>免打扰时段里，船长的主动消息（摘要、通知）等到时段结束再发；有人正在群里对话时的回复照常发送。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>接收模式</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as "at_only" | "passive")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="at_only">仅 @机器人</SelectItem>
                <SelectItem value="passive">接收全部消息</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="im-quiet">免打扰时段</Label>
            <Switch id="im-quiet" checked={quiet} onCheckedChange={setQuiet} />
          </div>
          {quiet && (
            <div className="flex items-center gap-2">
              <Input aria-label="开始" className="w-24" value={start} onChange={(e) => setStart(e.target.value)} placeholder="22:00" />
              <span>至</span>
              <Input aria-label="结束" className="w-24" value={end} onChange={(e) => setEnd(e.target.value)} placeholder="08:00" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="im-interval">摘要最短间隔（分钟）</Label>
            <Input id="im-interval" inputMode="numeric" className="w-28" value={interval} onChange={(e) => setInterval(e.target.value.replace(/\D/g, ""))} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="im-humans">同步 Web 里的成员发言</Label>
            <Switch id="im-humans" checked={mirrorHumans} onCheckedChange={setMirrorHumans} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Personal IM identity (IM-补1): generate a one-time code, DM it to the bot. */
export function ImIdentityDialog({ onClose }: { onClose(): void }) {
  const providers = useImProviders();
  const mine = useMyIdentities();
  const [code, setCode] = useState<{ code: string; hint: string; expiresAt: string } | null>(null);
  const provider = providers.data?.[0]?.provider;
  async function generate() {
    if (!provider) return;
    try {
      setCode(await unwrap(api.api.v1["external-identities"].post({ provider })));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "生成失败");
    }
  }
  async function remove(id: string) {
    try {
      await unwrap(api.api.v1["external-identities"]({ id }).delete());
      void queryClient.invalidateQueries({ queryKey: imKeys.mine });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    }
  }
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>IM 身份</DialogTitle>
          <DialogDescription>绑定后，你在钉钉群里的消息会以你的身份进入平台，并按你的权限执行命令。未绑定时显示为“外部成员”，没有任何权限。</DialogDescription>
        </DialogHeader>
        {!provider ? (
          <p className="text-sm text-muted-foreground">平台还没有配置 IM 应用。</p>
        ) : (
          <div className="space-y-4">
            {(mine.data ?? []).length > 0 && (
              <ul className="space-y-2">
                {(mine.data ?? []).map((x) => (
                  <li key={x.id} className="flex items-center gap-2 text-sm">
                    <span className="rounded bg-muted px-1.5 text-[11px]">{x.providerLabel}</span>
                    <span className="font-mono text-xs">{x.externalUserId}</span>
                    <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void remove(x.id)}>
                      解除
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {code ? (
              <div className="rounded-xl bg-muted/60 px-4 py-3">
                <p className="font-mono text-2xl tracking-[0.3em]" data-testid="bind-code">
                  {code.code}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {code.hint}。{fmt(code.expiresAt)} 前有效，只能用一次。
                </p>
              </div>
            ) : (
              <Button onClick={() => void generate()}>生成绑定码</Button>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
