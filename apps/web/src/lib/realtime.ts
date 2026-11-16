import type { WsServerFrame } from "@ap/shared";
import { useSyncExternalStore } from "react";
import { session } from "./session";

type Status = "idle" | "connecting" | "open" | "reconnecting";
type Handler = (f: Extract<WsServerFrame, { type: "event" | "stream" | "resync" }>) => void;

/**
 * Realtime client (§10.6): first-frame auth, topic subscriptions with lastSeq replay,
 * exponential reconnect, and a connection status store for the "断线" banner (§13.4).
 */
class Realtime {
  private ws: WebSocket | null = null;
  private status: Status = "idle";
  private listeners = new Set<() => void>();
  private topics = new Map<string, number>();
  private handlers = new Set<Handler>();
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wasOpen = false;
  restoredAt = 0;

  getStatus = () => this.status;
  subscribeStatus = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  private setStatus(s: Status) {
    this.status = s;
    for (const l of this.listeners) l();
  }

  connect() {
    const token = session.get();
    if (!token || this.ws) return;
    this.setStatus(this.wasOpen ? "reconnecting" : "connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
    ws.onmessage = (m) => {
      const f = JSON.parse(String(m.data)) as WsServerFrame;
      if (f.type === "ready") {
        if (this.wasOpen) this.restoredAt = Date.now();
        this.wasOpen = true;
        this.attempt = 0;
        this.setStatus("open");
        for (const [topic, lastSeq] of this.topics) ws.send(JSON.stringify({ type: "subscribe", topic, ...(lastSeq > 0 ? { lastSeq } : {}) }));
        return;
      }
      if (f.type === "event") this.topics.set(f.topic, Math.max(this.topics.get(f.topic) ?? 0, f.seq));
      if (f.type === "event" || f.type === "stream" || f.type === "resync") for (const h of this.handlers) h(f);
    };
    ws.onclose = (e) => {
      this.ws = null;
      if (e.code === 4001 || !session.get()) return this.setStatus("idle");
      this.setStatus("reconnecting");
      const delay = Math.min(30_000, 500 * 2 ** this.attempt++) * (0.8 + Math.random() * 0.4);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  disconnect() {
    clearTimeout(this.timer);
    this.wasOpen = false;
    this.ws?.close(1000);
    this.ws = null;
    this.setStatus("idle");
  }

  subscribe(topic: string) {
    if (!this.topics.has(topic)) this.topics.set(topic, 0);
    if (this.status === "open") this.ws?.send(JSON.stringify({ type: "subscribe", topic }));
    return () => {
      this.topics.delete(topic);
      if (this.status === "open") this.ws?.send(JSON.stringify({ type: "unsubscribe", topic }));
    };
  }

  onFrame(h: Handler) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
}

export const realtime = new Realtime();
export const useConnectionStatus = () => useSyncExternalStore(realtime.subscribeStatus, realtime.getStatus);
