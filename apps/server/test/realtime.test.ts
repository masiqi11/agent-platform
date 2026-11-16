import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestApp, type TestApp } from "./helpers";

let t: TestApp;
let server: { stop(): unknown; port?: number } | undefined;
let port = 0;
let ownerToken = "";
let owner: { principalId: string } = { principalId: "" };
let otherPrincipal = "";

beforeAll(async () => {
  t = await createTestApp("realtime");
  await t.s.realtime.start(t.url);
  const app = t.app.listen({ hostname: "127.0.0.1", port: 0 });
  server = (app as unknown as { server: { stop(): unknown; port: number } }).server;
  port = server!.port!;
  const r = await t.req("POST", "/api/v1/setup", { body: { tenantName: "RT", email: "o@rt.test", name: "O", password: "Correct-Horse-42" } });
  ownerToken = r.body.token;
  owner = (await t.req("GET", "/api/v1/me", { token: ownerToken })).body;
  const inv = await t.req("POST", "/api/v1/invitations", { token: ownerToken, body: { tenantRole: "member" } });
  const acc = await t.req("POST", `/api/v1/invitations/${inv.body.token}/accept`, { body: { email: "m@rt.test", name: "M", password: "Correct-Horse-42" } });
  otherPrincipal = (await t.req("GET", "/api/v1/me", { token: acc.body.token })).body.principalId;
});
afterAll(async () => {
  await server?.stop();
  await t?.close();
});

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: any[] = [];
  const waiters: Array<{ pred: (f: any) => boolean; res: (f: any) => void }> = [];
  ws.onmessage = (m) => {
    const f = JSON.parse(String(m.data));
    frames.push(f);
    for (const w of [...waiters]) if (w.pred(f)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.res(f);
    }
  };
  const closed = new Promise<number>((r) => (ws.onclose = (e) => r(e.code)));
  const open = new Promise<void>((r) => (ws.onopen = () => r()));
  return {
    ws,
    frames,
    open,
    closed,
    send: (f: unknown) => ws.send(JSON.stringify(f)),
    wait: (pred: (f: any) => boolean, ms = 5000) =>
      new Promise<any>((res, rej) => {
        const hit = frames.find(pred);
        if (hit) return res(hit);
        waiters.push({ pred, res });
        setTimeout(() => rej(new Error("timeout waiting for frame")), ms);
      }),
  };
}

describe("S1 realtime (§10.6)", () => {
  test("first frame must be auth, otherwise closed", async () => {
    const c = client();
    await c.open;
    c.send({ type: "subscribe", topic: "inbox:x" });
    expect(await c.closed).toBe(4001);
  });

  test("bad token is rejected", async () => {
    const c = client();
    await c.open;
    c.send({ type: "auth", token: "nope" });
    expect(await c.closed).toBe(4001);
  });

  test("auth → ready; cannot subscribe to someone else's inbox; receives own events via NOTIFY", async () => {
    const c = client();
    await c.open;
    c.send({ type: "auth", token: ownerToken });
    await c.wait((f) => f.type === "ready");
    c.send({ type: "subscribe", topic: `inbox:${otherPrincipal}` });
    expect((await c.wait((f) => f.type === "error")).code).toBe("forbidden");
    c.send({ type: "subscribe", topic: `inbox:${owner.principalId}` });
    await c.wait((f) => f.type === "subscribed");
    const me = (await t.req("GET", "/api/v1/me", { token: ownerToken })).body;
    const ctx = await t.s.identity.systemCtx(me.tenant.id);
    await t.s.events.emit(ctx, { type: "question.asked", aggregateType: "question", aggregateId: "q_1", payload: { inboxPrincipalIds: [owner.principalId] } });
    const ev = await c.wait((f) => f.type === "event");
    expect(ev.topic).toBe(`inbox:${owner.principalId}`);
    expect(ev.event.aggregateId).toBe("q_1");
    // Reconnect with lastSeq inside the ring → replay; with a seq older than server start → resync.
    const c2 = client();
    await c2.open;
    c2.send({ type: "auth", token: ownerToken });
    await c2.wait((f) => f.type === "ready");
    c2.send({ type: "subscribe", topic: `inbox:${owner.principalId}`, lastSeq: ev.seq - 1 });
    expect((await c2.wait((f) => f.type === "event")).seq).toBe(ev.seq);
    c2.send({ type: "subscribe", topic: `inbox:${owner.principalId}`, lastSeq: -5 });
    await c2.wait((f) => f.type === "resync");
    c.ws.close();
    c2.ws.close();
  });

  test("ping/pong", async () => {
    const c = client();
    await c.open;
    c.send({ type: "ping" });
    await c.wait((f) => f.type === "pong");
    c.ws.close();
  });
});
