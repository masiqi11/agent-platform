import { Elysia, t } from "elysia";
import { base } from "../http";
import { Ok } from "../schemas";
import type { Services } from "../services";

const P = t.Object({ id: t.String() });
const Mode = t.Union([t.Literal("at_only"), t.Literal("passive")]);
const Settings = t.Object({
  quietHours: t.Optional(t.Union([t.Object({ start: t.String({ maxLength: 5 }), end: t.String({ maxLength: 5 }), tz: t.Optional(t.String({ maxLength: 64 })) }), t.Null()])),
  summaryMinIntervalMin: t.Optional(t.Number({ minimum: 0, maximum: 1440 })),
  mirrorHumans: t.Optional(t.Boolean()),
});
const Binding = t.Object({
  id: t.String(),
  provider: t.String(),
  providerLabel: t.String(),
  externalChatId: t.String(),
  chatTitle: t.Union([t.String(), t.Null()]),
  groupId: t.String(),
  groupName: t.Union([t.String(), t.Null()]),
  projectId: t.Union([t.String(), t.Null()]),
  mode: t.String(),
  status: t.String(),
  settings: t.Record(t.String(), t.Unknown()),
  invalidReason: t.Union([t.String(), t.Null()]),
  invalidatedAt: t.Union([t.String(), t.Null()]),
  createdAt: t.String(),
  deliveries: t.Optional(t.Record(t.String(), t.Number())),
  configured: t.Optional(t.Boolean()),
});

/** IM gateway (§10 "IM", §12.3): group bindings and identity mapping. Decisions stay in the Web. */
export const imRoutes = (s: Services) =>
  new Elysia({ prefix: "/api/v1" })
    .use(base(s))
    .get("/im/providers", { response: t.Array(t.Object({ provider: t.String(), label: t.String() })) }, async ({ auth }) => {
      await auth();
      return s.im.providers();
    })
    .get("/projects/:id/bindings", { params: P, response: t.Array(Binding) }, async ({ auth, params }) => s.im.listBindings(await auth(), params.id))
    .post(
      "/bindings",
      {
        body: t.Object({
          groupId: t.String(),
          provider: t.String({ maxLength: 32 }),
          externalChatId: t.String({ minLength: 1, maxLength: 200 }),
          chatTitle: t.Optional(t.String({ maxLength: 200 })),
          mode: t.Optional(Mode),
          settings: t.Optional(Settings),
        }),
        response: Binding,
      },
      async ({ auth, body }) => s.im.createBinding(await auth(), body),
    )
    .patch("/bindings/:id", { params: P, body: t.Object({ mode: t.Optional(Mode), settings: t.Optional(Settings) }), response: Binding }, async ({ auth, params, body }) =>
      s.im.updateBinding(await auth(), params.id, body),
    )
    .delete("/bindings/:id", { params: P, response: Ok }, async ({ auth, params }) => s.im.removeBinding(await auth(), params.id))
    // IM-补1 self-service: a one-time code the user DMs to the bot.
    .post(
      "/external-identities",
      { body: t.Object({ provider: t.String({ maxLength: 32 }) }), response: t.Object({ code: t.String(), expiresAt: t.String(), provider: t.String(), hint: t.String() }) },
      async ({ auth, body }) => s.im.createBindCode(await auth(), body.provider),
    )
    .get(
      "/me/external-identities",
      { response: t.Array(t.Object({ id: t.String(), provider: t.String(), providerLabel: t.String(), externalUserId: t.String(), createdAt: t.String() })) },
      async ({ auth }) => s.im.myIdentities(await auth()),
    )
    .delete("/external-identities/:id", { params: P, response: Ok }, async ({ auth, params }) => s.im.unmapIdentity(await auth(), params.id))
    .get(
      "/admin/external-identities",
      {
        query: t.Object({ provider: t.Optional(t.String({ maxLength: 32 })) }),
        response: t.Array(t.Object({ id: t.String(), provider: t.String(), externalUserId: t.String(), userId: t.String(), userName: t.String(), email: t.String(), createdAt: t.String() })),
      },
      async ({ auth, query }) => s.im.listIdentities(await auth(), query.provider),
    )
    .post(
      "/admin/external-identities",
      {
        body: t.Object({ provider: t.String({ maxLength: 32 }), items: t.Array(t.Object({ externalUserId: t.String({ minLength: 1, maxLength: 128 }), userId: t.String() }), { maxItems: 500 }) }),
        response: t.Object({ mapped: t.Number(), skipped: t.Array(t.Object({ externalUserId: t.String(), reason: t.String() })) }),
      },
      async ({ auth, body }) => s.im.mapIdentities(await auth(), body.provider, body.items),
    )
    // IM_MOCK (never in production): play the IM side — inject what a group member typed, read what
    // the bot sent. Admin only; used by the e2e suite and the demo.
    .post(
      "/dev/im/receive",
      {
        body: t.Object({
          kind: t.Optional(t.Union([t.Literal("message"), t.Literal("lifecycle")])),
          chatId: t.String({ maxLength: 200 }),
          chatTitle: t.Optional(t.String({ maxLength: 200 })),
          chatType: t.Optional(t.Union([t.Literal("group"), t.Literal("private")])),
          msgId: t.Optional(t.String({ maxLength: 200 })),
          senderId: t.Optional(t.String({ maxLength: 128 })),
          senderNick: t.Optional(t.String({ maxLength: 64 })),
          text: t.Optional(t.String({ maxLength: 20_000 })),
          atBot: t.Optional(t.Boolean()),
          event: t.Optional(t.Union([t.Literal("bot_removed"), t.Literal("chat_disbanded"), t.Literal("app_revoked")])),
        }),
        response: Ok,
      },
      async ({ auth, body, set }) => {
        const ctx = await auth();
        if (!s.imMock) {
          set.status = 404;
          return { ok: true as const };
        }
        await s.identity.require(ctx, "admin.system");
        if (body.kind === "lifecycle") await s.im.receive({ kind: "lifecycle", provider: "mock", chatId: body.chatId, event: body.event ?? "bot_removed" });
        else {
          const chatType = body.chatType ?? "group";
          const senderId = body.senderId ?? "mock-user";
          await s.im.receive({
            kind: "message",
            provider: "mock",
            msgId: body.msgId ?? `mock-${crypto.randomUUID()}`,
            chatId: body.chatId,
            chatType,
            chatTitle: body.chatTitle,
            senderId,
            senderNick: body.senderNick ?? "模拟成员",
            text: body.text ?? "",
            atBot: body.atBot ?? true,
            reply: { chatId: body.chatId, chatType, senderId },
          });
        }
        return { ok: true as const };
      },
    )
    .get(
      "/dev/im/sent",
      {
        response: t.Object({
          sent: t.Array(t.Object({ chatId: t.String(), title: t.String(), markdown: t.String() })),
          replies: t.Array(t.Object({ chatId: t.String(), senderId: t.String(), markdown: t.String() })),
        }),
      },
      async ({ auth, set }) => {
        const ctx = await auth();
        if (!s.imMock) {
          set.status = 404;
          return { sent: [], replies: [] };
        }
        await s.identity.require(ctx, "admin.system");
        return {
          sent: s.imMock.sent.map((x) => ({ chatId: x.chatId, title: x.msg.title, markdown: x.msg.markdown })),
          replies: s.imMock.replies.map((x) => ({ chatId: x.to.chatId, senderId: x.to.senderId, markdown: x.msg.markdown })),
        };
      },
    );
