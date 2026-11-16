import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "./api";

export const codeKeys = {
  taskCode: (taskId: string) => ["task-code", taskId] as const,
  repos: (projectId: string) => ["repos", projectId] as const,
  agentLoad: (projectId: string) => ["agent-load", projectId] as const,
  system: ["admin-system"] as const,
};

const fetchTaskCode = (taskId: string) => unwrap(api.api.v1.tasks({ id: taskId }).code.get());
export const useTaskCode = (taskId: string) => useQuery({ queryKey: codeKeys.taskCode(taskId), queryFn: () => fetchTaskCode(taskId) });
export const useRepos = (projectId: string) => useQuery({ queryKey: codeKeys.repos(projectId), queryFn: () => unwrap(api.api.v1.projects({ id: projectId }).repos.get()) });
export const useAgentLoad = (projectId: string) =>
  useQuery({ queryKey: codeKeys.agentLoad(projectId), queryFn: () => unwrap(api.api.v1.projects({ id: projectId }).agents.load.get()), refetchInterval: 15_000 });
export const useSystemStatus = () => useQuery({ queryKey: codeKeys.system, queryFn: () => unwrap(api.api.v1.admin.system.get()), refetchInterval: 20_000 });

export type TaskCode = Awaited<ReturnType<typeof fetchTaskCode>>;
export type Repo = NonNullable<ReturnType<typeof useRepos>["data"]>[number];

/** CI status → label + tone (TRAP-7: what the server reports is already monotonic per sha). */
export const CI_LABEL: Record<string, { label: string; cls: string }> = {
  pending: { label: "排队中", cls: "bg-muted text-muted-foreground" },
  running: { label: "运行中", cls: "bg-info-soft text-info" },
  success: { label: "通过", cls: "bg-ok-soft text-ok" },
  failed: { label: "失败", cls: "bg-danger-soft text-danger" },
  canceled: { label: "已取消", cls: "bg-muted text-muted-foreground" },
};

export const REPO_STATUS: Record<string, { label: string; tone: "ok" | "danger" | "attention" }> = {
  ok: { label: "正常", tone: "ok" },
  credential_invalid: { label: "凭据失效", tone: "danger" },
  unreachable: { label: "无法连接", tone: "attention" },
};

export const SESSION_STOP: Record<string, string> = {
  turn_complete: "本轮完成",
  model_done: "模型结束本轮",
  waiting_ci: "等待 CI",
  review_requested: "已提交评审",
  blocked: "已标记阻塞",
  blocked_secret: "密钥扫描拦截",
  loop_detected: "检测到循环，已中止",
  max_steps: "达到步数上限",
  wall_clock: "超过时长上限",
  budget_exceeded: "预算超限",
  llm_unavailable: "模型不可用",
  cancelled_by_human: "已被人工取消",
  taken_over: "已被人工接管",
  reassigned: "任务已改派",
  task_cancelled: "任务已取消",
  no_repo: "项目未绑定仓库",
  workspace_failed: "工作区创建失败",
  review_submitted: "已提交评审结论",
  test_submitted: "已提交测试结论",
  checkout_failed: "检出失败",
  tool_error: "工具执行失败",
  head_moved: "提交已变化",
};

/* S6: reviews, test runs, merge gate, merge queue */
export const qualityKeys = {
  reviews: (taskId: string) => ["task-reviews", taskId] as const,
  tests: (taskId: string) => ["task-tests", taskId] as const,
  gate: (taskId: string) => ["task-gate", taskId] as const,
  queue: (projectId: string) => ["merge-queue", projectId] as const,
};
export const useTaskReviews = (taskId: string) => useQuery({ queryKey: qualityKeys.reviews(taskId), queryFn: () => unwrap(api.api.v1.tasks({ id: taskId }).reviews.get()) });
export const useTaskTests = (taskId: string) => useQuery({ queryKey: qualityKeys.tests(taskId), queryFn: () => unwrap(api.api.v1.tasks({ id: taskId }).tests.get()) });
export const useTaskGate = (taskId: string) => useQuery({ queryKey: qualityKeys.gate(taskId), queryFn: () => unwrap(api.api.v1.tasks({ id: taskId }).gate.get()) });
export const useMergeQueue = (projectId: string) =>
  useQuery({ queryKey: qualityKeys.queue(projectId), queryFn: () => unwrap(api.api.v1.projects({ id: projectId })["merge-queue"].get()), refetchInterval: 15_000 });

export const MQ_STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: "排队中", cls: "bg-muted text-foreground" },
  rebasing: { label: "变基中", cls: "bg-info-soft text-info" },
  waiting_ci: { label: "等待 CI", cls: "bg-info-soft text-info" },
  merging: { label: "合并中", cls: "bg-info-soft text-info" },
  merged: { label: "已合并", cls: "bg-ok-soft text-ok" },
  failed: { label: "已移出", cls: "bg-muted text-muted-foreground" },
  needs_human: { label: "需人工处理", cls: "bg-danger-soft text-danger" },
};
