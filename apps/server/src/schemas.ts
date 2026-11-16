import { t } from "elysia";

/** Shared TypeBox response pieces. */
export const Ok = t.Object({ ok: t.Boolean() });
export const Id = t.Object({ id: t.String() });
export const IdParam = t.Object({ id: t.String() });
export const Nullable = <T extends Parameters<typeof t.Union>[0][number]>(s: T) => t.Union([s, t.Null()]);
export const Json = t.Record(t.String(), t.Unknown());
export const Page = <T extends Parameters<typeof t.Array>[0]>(item: T) => t.Object({ items: t.Array(item), nextCursor: t.Union([t.String(), t.Null()]) });
