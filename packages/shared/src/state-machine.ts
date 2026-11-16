/**
 * Task state machine (spec §12.6). This file is the single source of truth:
 * any transition not listed here is illegal.
 */
export const TASK_STATUSES = ["backlog", "ready", "in_progress", "blocked", "in_review", "testing", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TERMINAL_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];

/** Roles an actor can hold *relative to one task*; computed server-side. */
export type TaskActorRole = "human_owner" | "maintainer" | "assignee_agent" | "reviewer_agent" | "human_reviewer" | "tester_agent" | "merge_queue";

/** Facts used by guards, computed by `tasks.facts(task)` on the server. */
export interface TaskFacts {
  hasTitle: boolean;
  hasAcceptanceCriteria: boolean;
  hasAssignee: boolean;
  hasHumanOwner: boolean;
  workspaceReady: boolean;
  mrOpened: boolean;
  ciPassed: boolean;
  evidenceComplete: boolean;
  reviewApproved: boolean;
  testPlanExists: boolean;
  testPassed: boolean;
  merged: boolean;
  issueClosed: boolean;
  /** Approval for the current head (only required when mergePolicy=require_approval). */
  mergeApproved: boolean;
  mergeApprovalRequired: boolean;
  openBlockers: number;
  /** GIT-补7: change scope requires a human review regardless of mergePolicy. */
  humanReviewRequired: boolean;
  humanReviewApproved: boolean;
}

export interface TransitionInput {
  /** Reason text: blocked reason, change request, cancel reason, failure evidence … */
  reason?: string;
  /** For → blocked: who needs to decide. */
  needs?: string;
  /** For testing → in_progress: artifact id of failure evidence. */
  evidenceArtifactId?: string;
}

export type GuardKey =
  | "acceptance_criteria"
  | "assignee"
  | "human_owner"
  | "title"
  | "workspace_ready"
  | "blocked_reason"
  | "blocked_needs"
  | "blocker_resolved"
  | "mr_opened"
  | "ci_passed"
  | "evidence"
  | "review_approved"
  | "test_plan"
  | "change_request"
  | "test_passed"
  | "merged"
  | "issue_closed"
  | "failure_evidence"
  | "cancel_reason";

export interface TransitionRule {
  from: TaskStatus | "*";
  to: TaskStatus;
  actors: TaskActorRole[];
  guards: GuardKey[];
}

export const TRANSITIONS: readonly TransitionRule[] = [
  { from: "backlog", to: "ready", actors: ["human_owner", "maintainer"], guards: ["title", "acceptance_criteria", "assignee", "human_owner"] },
  { from: "ready", to: "in_progress", actors: ["assignee_agent", "human_owner", "maintainer"], guards: ["workspace_ready"] },
  { from: "in_progress", to: "blocked", actors: ["assignee_agent", "human_owner", "maintainer"], guards: ["blocked_reason", "blocked_needs"] },
  { from: "blocked", to: "in_progress", actors: ["assignee_agent", "human_owner", "maintainer"], guards: ["blocker_resolved"] },
  { from: "in_progress", to: "in_review", actors: ["assignee_agent"], guards: ["mr_opened", "ci_passed", "evidence"] },
  { from: "in_review", to: "testing", actors: ["reviewer_agent", "human_reviewer"], guards: ["review_approved", "test_plan"] },
  { from: "in_review", to: "in_progress", actors: ["reviewer_agent", "human_reviewer"], guards: ["change_request"] },
  { from: "testing", to: "done", actors: ["merge_queue", "maintainer"], guards: ["test_passed", "merged", "issue_closed"] },
  { from: "testing", to: "in_progress", actors: ["tester_agent"], guards: ["failure_evidence"] },
  { from: "*", to: "cancelled", actors: ["human_owner", "maintainer"], guards: ["cancel_reason"] },
];

/** Human-readable (zh-CN) labels for guards; UI and errors use the same text. */
export const GUARD_LABELS: Record<GuardKey, string> = {
  acceptance_criteria: "验收标准",
  assignee: "负责 Agent",
  human_owner: "人类 owner",
  title: "标题",
  workspace_ready: "工作区就绪",
  blocked_reason: "阻塞原因",
  blocked_needs: "需要谁决策",
  blocker_resolved: "阻塞已解决",
  mr_opened: "MR 已创建",
  ci_passed: "CI 通过",
  evidence: "证据齐全",
  review_approved: "评审通过",
  test_plan: "测试计划",
  change_request: "修改意见",
  test_passed: "测试通过",
  merged: "合并完成",
  issue_closed: "Issue 已关闭",
  failure_evidence: "失败证据",
  cancel_reason: "取消原因",
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "待整理",
  ready: "就绪",
  in_progress: "开发中",
  blocked: "阻塞",
  in_review: "评审中",
  testing: "测试中",
  done: "已完成",
  cancelled: "已取消",
};

export function findRule(from: TaskStatus, to: TaskStatus): TransitionRule | undefined {
  if (TERMINAL_STATUSES.includes(from)) return undefined;
  return TRANSITIONS.find((r) => r.to === to && (r.from === from || (r.from === "*" && to === "cancelled")));
}

