import { Elysia, t } from "elysia";
import { base, idempotent } from "../http";
import { Ok } from "../schemas";
import type { Services } from "../services";

export const MessageSchema = t.Object({
  id: t.String(),
  groupId: t.String(),
  threadId: t.Union([t.String(), t.Null()]),
  seq: t.Number(),
  author: t.Object({ principalId: t.String(), name: t.String(), kind: t.String(), currentName: t.String() }),
  kind: t.String(),
  body: t.String(),
  blocks: t.Union([t.Record(t.String(), t.Unknown()), t.Null()]),
  mentions: t.Array(t.String()),
  replyTo: t.Union([t.Object({ id: t.String(), seq: t.Number(), authorLabel: t.String(), excerpt: t.String() }), t.Null()]),
  attachments: t.Array(t.Object({ id: t.String(), name: t.String(), size: t.Number(), mime: t.String(), scanStatus: t.String() })),
  source: t.String(),
  editedAt: t.Union([t.String(), t.Null()]),
  deleted: t.Boolean(),
  correctedAt: t.Union([t.String(), t.Null()]),
  createdAt: t.String(),
});
const Group = t.Object({
  id: t.String(),
  name: t.String(),
  kind: t.String(),
  status: t.String(),
  member: t.Boolean(),
  unread: t.Number(),
  mentioned: t.Boolean(),
  lastReadSeq: t.Number(),
  latestSeq: t.Number(),
});
const P = t.Object({ id: t.String() });

export const chatRoutes = (s: Services) =>
  new Elysia({ prefix: "/api/v1" })
    .use(base(s))
    .get("/projects/:id/groups", { params: P, response: t.Array(Group) }, async ({ auth, params }) => s.chat.listGroups(await auth(), params.id))
    .post("/projects/:id/groups", { params: P, body: t.Object({ name: t.String({ minLength: 1, maxLength: 60 }) }), response: t.Object({ id: t.String() }) }, async ({ auth, params, body }) =>
      s.chat.createGroup(await auth(), params.id, body.name),
    )
    .get(
      "/projects/:id/search",
      {
        params: P,
        query: t.Object({
          q: t.String({ minLength: 1, maxLength: 200 }),
          groupId: t.Optional(t.String()),
          author: t.Optional(t.String()),
          from: t.Optional(t.String()),
          to: t.Optional(t.String()),
          limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
        }),
        response: t.Array(
          t.Object({ messageId: t.String(), groupId: t.String(), groupName: t.String(), seq: t.Number(), authorLabel: t.String(), snippet: t.String(), rank: t.Number(), createdAt: t.String() }),
        ),
      },
      async ({ auth, params, query }) => s.chat.search(await auth(), params.id, query),
    )
    .post("/groups/:id/archive", { params: P, response: Ok }, async ({ auth, params }) => s.chat.archiveGroup(await auth(), params.id))
    .get(
      "/groups/:id/members",
      { params: P, response: t.Array(t.Object({ principalId: t.String(), name: t.String(), kind: t.String(), role: t.String(), agentRole: t.Union([t.String(), t.Null()]), active: t.Boolean() })) },
      async ({ auth, params }) => s.chat.groupMembers(await auth(), params.id),
    )
    .get(
      "/groups/:id/messages",
      {
        params: P,
        query: t.Object({
          afterSeq: t.Optional(t.Numeric()),
          beforeSeq: t.Optional(t.Numeric()),
          aroundSeq: t.Optional(t.Numeric()),
          limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
          threadId: t.Optional(t.String()),
        }),
        response: t.Object({ items: t.Array(MessageSchema), hasMoreBefore: t.Boolean(), latestSeq: t.Number(), lastReadSeq: t.Number() }),
      },
      async ({ auth, params, query }) => s.chat.timeline(await auth(), params.id, query),
    )
    .post(
      "/groups/:id/messages",
      {
        params: P,
        body: t.Object({
          body: t.String({ maxLength: 20_000 }),
          threadId: t.Optional(t.Union([t.String(), t.Null()])),
          replyToId: t.Optional(t.Union([t.String(), t.Null()])),
          attachmentIds: t.Optional(t.Array(t.String(), { maxItems: 10 })),
        }),
        response: t.Object({ message: MessageSchema, warnings: t.Array(t.String()) }),
      },
      async ({ auth, params, body, idemKey }) => {
        const ctx = await auth();
        return idempotent(s, ctx, idemKey, { g: params.id, ...body }, () => s.chat.send(ctx, { groupId: params.id, ...body }));
      },
    )
    .post("/groups/:id/read", { params: P, body: t.Object({ seq: t.Integer({ minimum: 0 }) }), response: Ok }, async ({ auth, params, body }) => s.chat.markRead(await auth(), params.id, body.seq))
    .get(
      "/groups/:id/threads",
      {
        params: P,
        response: t.Array(t.Object({ id: t.String(), title: t.String(), status: t.String(), rootMessageId: t.Union([t.String(), t.Null()]), messageCount: t.Number(), lastAt: t.String() })),
      },
      async ({ auth, params }) => s.chat.listThreads(await auth(), params.id),
    )
    .post(
      "/groups/:id/threads",
      { params: P, body: t.Object({ title: t.String({ minLength: 1, maxLength: 120 }), rootMessageId: t.Optional(t.String()) }), response: t.Object({ id: t.String() }) },
      async ({ auth, params, body }) => s.chat.createThread(await auth(), params.id, body),
    )
    .post(
      "/groups/:id/attachments",
      { params: P, body: t.Object({ file: t.File() }), response: t.Object({ id: t.String(), name: t.String(), size: t.Number(), mime: t.String(), sha256: t.String() }) },
      async ({ auth, params, body }) => s.chat.upload(await auth(), params.id, body.file),
    )
    .patch("/messages/:id", { params: P, body: t.Object({ body: t.String({ minLength: 1, maxLength: 20_000 }) }), response: Ok }, async ({ auth, params, body }) =>
      s.chat.edit(await auth(), params.id, body.body),
    )
    .delete("/messages/:id", { params: P, body: t.Object({ reason: t.String({ minLength: 1, maxLength: 500 }) }), response: Ok }, async ({ auth, params, body }) =>
      s.chat.remove(await auth(), params.id, body.reason),
    )
    .post("/messages/:id/corrected", { params: P, response: Ok }, async ({ auth, params }) => s.chat.markCorrected(await auth(), params.id))
    .get("/messages/:id/versions", { params: P, response: t.Array(t.Object({ version: t.Number(), body: t.String(), editedBy: t.String(), createdAt: t.String() })) }, async ({ auth, params }) =>
      s.chat.versions(await auth(), params.id),
    )
    .get("/attachments/:id/link", { params: P, response: t.Object({ url: t.String(), expiresAt: t.String() }) }, async ({ auth, params }) => s.chat.attachmentLink(await auth(), params.id))
    .get("/attachments/:id/raw", { params: P, query: t.Object({ exp: t.Numeric(), sig: t.String() }) }, async ({ params, query }) => {
      const a = await s.chat.attachmentRaw(params.id, query.exp, query.sig);
      return new Response(new Uint8Array(a.data), {
        headers: {
          "content-type": a.inline ? a.mime : "application/octet-stream",
          "content-disposition": `${a.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
          "cache-control": "private, max-age=300",
          "x-content-type-options": "nosniff",
        },
      });
    });
