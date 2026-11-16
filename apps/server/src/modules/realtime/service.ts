import type { WsServerFrame } from "@ap/shared";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import type { Database } from "../../db";
import { chatGroup, event, groupMember, task } from "../../db/schema";
import type { Ctx } from "../../core/context";
import { log } from "../../core/logger";
import type { Identity } from "../identity/service";

const RING_SIZE = 512;
const MAX_QUEUE = 1000;

export interface Conn {
  id: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  buffered(): number;
  ctx?: Ctx;
  topics: Set<string>;
}

interface Ring {
  items: Array<{ seq: number; frame: string }>;
}

/**
 * WebSocket hub (§10.6): first-frame auth, per-topic permission checks, 512-entry ring buffer,
 * resync when the buffer cannot cover the gap, cross-instance fan-out via LISTEN/NOTIFY.
 */
export function createRealtime(d: { db: Database; identity: Identity }) {
  const conns = new Map<string, Conn>();
  const rings = new Map<string, Ring>();
  let startSeq = 0;
  let listener: pg.Client | null = null;
  let streamChain: Promise<unknown> = Promise.resolve();

  async function canSubscribe(ctx: Ctx, topic: string): Promise<boolean> {
    const [kind, id] = topic.split(":");
    if (!id) return false;
    try {
      if (kind === "inbox") return id === ctx.actor.principalId;
      if (kind === "project") {
        await d.identity.projectInTenant(ctx, id);
        return (await d.identity.check(ctx, "project.view", { projectId: id })).allowed;
      }
      if (kind === "group") {
        const [g] = await d.db.root
          .select()
          .from(chatGroup)
          .where(and(eq(chatGroup.id, id), eq(chatGroup.tenantId, ctx.tenantId)));
        if (!g) return false;
        const [m] = await d.db.root
          .select()
          .from(groupMember)
          .where(and(eq(groupMember.groupId, id), eq(groupMember.principalId, ctx.actor.principalId)));
        return Boolean(m) || (await d.identity.check(ctx, "project.view", { projectId: g.projectId })).allowed;
      }
      if (kind === "task") {
        const [t] = await d.db.root
          .select()
          .from(task)
          .where(and(eq(task.id, id), eq(task.tenantId, ctx.tenantId)));
        return Boolean(t) && (await d.identity.check(ctx, "project.view", { projectId: t!.projectId })).allowed;
      }
    } catch {
      return false;
    }
    return false;
  }

  function sendTo(c: Conn, frame: WsServerFrame | string) {
    // Backpressure: a slow client is disconnected and must reconnect + resync.
    if (c.buffered() > MAX_QUEUE * 1024) {
      c.close(4008, "backpressure");
      conns.delete(c.id);
      return;
    }
    c.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  function remember(topic: string, seq: number, frame: string) {
    let r = rings.get(topic);
    if (!r) rings.set(topic, (r = { items: [] }));
    r.items.push({ seq, frame });
    if (r.items.length > RING_SIZE) r.items.shift();
  }

  function deliver(topic: string, seq: number, frame: string) {
    remember(topic, seq, frame);
    for (const c of conns.values()) if (c.topics.has(topic)) sendTo(c, frame);
  }

  function topicsFor(e: typeof event.$inferSelect): string[] {
    const p = e.payload as Record<string, unknown>;
    const out = new Set<string>();
    if (typeof p.projectId === "string") out.add(`project:${p.projectId}`);
    if (typeof p.groupId === "string") out.add(`group:${p.groupId}`);
    if (typeof p.taskId === "string") out.add(`task:${p.taskId}`);
    if (e.aggregateType === "task") out.add(`task:${e.aggregateId}`);
    if (e.aggregateType === "project") out.add(`project:${e.aggregateId}`);
    if (Array.isArray(p.inboxPrincipalIds)) for (const id of p.inboxPrincipalIds) out.add(`inbox:${id}`);
    return [...out];
  }

  async function onEventSeq(seq: number) {
    const [e] = await d.db.root.select().from(event).where(eq(event.seq, seq));
    if (!e) return;
    for (const topic of topicsFor(e)) {
      const frame: WsServerFrame = { type: "event", topic, seq: e.seq, event: { type: e.type as never, aggregateType: e.aggregateType, aggregateId: e.aggregateId, payload: e.payload } };
      deliver(topic, e.seq, JSON.stringify(frame));
    }
    // Membership changes revoke subscriptions immediately (§10.6).
    if (e.type === "member.changed") await recheckAll();
  }

  async function recheckAll() {
    for (const c of conns.values()) {
      if (!c.ctx) continue;
      for (const t of Array.from(c.topics)) {
        if (!(await canSubscribe(c.ctx, t))) {
          c.topics.delete(t);
          sendTo(c, { type: "unsubscribed", topic: t, reason: "permission_changed" });
        }
      }
    }
  }

  return {
    conns,
    async start(url: string) {
      listener = new pg.Client({ connectionString: url });
      listener.on("error", (err) => log.warn("realtime.listener_error", { err: err.message }));
      await listener.connect();
      const r = await listener.query<{ m: string }>("select coalesce(max(seq),0)::text as m from event");
      startSeq = Number(r.rows[0]?.m ?? 0);
      listener.on("notification", (n) => {
        if (n.channel === "ap_events") void onEventSeq(Number(n.payload)).catch((e) => log.warn("realtime.dispatch_failed", { err: (e as Error).message }));
        if (n.channel === "ap_stream" && n.payload) {
          try {
            const f = JSON.parse(n.payload) as Extract<WsServerFrame, { type: "stream" }>;
            for (const c of conns.values()) if (c.topics.has(f.topic)) sendTo(c, n.payload);
          } catch {
            /* ignore malformed */
          }
        }
      });
      await listener.query("listen ap_events");
      await listener.query("listen ap_stream");
    },
    async stop() {
      for (const c of conns.values()) c.close(1001, "server shutting down");
      conns.clear();
      await listener?.end().catch(() => {});
    },
    /** Streaming deltas (LLM-12) — experience only, not events. */
    async publishStream(topic: string, messageId: string, delta: string, done = false) {
      const payload = JSON.stringify({ type: "stream", topic, messageId, delta: delta.slice(0, 3000), done } satisfies WsServerFrame);
      // Deltas arrive faster than NOTIFY round-trips (onDelta is fire-and-forget); one query at a time on
      // the shared LISTEN client keeps order and avoids overlapping queries on a single pg client.
      const next = streamChain.then(() => listener?.query("select pg_notify('ap_stream', $1)", [payload])).catch(() => undefined);
      streamChain = next;
      await next;
    },
    open(c: Conn) {
      conns.set(c.id, c);
    },
    close(id: string) {
      conns.delete(id);
    },
    async message(c: Conn, raw: unknown, authenticate: (token: string) => Promise<Ctx>) {
      const f = (typeof raw === "string" ? JSON.parse(raw) : raw) as { type?: string; token?: string; topic?: string; lastSeq?: number };
      if (f.type === "ping") return sendTo(c, { type: "pong" });
      if (!c.ctx) {
        if (f.type !== "auth" || !f.token) {
          sendTo(c, { type: "error", code: "unauthenticated", message: "首帧必须是 auth" });
          return c.close(4001, "unauthenticated");
        }
        try {
          c.ctx = await authenticate(f.token);
          return sendTo(c, { type: "ready", principalId: c.ctx.actor.principalId });
        } catch {
          sendTo(c, { type: "error", code: "unauthenticated", message: "鉴权失败" });
          return c.close(4001, "unauthenticated");
        }
      }
      if (f.type === "subscribe" && f.topic) {
        if (!(await canSubscribe(c.ctx, f.topic))) return sendTo(c, { type: "error", code: "forbidden", message: `无权订阅 ${f.topic}` });
        c.topics.add(f.topic);
        sendTo(c, { type: "subscribed", topic: f.topic });
        if (typeof f.lastSeq === "number") {
          const ring = rings.get(f.topic)?.items ?? [];
          const covered = f.lastSeq >= startSeq && (ring.length < RING_SIZE || (ring[0] && ring[0].seq <= f.lastSeq + 1));
          if (!covered) return sendTo(c, { type: "resync", topic: f.topic });
          for (const it of ring) if (it.seq > f.lastSeq) sendTo(c, it.frame);
        }
        return;
      }
      if (f.type === "unsubscribe" && f.topic) {
        c.topics.delete(f.topic);
        return sendTo(c, { type: "unsubscribed", topic: f.topic });
      }
    },
    /** Test hook: feed an event seq as if NOTIFY arrived. */
    onEventSeq,
  };
}
export type Realtime = ReturnType<typeof createRealtime>;