function guardHolds(g: GuardKey, f: TaskFacts, input: TransitionInput): boolean {
  const nonEmpty = (s?: string) => typeof s === "string" && s.trim().length > 0;
  switch (g) {
    case "title":
      return f.hasTitle;
    case "acceptance_criteria":
      return f.hasAcceptanceCriteria;
    case "assignee":
      return f.hasAssignee;
    case "human_owner":
      return f.hasHumanOwner;
    case "workspace_ready":
      return f.workspaceReady;
    case "blocked_reason":
      return nonEmpty(input.reason);
    case "blocked_needs":
      return nonEmpty(input.needs);
    case "blocker_resolved":
      return f.openBlockers === 0;
    case "mr_opened":
      return f.mrOpened;
    case "ci_passed":
      return f.ciPassed;
    case "evidence":
      return f.evidenceComplete;
    case "review_approved":
      return f.reviewApproved;
    case "test_plan":
      return f.testPlanExists;
    case "change_request":
      return nonEmpty(input.reason);
    case "test_passed":
      return f.testPassed;
    case "merged":
      return f.merged;
    case "issue_closed":
      return f.issueClosed;
    case "failure_evidence":
      return nonEmpty(input.evidenceArtifactId) || nonEmpty(input.reason);
    case "cancel_reason":
      return nonEmpty(input.reason);
  }
}

export type TransitionCheck = { ok: true; rule: TransitionRule } | { ok: false; code: "no_such_transition" | "actor_not_allowed" | "guard_failed"; reason: string; missing: GuardKey[] };

export function checkTransition(from: TaskStatus, to: TaskStatus, roles: ReadonlySet<TaskActorRole>, facts: TaskFacts, input: TransitionInput = {}): TransitionCheck {
  const rule = findRule(from, to);
  if (!rule) {
    return { ok: false, code: "no_such_transition", reason: `不存在 ${STATUS_LABELS[from]} → ${STATUS_LABELS[to]} 的迁移`, missing: [] };
  }
  if (!rule.actors.some((a) => roles.has(a))) {
    return { ok: false, code: "actor_not_allowed", reason: `当前身份不能执行该迁移，需要：${rule.actors.join(" / ")}`, missing: [] };
  }
  const missing = rule.guards.filter((g) => !guardHolds(g, facts, input));
  if (missing.length > 0) {
    return { ok: false, code: "guard_failed", reason: `缺少：${missing.map((m) => GUARD_LABELS[m]).join("、")}`, missing };
  }
  return { ok: true, rule };
}

/** Targets reachable from `from` by structure only (used for UI hints). */
export function nextStatuses(from: TaskStatus): TaskStatus[] {
  if (TERMINAL_STATUSES.includes(from)) return [];
  const out = TRANSITIONS.filter((r) => r.from === from).map((r) => r.to);
  out.push("cancelled");
  return [...new Set(out)];
}

export const REWORK_REVIEW_LIMIT = 3;
export const REWORK_TEST_LIMIT = 2;

export const emptyFacts = (): TaskFacts => ({
  hasTitle: false,
  hasAcceptanceCriteria: false,
  hasAssignee: false,
  hasHumanOwner: false,
  workspaceReady: false,
  mrOpened: false,
  ciPassed: false,
  evidenceComplete: false,
  reviewApproved: false,
  testPlanExists: false,
  testPassed: false,
  merged: false,
  issueClosed: false,
  mergeApproved: false,
  mergeApprovalRequired: true,
  openBlockers: 0,
  humanReviewRequired: false,
  humanReviewApproved: false,
});

export type GateKey = "ci_passed" | "review_approved" | "human_review" | "test_passed" | "no_blockers" | "merge_approval";
export interface GateItem {
  key: GateKey;
  label: string;
  ok: boolean;
}

/**
 * Merge gate (§12.8): review ∧ test ∧ CI on the current head ∧ no open blockers ∧ (human review
 * when the scope guard demands it) ∧ (merge approval when mergePolicy=require_approval).
 * Server (merge queue) and UI (gate checklist) use this one definition.
 */
export function evaluateGate(f: TaskFacts): { ok: boolean; items: GateItem[]; missing: GateKey[] } {
  const items: GateItem[] = [
    { key: "ci_passed", label: "CI 通过（当前提交）", ok: f.ciPassed },
    { key: "review_approved", label: "评审通过（当前提交）", ok: f.reviewApproved },
    ...(f.humanReviewRequired ? [{ key: "human_review" as const, label: "人类评审通过（改动范围要求）", ok: f.humanReviewApproved }] : []),
    { key: "test_passed", label: "测试通过（当前提交）", ok: f.testPassed },
    { key: "no_blockers", label: "无未决阻塞", ok: f.openBlockers === 0 },
    ...(f.mergeApprovalRequired ? [{ key: "merge_approval" as const, label: "合并审批通过（当前提交）", ok: f.mergeApproved }] : []),
  ];
  const missing = items.filter((i) => !i.ok).map((i) => i.key);
  return { ok: missing.length === 0, items, missing };
}
