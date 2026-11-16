import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
    },
  },
});

/** Central query keys (§13.5); WS events invalidate by these prefixes. */
export const qk = {
  me: ["me"] as const,
  authConfig: ["auth-config"] as const,
  users: ["users"] as const,
  audit: (f: Record<string, unknown>) => ["audit", f] as const,
  auditVerify: ["audit-verify"] as const,
  projects: ["projects"] as const,
  project: (id: string) => ["project", id] as const,
  groups: (projectId: string) => ["groups", projectId] as const,
  timeline: (groupId: string) => ["timeline", groupId] as const,
  groupMembers: (groupId: string) => ["group-members", groupId] as const,
  threads: (groupId: string) => ["threads", groupId] as const,
  projectMembers: (id: string) => ["project-members", id] as const,
  agents: (projectId: string) => ["agents", projectId] as const,
  search: (projectId: string, q: string) => ["search", projectId, q] as const,
};
