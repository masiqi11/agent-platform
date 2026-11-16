import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { realtime } from "./realtime";
import { invalidateCaptain } from "./captain";
import { api, unwrap } from "./api";
import { qk, queryClient } from "./query";

export const projectsQuery = { queryKey: qk.projects, queryFn: () => unwrap(api.api.v1.projects.get()) };
export const useProjects = () => useQuery(projectsQuery);
export const projectQuery = (id: string) => ({ queryKey: qk.project(id), queryFn: () => unwrap(api.api.v1.projects({ id }).get()) });
export const useProject = (id: string) => useQuery(projectQuery(id));
export const groupsQuery = (projectId: string) => ({ queryKey: qk.groups(projectId), queryFn: () => unwrap(api.api.v1.projects({ id: projectId }).groups.get()) });
export const useGroups = (projectId: string) => useQuery(groupsQuery(projectId));
export const agentsQuery = (projectId: string) => ({ queryKey: qk.agents(projectId), queryFn: () => unwrap(api.api.v1.projects({ id: projectId }).agents.get()) });
export const useAgents = (projectId: string) => useQuery(agentsQuery(projectId));

export type ProjectCard = Awaited<ReturnType<typeof projectsQuery.queryFn>>[number];
export type Group = Awaited<ReturnType<ReturnType<typeof groupsQuery>["queryFn"]>>[number];
export type Agent = Awaited<ReturnType<ReturnType<typeof agentsQuery>["queryFn"]>>[number];

export const AGENT_ROLE_LABEL: Record<string, string> = { captain: "全局船长", sub_captain: "项目船长", dev: "开发", reviewer: "评审", tester: "测试" };

/** Keeps project-level caches fresh from the `project:<id>` topic (unread counts, members, agents). */
export function useProjectLive(projectId: string) {
  useEffect(() => {
    const topic = `project:${projectId}`;
    const off = realtime.subscribe(topic);
    const offF = realtime.onFrame((f) => {
      if (f.topic !== topic || f.type !== "event") return;
      const t = f.event.type;
      if (t.startsWith("message.") || t.startsWith("group.") || t === "thread.created" || t === "member.changed") void queryClient.invalidateQueries({ queryKey: qk.groups(projectId) });
      if (t === "member.changed" || t.startsWith("agent.")) {
        void queryClient.invalidateQueries({ queryKey: ["group-members"] });
        void queryClient.invalidateQueries({ queryKey: qk.projectMembers(projectId) });
        void queryClient.invalidateQueries({ queryKey: qk.agents(projectId) });
      }
      if (t.startsWith("task.") || t.startsWith("approval.") || t.startsWith("proposal.")) {
        void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
        const taskId = (f.event.payload as { taskId?: unknown }).taskId;
        if (typeof taskId === "string") {
          for (const k of ["task", "task-timeline", "task-comments", "task-approvals"]) void queryClient.invalidateQueries({ queryKey: [k, taskId] });
        }
        if (t.startsWith("proposal.")) {
          void queryClient.invalidateQueries({ queryKey: ["proposals", projectId] });
          const pid = (f.event.payload as { proposalId?: unknown }).proposalId;
          if (typeof pid === "string") void queryClient.invalidateQueries({ queryKey: ["proposal", pid] });
        }
      }
      if (t === "summary.updated" || t.startsWith("decision.") || t.startsWith("question.")) invalidateCaptain(t, f.event.payload);
      if (t.startsWith("project.") || t.startsWith("task.")) {
        void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
        void queryClient.invalidateQueries({ queryKey: qk.projects });
      }
    });
    return () => {
      off();
      offF();
    };
  }, [projectId]);
}
