import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Hash, ListTree, Loader2, MessagesSquare, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PrincipalAvatar } from "@/components/agent-avatar";
import { EmptyState, ErrorState, PageSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, newIdempotencyKey, unwrap } from "@/lib/api";
import { useMe } from "@/lib/me";
import { AGENT_ROLE_LABEL, useGroups, useProject, type Group } from "@/lib/projects";
import { qk, queryClient } from "@/lib/query";
import { realtime } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { Composer, type MemberLite } from "./composer";
import { MessageItem, type MessageActions } from "./message-item";
import { CreateTaskDialog, StatusPill } from "@/components/task-bits";
import { useTasks } from "@/lib/tasks";
import { catchUp, loadInitial, loadOlder, patch, refreshOne, upsertConfirmed, type Msg, type TimelineState } from "./timeline-store";

type Row = { key: string; type: "date"; label: string } | { key: string; type: "unread" } | { key: string; type: "msg"; m: Msg; compact: boolean };

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "今天";
  if (d.toDateString() === y.toDateString()) return "昨天";
  return d.toLocaleDateString("zh-CN", { year: d.getFullYear() === today.getFullYear() ? undefined : "numeric", month: "long", day: "numeric", weekday: "short" });
}

function buildRows(items: Msg[], readAnchor: number, meId: string): Row[] {
  const rows: Row[] = [];
  let prev: Msg | undefined;
  let unreadPlaced = false;
  for (const m of items) {
    const day = new Date(m.createdAt).toDateString();
    const newDay = !prev || new Date(prev.createdAt).toDateString() !== day;
    if (newDay) rows.push({ key: `d-${day}`, type: "date", label: dayLabel(m.createdAt) });
    let unreadHere = false;
    if (!unreadPlaced && readAnchor > 0 && m.seq > readAnchor && !m.pending && m.author.principalId !== meId) {
      rows.push({ key: "unread", type: "unread" });
      unreadPlaced = unreadHere = true;
    }
    const compact =
      !newDay &&
      !unreadHere &&
      !!prev &&
      prev.author.principalId === m.author.principalId &&
      m.kind === "text" &&
      prev.kind === "text" &&
      !m.replyTo &&
      new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
    rows.push({ key: m.clientId ?? m.id, type: "msg", m, compact });
    prev = m;
  }
  return rows;
}

export function ChatPage({ projectId, groupId: gParam, seq, threadId }: { projectId: string; groupId?: string; seq?: number; threadId?: string }) {
  const navigate = useNavigate();
  const project = useProject(projectId);
  const groups = useGroups(projectId);
  const groupId = gParam ?? project.data?.mainGroupId ?? undefined;
  const group = groups.data?.find((g) => g.id === groupId);

  useEffect(() => {
    if (!gParam && project.data?.mainGroupId) void navigate({ to: "/projects/$projectId/chat", params: { projectId }, search: { g: project.data.mainGroupId }, replace: true });
  }, [gParam, project.data?.mainGroupId, navigate, projectId]);

  if (project.isPending || groups.isPending) return <PageSkeleton className="p-6" />;
  if (project.error)
    return (
      <div className="w-full p-6">
        <ErrorState error={project.error} onRetry={() => void project.refetch()} />
      </div>
    );
  if (groups.error)
    return (
      <div className="w-full p-6">
        <ErrorState error={groups.error} onRetry={() => void groups.refetch()} />
      </div>
    );
  const p = project.data;

  return (
    <div className="grid min-h-0 w-full grid-cols-[248px_minmax(0,1fr)] xl:grid-cols-[248px_minmax(0,1fr)_300px]">
      <LeftColumn projectId={projectId} groups={groups.data} activeGroupId={groupId} activeThreadId={threadId} canManage={p.canManage} archived={p.status === "archived"} />
      {groupId && group ? (
        <ConversationColumn
          key={groupId}
          projectId={projectId}
          projectKey={p.key}
          group={group}
          seq={seq}
          canModerate={p.myRole === "maintainer" || p.canManage}
          canDecide={p.myRole !== "viewer" && p.status !== "archived"}
          readOnlyReason={
            p.status === "archived" ? "项目已归档，只读" : group.status !== "active" ? "群已归档，只读" : p.myRole === "viewer" ? "访客只能查看，不能发言" : !group.member ? "你不是本群成员" : null
          }
        />
      ) : (
        <div className="grid place-items-center">
          <EmptyState icon={MessagesSquare} title="群不存在或无权访问" body="从左侧选择一个群开始对话。" />
        </div>
      )}
      {groupId && group && <RightColumn key={threadId ?? "main"} groupId={groupId} threadId={threadId} projectId={projectId} />}
    </div>
  );
}

