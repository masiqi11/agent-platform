import { api, unwrap } from "@/lib/api";
import { qk, queryClient } from "@/lib/query";

export type Msg = Awaited<ReturnType<typeof fetchPage>>["items"][number] & { pending?: "sending" | "failed"; clientId?: string };
export interface TimelineState {
  items: Msg[];
  hasMoreBefore: boolean;
  latestSeq: number;
  /** lastReadSeq at the time the timeline was opened (anchors the "新消息" divider). */
  readAnchor: number;
  /** Seq to highlight & scroll to (search jump / first unread). */
  focusSeq: number | null;
  /** Only explicit jumps (search / links) flash the target; opening at first-unread does not. */
  highlight: boolean;
}

export function fetchPage(groupId: string, q: { afterSeq?: number; beforeSeq?: number; aroundSeq?: number; limit?: number }) {
  return unwrap(api.api.v1.groups({ id: groupId }).messages.get({ query: q }));
}

/** Initial window: explicit jump target → around it; unread → around first unread; else latest 50. */
export async function loadInitial(groupId: string, jumpSeq?: number): Promise<TimelineState> {
  const head = await fetchPage(groupId, { limit: 50 });
  let page = head;
  let focus: number | null = null;
  if (jumpSeq) {
    page = await fetchPage(groupId, { aroundSeq: jumpSeq, limit: 60 });
    focus = jumpSeq;
  } else if (head.lastReadSeq > 0 && head.lastReadSeq < head.latestSeq && !head.items.some((m) => m.seq === head.lastReadSeq + 1)) {
    page = await fetchPage(groupId, { aroundSeq: head.lastReadSeq + 1, limit: 60 });
    focus = head.lastReadSeq + 1;
  } else if (head.lastReadSeq < head.latestSeq && head.lastReadSeq > 0) focus = head.lastReadSeq + 1;
  return { items: page.items, hasMoreBefore: page.hasMoreBefore, latestSeq: head.latestSeq, readAnchor: head.lastReadSeq, focusSeq: focus, highlight: Boolean(jumpSeq) };
}

function merge(existing: Msg[], incoming: Msg[]): Msg[] {
  const bySeq = new Map<number, Msg>();
  for (const m of existing) if (!m.pending) bySeq.set(m.seq, m);
  for (const m of incoming) bySeq.set(m.seq, m);
  const pend = existing.filter((m) => m.pending && !incoming.some((i) => i.id === m.id));
  return [...[...bySeq.values()].toSorted((a, b) => a.seq - b.seq), ...pend];
}

export function patch(groupId: string, fn: (s: TimelineState) => TimelineState) {
  queryClient.setQueryData<TimelineState>(qk.timeline(groupId), (s) => (s ? fn(s) : s));
}

export async function loadOlder(groupId: string) {
  const s = queryClient.getQueryData<TimelineState>(qk.timeline(groupId));
  const first = s?.items.find((m) => !m.pending);
  if (!s || !first || !s.hasMoreBefore) return 0;
  const page = await fetchPage(groupId, { beforeSeq: first.seq, limit: 50 });
  patch(groupId, (st) => ({ ...st, items: merge(st.items, page.items), hasMoreBefore: page.hasMoreBefore }));
  return page.items.length;
}

/** Pulls everything after our newest confirmed seq (used on WS events and on reconnect). */
export async function catchUp(groupId: string) {
  const s = queryClient.getQueryData<TimelineState>(qk.timeline(groupId));
  if (!s) return;
  const confirmed = s.items.filter((m) => !m.pending);
  const last = confirmed.length ? confirmed[confirmed.length - 1]!.seq : 0;
  let after = last;
  for (let i = 0; i < 10; i++) {
    const page = await fetchPage(groupId, { afterSeq: after, limit: 200 });
    if (page.items.length === 0) {
      patch(groupId, (st) => ({ ...st, latestSeq: page.latestSeq }));
      break;
    }
    patch(groupId, (st) => ({ ...st, items: merge(st.items, page.items), latestSeq: page.latestSeq }));
    after = page.items[page.items.length - 1]!.seq;
    if (page.items.length < 200) break;
  }
}

/** Re-fetches one message (edit / delete events). */
export async function refreshOne(groupId: string, seq: number) {
  const page = await fetchPage(groupId, { afterSeq: seq - 1, limit: 1 });
  if (page.items[0]?.seq === seq) patch(groupId, (st) => ({ ...st, items: st.items.map((m) => (m.seq === seq && !m.pending ? page.items[0]! : m)) }));
}

export function upsertConfirmed(groupId: string, m: Msg, clientId?: string) {
  patch(groupId, (st) => ({ ...st, items: merge(clientId ? st.items.filter((x) => x.clientId !== clientId) : st.items, [m]), latestSeq: Math.max(st.latestSeq, m.seq) }));
}
