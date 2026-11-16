/**
 * Permission matrix (spec §9.7). Single source of truth; the server re-checks
 * every action, the web app only uses it to show/disable buttons.
 */
export type TenantRole = "owner" | "admin" | "member" | "viewer" | "auditor";
export type ProjectRole = "maintainer" | "member" | "viewer";
export type AgentRole = "captain" | "sub_captain" | "dev" | "reviewer" | "tester";

export type Action =
  | "project.create"
  | "project.view"
  | "project.update"
  | "repo.bind"
  | "group.create"
  | "message.send"
  | "task.create"
  | "task.assign"
  | "task.start"
  | "task.submit_review"
  | "review.approve"
  | "test.run"
  | "merge.approve"
  | "release.approve"
  | "captain.configure"
  | "proposal.decide"
  | "approval.decide_budget_credential"
  | "task.cancel"
  | "agent.manage"
  | "audit.view"
  | "audit.export"
  | "session.view_transcript"
  | "credential.manage"
  | "im.bind"
  | "identity.map_self"
  | "identity.map_any"
  | "admin.users"
  | "admin.system"
  | "tenant.settings";

/** Effective subject for a check. `projectRole` is undefined when not a member. */
export type Subject = { kind: "human"; tenantRole: TenantRole; projectRole?: ProjectRole } | { kind: "agent"; agentRole: AgentRole; isProjectMember: boolean } | { kind: "system" };

/** Resource context for "only own" style rules. */
export interface PermissionContext {
  isTaskOwner?: boolean;
  isTaskAssignee?: boolean;
}

export type Decision = { allowed: true; via: string } | { allowed: false; required: string };

const allow = (via: string): Decision => ({ allowed: true, via });
const deny = (required: string): Decision => ({ allowed: false, required });

/** Effective human level inside a project: owner > admin(=maintainer) > maintainer > member > viewer. */
function humanLevel(s: Extract<Subject, { kind: "human" }>): "owner" | "admin" | "maintainer" | "member" | "viewer" | "auditor" | "none" {
  if (s.tenantRole === "owner") return "owner";
  if (s.tenantRole === "admin") return "admin";
  if (s.projectRole === "maintainer") return "maintainer";
  if (s.tenantRole === "auditor") return "auditor";
  if (s.projectRole === "member") return s.tenantRole === "viewer" ? "viewer" : "member";
  if (s.projectRole === "viewer") return "viewer";
  return "none";
}

export function can(subject: Subject, action: Action, ctx: PermissionContext = {}): Decision {
  if (subject.kind === "system") return allow("system");
  if (subject.kind === "agent") return agentCan(subject, action, ctx);
  const lvl = humanLevel(subject);
  const isMaint = lvl === "owner" || lvl === "admin" || lvl === "maintainer";
  switch (action) {
    case "project.create":
      return lvl === "owner" ? allow("tenant_owner") : deny("Tenant Owner");
    case "tenant.settings":
      return subject.tenantRole === "owner" || subject.tenantRole === "admin" ? allow("tenant_admin") : deny("Tenant Owner / Admin");
    case "admin.users":
    case "admin.system":
      return subject.tenantRole === "owner" || subject.tenantRole === "admin" ? allow("tenant_admin") : deny("Tenant Admin");
    case "project.view":
      return lvl === "auditor" || lvl === "none" ? deny("项目成员") : allow(lvl);
    case "project.update":
    case "repo.bind":
    case "group.create":
    case "captain.configure":
      return isMaint ? allow(lvl) : deny("Project Maintainer");
    case "message.send":
    case "task.create":
      return isMaint || lvl === "member" ? allow(lvl) : deny("Member");
    case "task.assign":
    case "task.start":
    case "task.submit_review":
    case "review.approve":
    case "test.run":
      return isMaint ? allow(lvl) : deny("Project Maintainer");
    case "merge.approve":
    case "release.approve":
      // Admin is explicitly excluded from merge/release approvals (§9.7 second table).
      return lvl === "owner" || lvl === "maintainer" ? allow(lvl) : deny("Tenant Owner / Project Maintainer");
    case "approval.decide_budget_credential":
      return subject.tenantRole === "owner" || subject.tenantRole === "admin" ? allow("tenant_admin") : deny("Tenant Owner / Admin");
    case "proposal.decide":
      return isMaint || lvl === "member" ? allow(lvl) : deny("Member（确认后成为 owner）");
    case "task.cancel":
      if (lvl === "owner" || lvl === "maintainer") return allow(lvl);
      if (lvl === "member" && ctx.isTaskOwner) return allow("task_owner");
      return deny("Maintainer 或任务 owner");
    case "agent.manage":
      return isMaint ? allow(lvl) : deny("Tenant Admin / Project Maintainer");
    case "audit.view":
    case "audit.export":
      return isMaint || subject.tenantRole === "auditor" ? allow(lvl === "none" ? "auditor" : lvl) : deny("Auditor / Maintainer");
    case "session.view_transcript":
      if (isMaint || subject.tenantRole === "auditor") return allow(lvl);
      if (lvl === "member" && ctx.isTaskOwner) return allow("task_owner");
      return deny("Maintainer 或任务 owner");
    case "credential.manage":
      return isMaint ? allow(lvl) : deny("Tenant Admin / Project Maintainer");
    case "im.bind":
    case "identity.map_any":
      return isMaint ? allow(lvl) : deny("Project Maintainer");
    case "identity.map_self":
      return isMaint || lvl === "member" ? allow(lvl) : deny("Member");
  }
}