function LeftColumn({
  projectId,
  groups,
  activeGroupId,
  activeThreadId,
  canManage,
  archived,
}: {
  projectId: string;
  groups: Group[];
  activeGroupId?: string;
  activeThreadId?: string;
  canManage: boolean;
  archived: boolean;
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q]);
  const search = useQuery({
    queryKey: qk.search(projectId, debounced),
    enabled: debounced.length > 0,
    queryFn: () => unwrap(api.api.v1.projects({ id: projectId }).search.get({ query: { q: debounced, limit: 30 } })),
  });
  const threads = useQuery({ queryKey: qk.threads(activeGroupId ?? ""), enabled: Boolean(activeGroupId), queryFn: () => unwrap(api.api.v1.groups({ id: activeGroupId! }).threads.get()) });
  const terms = debounced.split(/\s+/).filter(Boolean);

  return (
    <aside className="flex min-h-0 flex-col border-r bg-sidebar/40" aria-label="群与线程">
      <div className="border-b p-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索本项目消息" className="h-8 pl-8 text-sm" aria-label="搜索消息" data-testid="chat-search" />
          {q && (
            <button type="button" className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground" onClick={() => setQ("")} aria-label="清空搜索">
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {debounced ? (
          search.isPending ? (
            <PageSkeleton rows={4} />
          ) : search.error ? (
            <ErrorState error={search.error} onRetry={() => void search.refetch()} />
          ) : search.data.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">没有匹配「{debounced}」的消息</p>
          ) : (
            <ul className="space-y-1" aria-label="搜索结果">
              {search.data.map((r) => (
                <li key={r.messageId}>
                  <button
                    type="button"
                    data-testid="search-hit"
                    onClick={() => void navigate({ to: "/projects/$projectId/chat", params: { projectId }, search: { g: r.groupId, seq: r.seq } })}
                    className="w-full rounded-md px-2 py-1.5 text-left hover:bg-muted"
                  >
                    <p className="flex justify-between text-[11px] text-muted-foreground">
                      <span>
                        # {r.groupName} · {r.authorLabel}
                      </span>
                      <span>#{r.seq}</span>
                    </p>
                    <p className="line-clamp-2 text-sm">
                      <Highlight text={r.snippet} terms={terms} />
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <>
            <div className="mb-1 flex items-center justify-between px-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">群</p>
              {canManage && !archived && (
                <Button variant="ghost" size="icon" className="size-6" aria-label="新建群" onClick={() => setCreating(true)}>
                  <Plus className="size-3.5" />
                </Button>
              )}
            </div>
            <ul className="space-y-0.5">
              {groups
                .filter((g) => g.status === "active" || g.id === activeGroupId)
                .map((g) => (
                  <li key={g.id}>
                    <button
                      type="button"
                      onClick={() => void navigate({ to: "/projects/$projectId/chat", params: { projectId }, search: { g: g.id } })}
                      className={cn(
                        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted",
                        g.id === activeGroupId && !activeThreadId && "bg-accent font-medium",
                        g.unread > 0 && "font-semibold",
                      )}
                      aria-current={g.id === activeGroupId ? "page" : undefined}
                      data-testid="group-item"
                    >
                      <Hash className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate">{g.name}</span>
                      {g.mentioned && (
                        <span className="ml-auto rounded bg-attention px-1 text-[10px] font-bold text-black/80" aria-label="有人提及你">
                          @
                        </span>
                      )}
                      {g.unread > 0 && (
                        <span className={cn("rounded-full bg-primary px-1.5 text-[10px] leading-4 font-semibold text-primary-foreground", !g.mentioned && "ml-auto")} aria-label={`${g.unread} 条未读`}>
                          {g.unread > 99 ? "99+" : g.unread}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
            </ul>
            <p className="mt-4 mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">本群线程</p>
            {threads.data && threads.data.length > 0 ? (
              <ul className="space-y-0.5">
                {threads.data.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => void navigate({ to: "/projects/$projectId/chat", params: { projectId }, search: { g: activeGroupId, t: t.id } })}
                      className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted", t.id === activeThreadId && "bg-accent font-medium")}
                    >
                      <ListTree className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate">{t.title}</span>
                      <span className="ml-auto text-[11px] text-muted-foreground">{t.messageCount}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2 text-xs text-muted-foreground">悬停消息点击「开线程」可就某条消息单独讨论。</p>
            )}
          </>
        )}
      </div>
      <CreateGroupDialog projectId={projectId} open={creating} onOpenChange={setCreating} />
    </aside>
  );
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-attention-soft px-0.5 text-foreground">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function CreateGroupDialog({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange(v: boolean): void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>新建话题群</DialogTitle>
        </DialogHeader>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：支付回调排查" aria-label="群名称" maxLength={60} autoFocus />
        <DialogFooter>
          <Button
            disabled={!name.trim() || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await unwrap(api.api.v1.projects({ id: projectId }).groups.post({ name: name.trim() }));
                await queryClient.invalidateQueries({ queryKey: qk.groups(projectId) });
                onOpenChange(false);
                setName("");
                void navigate({ to: "/projects/$projectId/chat", params: { projectId }, search: { g: r.id } });
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "创建失败");
              } finally {
                setBusy(false);
              }
            }}
          >
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useGroupMembers(groupId: string) {
  return useQuery({ queryKey: qk.groupMembers(groupId), queryFn: () => unwrap(api.api.v1.groups({ id: groupId }).members.get()) });
}

function ConversationColumn({
  projectId,
  projectKey,
  group,
  seq,
  canModerate,
  canDecide,
  readOnlyReason,
}: {
  projectId: string;
  projectKey: string;
  group: Group;
  seq?: number;
  canModerate: boolean;
  canDecide: boolean;
  readOnlyReason: string | null;
}) {
  const groupId = group.id;
  const { data: me } = useMe();
  const meId = me?.principalId ?? "";
  const members = useGroupMembers(groupId);
  const timeline = useQuery({ queryKey: qk.timeline(groupId), queryFn: () => loadInitial(groupId, seq), staleTime: Infinity, gcTime: 5 * 60_000 });
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [editing, setEditing] = useState<Msg | null>(null);
  const [deleting, setDeleting] = useState<Msg | null>(null);
  const [threadOf, setThreadOf] = useState<Msg | null>(null);
  const [taskFrom, setTaskFrom] = useState<Msg | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [newBelow, setNewBelow] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const payloads = useRef(new Map<string, { body: string; attachmentIds: string[]; replyToId?: string }>());

  const items = useMemo(() => timeline.data?.items ?? [], [timeline.data?.items]);
  const rows = useMemo(() => buildRows(items, timeline.data?.readAnchor ?? 0, meId), [items, timeline.data?.readAnchor, meId]);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.type === "msg" ? ((rows[i] as { compact: boolean }).compact ? 28 : 64) : 36),
    overscan: 12,
    getItemKey: (i) => rows[i]!.key,
  });

  // Search jump to a seq not in the loaded window → reload around it; otherwise just focus it.
  useEffect(() => {
    if (!seq || !timeline.data) return;
    if (timeline.data.items.some((m) => m.seq === seq)) patch(groupId, (s) => ({ ...s, focusSeq: seq, highlight: true }));
    else void loadInitial(groupId, seq).then((s) => queryClient.setQueryData(qk.timeline(groupId), s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq]);

  // Initial / focus scroll.
  const focusSeq = timeline.data?.focusSeq ?? null;
  const didInitial = useRef(false);
  useLayoutEffect(() => {
    if (!timeline.data || rows.length === 0) return;
    if (focusSeq) {
      const idx = rows.findIndex((r) => r.type === "msg" && r.m.seq === focusSeq);
      if (idx >= 0) {
        virt.scrollToIndex(Math.max(0, idx - (rows[idx - 1]?.type === "unread" ? 1 : 0)), { align: "center" });
        didInitial.current = true;
        const h = setTimeout(() => patch(groupId, (s) => ({ ...s, focusSeq: null })), 2500);
        return () => clearTimeout(h);
      }
    }
    if (!didInitial.current) {
      virt.scrollToIndex(rows.length - 1, { align: "end" });
      didInitial.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSeq, timeline.data !== undefined]);

  // Stick to bottom on new messages when already at bottom; otherwise count them.
  const lastKey = rows[rows.length - 1]?.key;
  const prevLast = useRef(lastKey);
  useEffect(() => {
    if (prevLast.current === lastKey) return;
    const last = rows[rows.length - 1];
    const mine = last?.type === "msg" && last.m.author.principalId === meId;
    if (atBottom || mine) requestAnimationFrame(() => virt.scrollToIndex(rows.length - 1, { align: "end" }));
    else setNewBelow((n) => n + 1);
    prevLast.current = lastKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastKey]);

  // Realtime: group topic.
  useEffect(() => {
    const topic = `group:${groupId}`;
    const off = realtime.subscribe(topic);
    const offF = realtime.onFrame((f) => {
      if (f.topic !== topic) return;
      if (f.type === "resync") return void catchUp(groupId);
      if (f.type !== "event") return;
      const p = f.event.payload as { seq?: number };
      if (f.event.type === "message.created") void catchUp(groupId);
      else if ((f.event.type === "message.updated" || f.event.type === "message.deleted") && typeof p.seq === "number") void refreshOne(groupId, p.seq);
      else if (f.event.type === "thread.created") void queryClient.invalidateQueries({ queryKey: qk.threads(groupId) });
    });
    // Catch up anything that happened while this group was not open.
    if (queryClient.getQueryData(qk.timeline(groupId))) void catchUp(groupId);
    return () => {
      off();
      offF();
    };
  }, [groupId]);

  // Mark read when the bottom is visible.
  const latestConfirmed = items.toReversed().find((m) => !m.pending)?.seq ?? 0;
  const markedRef = useRef(group.lastReadSeq);
  useEffect(() => {
    if (!atBottom || latestConfirmed <= markedRef.current || !group.member || document.visibilityState !== "visible") return;
    const h = setTimeout(() => {
      markedRef.current = latestConfirmed;
      setNewBelow(0);
      void unwrap(api.api.v1.groups({ id: groupId }).read.post({ seq: latestConfirmed })).then(() =>
        queryClient.setQueryData<Group[]>(qk.groups(projectId), (gs) => gs?.map((g) => (g.id === groupId ? { ...g, unread: 0, mentioned: false, lastReadSeq: latestConfirmed } : g))),
      );
    }, 400);
    return () => clearTimeout(h);
  }, [atBottom, latestConfirmed, groupId, projectId, group.member]);

  const onScroll = useCallback(async () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(bottom);
    if (bottom) setNewBelow(0);
    if (el.scrollTop < 240 && !loadingOlder && timeline.data?.hasMoreBefore) {
      setLoadingOlder(true);
      const firstKey = rows.find((r) => r.type === "msg")?.key;
      try {
        await loadOlder(groupId);
        requestAnimationFrame(() => {
          const s = queryClient.getQueryData<TimelineState>(qk.timeline(groupId));
          if (!s || !firstKey) return;
          const idx = buildRows(s.items, s.readAnchor, meId).findIndex((r) => r.key === firstKey);
          if (idx > 0) virt.scrollToIndex(idx, { align: "start" });
        });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "加载失败");
      } finally {
        setLoadingOlder(false);
      }
    }
  }, [groupId, loadingOlder, timeline.data?.hasMoreBefore, rows, meId, virt]);

  async function send(body: string, attachmentIds: string[], replyToId?: string, retryOf?: Msg) {
    const clientId = retryOf?.clientId ?? newIdempotencyKey();
    const optimistic: Msg = retryOf
      ? { ...retryOf, pending: "sending" }
      : {
          id: `local-${clientId}`,
          clientId,
          groupId,
          threadId: null,
          seq: 0,
          author: { principalId: meId, name: me?.displayName ?? "我", kind: "human", currentName: me?.displayName ?? "我" },
          kind: "text",
          body,
          blocks: null,
          mentions: [],
          replyTo: replyToId && replyTo ? { id: replyTo.id, seq: replyTo.seq, authorLabel: replyTo.author.name, excerpt: replyTo.body.slice(0, 80) } : null,
          attachments: [],
          source: "web",
          editedAt: null,
          deleted: false,
          correctedAt: null,
          createdAt: new Date().toISOString(),
          pending: "sending",
        };
    patch(groupId, (s) => ({ ...s, items: retryOf ? s.items.map((m) => (m.clientId === clientId ? optimistic : m)) : [...s.items, optimistic] }));
    payloads.current.set(clientId, { body, attachmentIds, replyToId });
    try {
      // The client id doubles as the Idempotency-Key, so a retry after a lost response never duplicates (INV-15).
      const r = await unwrap(api.api.v1.groups({ id: groupId }).messages.post({ body, attachmentIds, replyToId: replyToId ?? null }, { headers: { "idempotency-key": clientId } }));
      upsertConfirmed(groupId, r.message, clientId);
      payloads.current.delete(clientId);
      for (const w of r.warnings) toast.warning(w);
    } catch (e) {
      patch(groupId, (s) => ({ ...s, items: s.items.map((m) => (m.clientId === clientId ? { ...m, pending: "failed" } : m)) }));
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
        toast.error(e.message);
        patch(groupId, (s) => ({ ...s, items: s.items.filter((m) => m.clientId !== clientId) }));
      }
    }
  }

  const actions: MessageActions = useMemo(
    () => ({
      onReply: setReplyTo,
      onEdit: setEditing,
      onDelete: setDeleting,
      onThread: setThreadOf,
      onCreateTask: setTaskFrom,
      onRetry: (m) => {
        const pl = m.clientId ? payloads.current.get(m.clientId) : undefined;
        void send(pl?.body ?? m.body, pl?.attachmentIds ?? [], pl?.replyToId, m);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groupId],
  );

  const memberLite: MemberLite[] = useMemo(
    () => (members.data ?? []).map((m) => ({ principalId: m.principalId, name: m.name, kind: m.kind, agentRole: m.agentRole, active: m.active })),
    [members.data],
  );
  const mentionNames = useMemo(() => [...memberLite.map((m) => m.name), "所有人"], [memberLite]);

  return (
    <section className="relative flex min-h-0 min-w-0 flex-col" aria-label={`群 ${group.name}`}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-5">
        <Hash className="size-4 text-muted-foreground" aria-hidden />
        <h1 className="font-semibold">{group.name}</h1>
        {group.kind === "main" && <span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">主群</span>}
        <span className="text-xs text-muted-foreground">{members.data ? `${members.data.length} 位成员` : ""}</span>
      </header>
      <div ref={scrollRef} onScroll={() => void onScroll()} className="min-h-0 flex-1 overflow-y-auto" data-testid="timeline" role="log" aria-live="polite" aria-label="消息列表">
        {timeline.isPending ? (
          <PageSkeleton className="p-5" rows={6} />
        ) : timeline.error ? (
          <div className="p-6">
            <ErrorState error={timeline.error} onRetry={() => void timeline.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <div className="grid h-full place-items-center">
            <EmptyState icon={MessagesSquare} title="还没有消息" body="打个招呼吧。@项目船长 可以让它帮你拆任务、总结讨论。" />
          </div>
        ) : (
          <>
            <div className="flex h-10 items-center justify-center text-xs text-muted-foreground">
              {loadingOlder ? (
                <Loader2 className="size-4 animate-spin" />
              ) : timeline.data.hasMoreBefore ? (
                <button type="button" className="hover:text-foreground" onClick={() => void onScroll()}>
                  加载更早的消息
                </button>
              ) : (
                <span>— 这是 #{group.name} 的开始 —</span>
              )}
            </div>
            <div style={{ height: virt.getTotalSize(), position: "relative" }}>
              {virt.getVirtualItems().map((vi) => {
                const r = rows[vi.index]!;
                return (
                  <div key={vi.key} data-index={vi.index} ref={virt.measureElement} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}>
                    {r.type === "date" ? (
                      <div className="flex items-center gap-3 px-5 py-2 text-[11px] font-medium text-muted-foreground">
                        <span className="h-px flex-1 bg-border" /> {r.label} <span className="h-px flex-1 bg-border" />
                      </div>
                    ) : r.type === "unread" ? (
                      <div className="flex items-center gap-3 px-5 py-1 text-[11px] font-semibold text-danger" data-testid="unread-divider">
                        <span className="h-px flex-1 bg-danger/50" /> 新消息 <span className="h-px flex-1 bg-danger/50" />
                      </div>
                    ) : (
                      <MessageItem
                        m={r.m}
                        compact={r.compact}
                        highlight={Boolean(timeline.data.highlight) && r.m.seq === focusSeq}
                        meId={meId}
                        canModerate={canModerate}
                        canDecide={canDecide}
                        mentionNames={mentionNames}
                        projectKey={projectKey}
                        actions={actions}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            <div className="h-3" />
          </>
        )}
      </div>
      {newBelow > 0 && !atBottom && (
        <button
          type="button"
          onClick={() => virt.scrollToIndex(rows.length - 1, { align: "end" })}
          className="absolute bottom-28 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow-md"
        >
          <ArrowDown className="size-3.5" /> {newBelow} 条新消息
        </button>
      )}
      {taskFrom && (
        <CreateTaskDialog
          projectId={projectId}
          open
          onClose={() => setTaskFrom(null)}
          seed={{
            title: taskFrom.body
              .split("\n")[0]!
              .replace(/@\S+\s*/g, "")
              .slice(0, 80),
            description: taskFrom.body,
            groupId,
            sourceMessageIds: [taskFrom.id],
          }}
        />
      )}
      <Composer
        key={groupId}
        groupId={groupId}
        members={memberLite}
        disabledReason={readOnlyReason}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onSend={(b, a, r) => void send(b, a, r)}
      />
      <EditDialog key={`e-${editing?.id ?? ""}`} m={editing} onClose={() => setEditing(null)} groupId={groupId} />
      <DeleteDialog key={`d-${deleting?.id ?? ""}`} m={deleting} onClose={() => setDeleting(null)} groupId={groupId} />
      <ThreadDialog
        key={`t-${threadOf?.id ?? ""}`}
        m={threadOf}
        onClose={() => setThreadOf(null)}
        groupId={groupId}
        onCreated={(id) => void navigate({ to: "/projects/$projectId/chat", params: { projectId }, search: { g: groupId, t: id } })}
      />
    </section>
  );
}

function EditDialog({ m, onClose, groupId }: { m: Msg | null; onClose(): void; groupId: string }) {
  const [body, setBody] = useState(m?.body ?? "");
  return (
    <Dialog open={Boolean(m)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑消息</DialogTitle>
        </DialogHeader>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} aria-label="消息内容" />
        <p className="text-xs text-muted-foreground">发送后 15 分钟内可编辑；所有版本都会保留以备审计。</p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!body.trim() || body === m?.body}
            onClick={async () => {
              try {
                await unwrap(api.api.v1.messages({ id: m!.id }).patch({ body }));
                await refreshOne(groupId, m!.seq);
                onClose();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "编辑失败");
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

function DeleteDialog({ m, onClose, groupId }: { m: Msg | null; onClose(): void; groupId: string }) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open={Boolean(m)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除这条消息？</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">消息会显示为「原消息已删除」，原文保留在审计记录中。</p>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="删除原因（必填）" aria-label="删除原因" />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={!reason.trim()}
            onClick={async () => {
              try {
                await unwrap(api.api.v1.messages({ id: m!.id }).delete({ reason }));
                await refreshOne(groupId, m!.seq);
                onClose();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "删除失败");
              }
            }}
          >
            删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ThreadDialog({ m, onClose, groupId, onCreated }: { m: Msg | null; onClose(): void; groupId: string; onCreated(id: string): void }) {
  const [title, setTitle] = useState(m ? m.body.replace(/\s+/g, " ").slice(0, 40) : "");
  return (
    <Dialog open={Boolean(m)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>就这条消息开线程</DialogTitle>
        </DialogHeader>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="线程标题" aria-label="线程标题" maxLength={120} />
        <DialogFooter>
          <Button
            disabled={!title.trim()}
            onClick={async () => {
              try {
                const r = await unwrap(api.api.v1.groups({ id: groupId }).threads.post({ title: title.trim(), rootMessageId: m!.id }));
                await queryClient.invalidateQueries({ queryKey: qk.threads(groupId) });
                onClose();
                onCreated(r.id);
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "创建失败");
              }
            }}
          >
            创建线程
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RightColumn({ groupId, threadId, projectId }: { groupId: string; threadId?: string; projectId: string }) {
  const members = useGroupMembers(groupId);
  const navigate = useNavigate();
  const [tab, setTab] = useState(threadId ? "thread" : "summary");
  const humans = (members.data ?? []).filter((m) => m.kind !== "agent");
  const agents = (members.data ?? []).filter((m) => m.kind === "agent");
  return (
    <aside className="hidden min-h-0 flex-col border-l bg-sidebar/30 xl:flex" aria-label="群信息">
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="m-2 grid w-auto grid-cols-4">
          {threadId ? <TabsTrigger value="thread">线程</TabsTrigger> : <TabsTrigger value="summary">摘要</TabsTrigger>}
          <TabsTrigger value="decisions">决策</TabsTrigger>
          <TabsTrigger value="tasks">任务</TabsTrigger>
          <TabsTrigger value="members">成员</TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <TabsContent value="summary">
            <EmptyState title="暂无摘要" body="讨论积累到一定量后，项目船长会在这里维护本群摘要（可手动 /summary 触发）。" />
          </TabsContent>
          <TabsContent value="thread">
            {threadId && <ThreadPanel groupId={groupId} threadId={threadId} onClose={() => void navigate({ to: "/projects/$projectId/chat", params: { projectId }, search: { g: groupId } })} />}
          </TabsContent>
          <TabsContent value="decisions">
            <EmptyState title="暂无决策" body="被确认的决策会沉淀到这里，并同步到知识库。" />
          </TabsContent>
          <TabsContent value="tasks">
            <GroupTasks projectId={projectId} groupId={groupId} />
          </TabsContent>
          <TabsContent value="members" className="space-y-4">
            {members.isPending ? (
              <PageSkeleton rows={4} />
            ) : (
              <>
                <MemberList title={`成员 · ${humans.length}`} list={humans} onPick={mention} />
                <MemberList title={`Agent · ${agents.length}`} list={agents} onPick={mention} />
              </>
            )}
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}

const mention = (name: string) => window.dispatchEvent(new CustomEvent("ap:insert-mention", { detail: name }));

function MemberList({
  title,
  list,
  onPick,
}: {
  title: string;
  list: { principalId: string; name: string; kind: string; role: string; agentRole: string | null; active: boolean }[];
  onPick(name: string): void;
}) {
  return (
    <div>
      <p className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
      <ul className="space-y-0.5">
        {list.map((m) => (
          <li key={m.principalId}>
            <button type="button" onClick={() => onPick(m.name)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted" title={`点击 @${m.name}`}>
              <PrincipalAvatar name={m.name} kind={m.kind} size="sm" />
              <span className={cn("truncate", !m.active && "text-muted-foreground line-through")}>{m.name}</span>
              <span className="ml-auto text-[11px] text-muted-foreground">{m.agentRole ? AGENT_ROLE_LABEL[m.agentRole] : m.role === "viewer" ? "只读" : ""}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ThreadPanel({ groupId, threadId, onClose }: { groupId: string; threadId: string; onClose(): void }) {
  const q = useQuery({ queryKey: ["thread", threadId], queryFn: () => unwrap(api.api.v1.groups({ id: groupId }).messages.get({ query: { threadId, limit: 200 } })) });
  const [text, setText] = useState("");
  const { refetch } = q;
  useEffect(() => {
    const off = realtime.onFrame((f) => {
      if (f.type === "event" && f.topic === `group:${groupId}` && f.event.type.startsWith("message.")) void refetch();
    });
    return () => void off();
  }, [groupId, refetch]);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">线程内的消息也会出现在群时间线中。</p>
        <Button variant="ghost" size="icon" className="size-6" onClick={onClose} aria-label="关闭线程">
          <X className="size-3.5" />
        </Button>
      </div>
      {q.isPending ? (
        <PageSkeleton rows={3} />
      ) : (
        <ul className="space-y-2">
          {q.data?.items.map((m) => (
            <li key={m.id} className="rounded-md border bg-card px-2.5 py-1.5 text-sm">
              <p className="text-[11px] text-muted-foreground">
                {m.author.name} · #{m.seq}
              </p>
              <p className="whitespace-pre-wrap">{m.body}</p>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-1.5">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="回复线程" aria-label="回复线程" className="h-8" />
        <Button
          size="sm"
          className="h-8"
          disabled={!text.trim()}
          onClick={async () => {
            try {
              await unwrap(api.api.v1.groups({ id: groupId }).messages.post({ body: text.trim(), threadId }, { headers: { "idempotency-key": newIdempotencyKey() } }));
              setText("");
              void q.refetch();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "发送失败");
            }
          }}
        >
          发送
        </Button>
      </div>
    </div>
  );
}

function GroupTasks({ projectId, groupId }: { projectId: string; groupId: string }) {
  const q = useTasks(projectId, { groupId });
  if (q.isPending) return <PageSkeleton rows={3} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.data.length === 0) return <EmptyState title="暂无关联任务" body="从本群提议并确认的任务会显示在这里。" />;
  return (
    <ul className="space-y-1.5" data-testid="group-tasks">
      {q.data.map((t) => (
        <li key={t.id}>
          <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId, taskId: t.id }} className="block rounded-lg border bg-card px-2.5 py-2 hover:border-ring/50">
            <span className="flex items-center gap-1.5">
              <span className="font-mono text-[11px] text-muted-foreground">{t.ref}</span>
              <StatusPill status={t.status} className="ml-auto" />
            </span>
            <span className="mt-0.5 line-clamp-2 block text-sm">{t.title}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
