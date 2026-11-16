import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "./api";

export type TaskFilters = { status?: string; assigneeAgentId?: string; ownerPrincipalId?: string; priority?: string; q?: string; groupId?: string };
export const tk = {
  tasks: (projectId: string, f: TaskFilters = {}) => ["tasks", projectId, f] as const,
  task: (id: string) => ["task", id] as const,
  timeline: (id: string) => ["task-timeline", id] as const,
  comments: (id: string) => ["task-comments", id] as const,
  approvals: (id: string) => ["task-approvals", id] as const,
  proposals: (projectId: string) => ["proposals", projectId] as const,
  inbox: (f: Record<string, unknown>) => ["inbox", f] as const,
};

export const tasksQuery = (projectId: string, f: TaskFilters = {}) => ({ queryKey: tk.tasks(projectId, f), queryFn: () => unwrap(api.api.v1.projects({ id: projectId }).tasks.get({ query: f })) });
export const useTasks = (projectId: string, f: TaskFilters = {}) => useQuery(tasksQuery(projectId, f));
export const taskQuery = (id: string) => ({ queryKey: tk.task(id), queryFn: () => unwrap(api.api.v1.tasks({ id }).get()) });
export const useTask = (id: string) => useQuery({ ...taskQuery(id), enabled: Boolean(id) });

export type Task = Awaited<ReturnType<ReturnType<typeof tasksQuery>["queryFn"]>>[number];
export type TaskDetail = Awaited<ReturnType<ReturnType<typeof taskQuery>["queryFn"]>>;
export type TaskStatus = Task["status"];

/** Board columns (§13.3 分色列): colour = state family, not decoration. */
export const COLUMNS: { status: TaskStatus; label: string; dot: string; tint: string }[] = [
  { status: "backlog", label: "待整理", dot: "bg-idle", tint: "bg-idle-soft/40" },
  { status: "ready", label: "就绪", dot: "bg-primary", tint: "bg-accent/30" },
  { status: "in_progress", label: "开发中", dot: "bg-info", tint: "bg-info-soft/40" },
  { status: "blocked", label: "阻塞", dot: "bg-danger", tint: "bg-danger-soft/40" },
  { status: "in_review", label: "评审中", dot: "bg-agent", tint: "bg-agent-soft/40" },
  { status: "testing", label: "测试中", dot: "bg-attention", tint: "bg-attention-soft/40" },
  { status: "done", label: "已完成", dot: "bg-ok", tint: "bg-ok-soft/40" },
];
export const STATUS_LABEL: Record<string, string> = {
  backlog: "待整理",
  ready: "就绪",
  in_progress: "开发中",
  blocked: "阻塞",
  in_review: "评审中",
  testing: "测试中",
  done: "已完成",
  cancelled: "已取消",
};
export const STATUS_TONE: Record<string, string> = {
  backlog: "bg-idle-soft text-muted-foreground",
  ready: "bg-accent text-accent-foreground",
  in_progress: "bg-info-soft text-info",
  blocked: "bg-danger-soft text-danger",
  in_review: "bg-agent-soft text-agent",
  testing: "bg-attention-soft text-foreground",
  done: "bg-ok-soft text-ok",
  cancelled: "bg-muted text-muted-foreground line-through",
};
export const PRIORITY_TONE: Record<string, string> = { P0: "bg-danger text-white", P1: "bg-attention text-black/80", P2: "bg-muted text-foreground", P3: "bg-muted text-muted-foreground" };
export { GUARD_LABELS as GUARD_LABEL } from "@ap/shared";