function agentCan(s: Extract<Subject, { kind: "agent" }>, action: Action, ctx: PermissionContext): Decision {
  if (!s.isProjectMember && action !== "project.view") return deny("项目成员");
  const r = s.agentRole;
  const captain = r === "captain" || r === "sub_captain";
  switch (action) {
    case "project.view":
      return s.isProjectMember || r === "captain" ? allow(`agent_${r}`) : deny("项目成员");
    case "message.send":
      return allow(`agent_${r}`);
    case "task.create":
      // Captain only *proposes* (INV-07); the proposal path checks this action.
      return r === "dev" || r === "reviewer" || captain ? allow(`agent_${r}`) : deny("Dev / Reviewer Agent 或船长（提议）");
    case "task.assign":
      return captain ? allow("captain_proposal") : deny("船长（提议）");
    case "task.start":
    case "task.submit_review":
      return r === "dev" && ctx.isTaskAssignee ? allow("assignee") : deny("负责的 Dev Agent");
    case "review.approve":
      return r === "reviewer" && !ctx.isTaskAssignee ? allow("reviewer_agent") : deny("Reviewer Agent（非开发者）");
    case "test.run":
      return r === "tester" && !ctx.isTaskAssignee ? allow("tester_agent") : deny("Tester Agent（非开发者）");
    default:
      return deny("人类角色");
  }
}

/** Default tool set per agent role (spec §22.4). Captain has no direct state-changing tools (INV-07). */
export const AGENT_TOOL_ROLES: Record<AgentRole, readonly string[]> = {
  captain: [
    "list_projects",
    "get_project",
    "ask_project_captain",
    "search_knowledge",
    "read_group_history",
    "search_messages",
    "send_message",
    "get_task",
    "propose_task",
    "propose_assign",
    "propose_transition",
    "update_summary",
    "ask_question",
  ],
  sub_captain: [
    "list_projects",
    "get_project",
    "ask_project_captain",
    "search_knowledge",
    "read_group_history",
    "search_messages",
    "send_message",
    "get_task",
    "add_task_comment",
    "propose_task",
    "propose_assign",
    "propose_transition",
    "update_summary",
    "ask_question",
  ],
  dev: [
    "list_projects",
    "get_project",
    "ask_project_captain",
    "search_knowledge",
    "read_group_history",
    "search_messages",
    "send_message",
    "get_task",
    "add_task_comment",
    "get_pipeline",
    "request_approval",
    "create_task",
    "update_task",
    "read_file",
    "write_file",
    "list_files",
    "search_code",
    "run_command",
    "commit",
    "push",
    "open_merge_request",
    "request_review",
    "block_task",
  ],
  reviewer: [
    "list_projects",
    "get_project",
    "search_knowledge",
    "read_group_history",
    "send_message",
    "get_task",
    "add_task_comment",
    "get_pipeline",
    "read_file",
    "list_files",
    "search_code",
    "get_diff",
    "submit_review",
    "create_task",
  ],
  tester: [
    "list_projects",
    "get_project",
    "search_knowledge",
    "read_group_history",
    "send_message",
    "get_task",
    "add_task_comment",
    "get_pipeline",
    "read_file",
    "list_files",
    "run_tests",
    "submit_test_result",
  ],
};

/** Tools that would change task status or merge directly. Never granted to captains. */
export const CAPTAIN_FORBIDDEN_TOOLS = ["transition_task", "merge", "assign_task_direct", "update_task", "push", "commit", "open_merge_request"] as const;
