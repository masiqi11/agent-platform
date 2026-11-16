import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "./api";
import { qk } from "./query";

export const meQuery = { queryKey: qk.me, queryFn: () => unwrap(api.api.v1.me.get()) };
export function useMe() {
  return useQuery(meQuery);
}
export type Me = Awaited<ReturnType<typeof meQuery.queryFn>>;
export const isAdmin = (me?: Me) => me?.tenantRole === "owner" || me?.tenantRole === "admin";
export const canAudit = (me?: Me) => isAdmin(me) || me?.tenantRole === "auditor";
