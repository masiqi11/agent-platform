import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";

export const imKeys = {
  bindings: (projectId: string) => ["im", "bindings", projectId] as const,
  mine: ["im", "identities", "me"] as const,
  providers: ["im", "providers"] as const,
};

export type Binding = Awaited<ReturnType<typeof fetchBindings>>[number];
const fetchBindings = (projectId: string) => unwrap(api.api.v1.projects({ id: projectId }).bindings.get());

export const useBindings = (projectId: string) => useQuery({ queryKey: imKeys.bindings(projectId), queryFn: () => fetchBindings(projectId) });
export const useImProviders = () => useQuery({ queryKey: imKeys.providers, queryFn: () => unwrap(api.api.v1.im.providers.get()), staleTime: 300_000 });
export const useMyIdentities = (enabled = true) => useQuery({ queryKey: imKeys.mine, queryFn: () => unwrap(api.api.v1.me["external-identities"].get()), enabled });

export const MODE_LABEL: Record<string, string> = { at_only: "仅 @机器人", passive: "接收全部消息" };
export const INVALID_REASON: Record<string, string> = {
  bot_removed: "机器人被移出群",
  chat_disbanded: "群已解散",
  app_revoked: "应用权限被回收",
  unbound: "已解除绑定",
};
