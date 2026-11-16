/** Cross-module contracts (spec §12.9, §12.10). */
export interface Citation {
  projectId: string;
  repoId: string;
  path: string;
  commit: string;
  lines?: [number, number];
}

export interface AskProjectCaptainInput {
  projectId: string;
  question: string;
  scope?: { repoIds?: string[]; moduleIds?: string[] };
  asOfCommit?: string;
}

export interface AskProjectCaptainOutput {
  answer: string;
  citations: Citation[];
  confidence: "high" | "medium" | "low";
  stale: boolean;
  followUp?: string;
}

export const NO_EVIDENCE_TEXT = "未检索到依据";

export interface MessageView {
  id: string;
  seq: number;
  author: string;
  authorKind: "human" | "agent" | "system";
  body: string;
  createdAt: string;
}

export interface RetrievedChunk {
  id: string;
  projectId: string;
  repoId: string | null;
  path: string;
  commit: string;
  startLine: number;
  endLine: number;
  text: string;
  sourceKind: string;
  routes: Array<{ route: "bm25" | "sag2" | "vector"; score: number; rank: number }>;
  score: number;
}

export interface MemoryEntryView {
  id: string;
  content: string;
  status: "unconfirmed" | "confirmed" | "disabled";
  sourceRef: string | null;
}

export type TriggerKind = "mention" | "task_assigned" | "review_requested" | "test_requested" | "test_failed" | "approval_decided" | "changes_requested";

export interface ContextPackage {
  policy: {
    tenantId: string;
    projectId: string;
    agentId: string;
    permissions: string[];
    budget: { tokens: number; costUsd: number; wallClockMs: number };
    toolAllowlist: string[];
    outputSchema?: unknown;
  };
  trigger: {
    kind: TriggerKind;
    messageId?: string;
    taskId?: string;
    actorPrincipalId: string;
    threadId?: string;
  };
  task?: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    status: string;
    branch?: string;
    issueUrl?: string;
    owners: string[];
  };
  captainBrief?: {
    decisions: string[];
    constraints: string[];
    openQuestions: string[];
    risks: string[];
    citations: Citation[];
  };
  recentMessages: MessageView[];
  knowledge: RetrievedChunk[];
  memory: MemoryEntryView[];
  /** Token usage per layer L0..L5, for the context inspector (SES-补5). */
  layerTokens?: Record<string, number>;
}

/** L0–L5 default budgets (§12.10), in tokens. */
export const CONTEXT_LAYER_BUDGET = { L0: 1000, L1: 3000, L2: 2000, L3: 4000, L4: 6000, L5: 8000 } as const;

export interface SummaryContent {
  decisions: Array<{ text: string; seqs: number[]; decisionId?: string }>;
  constraints: Array<{ text: string; seqs: number[] }>;
  openQuestions: Array<{ text: string; seqs: number[] }>;
  taskGraph: Array<{ text: string; seqs: number[]; taskId?: string }>;
  risks: Array<{ text: string; seqs: number[] }>;
}

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const TASK_TYPES = ["feature", "bug", "hotfix", "chore"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface ProjectSettings {
  autoAssignPriorities: Priority[];
  mergePolicy: "require_approval" | "auto";
  agentsMayCreateIssues: boolean;
  allowedProviderIds: string[] | null;
  localModelsOnly: boolean;
  sensitivePaths: string[];
  changeLimits: { files: number; lines: number };
  indexExcludes: string[];
  egressAllowlist: string[];
  branchPattern: string;
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  autoAssignPriorities: ["P2", "P3"],
  mergePolicy: "require_approval",
  agentsMayCreateIssues: false,
  allowedProviderIds: null,
  localModelsOnly: false,
  sensitivePaths: [".gitlab-ci.yml", ".github/", "deploy/", "Dockerfile", "package.json", "bun.lock", ".env", "secrets/"],
  changeLimits: { files: 20, lines: 800 },
  indexExcludes: [],
  egressAllowlist: [],
  branchPattern: "task/{number}",
};

/** Default tool allowlist per agent role (§8.2). Agents never exceed their allowlist. */
export const DEFAULT_AGENT_TOOLS: Record<"captain" | "sub_captain" | "dev" | "reviewer" | "tester", string[]> = {
  captain: ["search_knowledge", "ask_project_captain", "send_message"],
  sub_captain: ["search_knowledge", "send_message", "propose_task", "propose_assign", "ask_question", "update_summary"],
  dev: [
    "get_task",
    "list_files",
    "read_file",
    "write_file",
    "search_code",
    "run_command",
    "commit",
    "push",
    "open_merge_request",
    "get_pipeline",
    "request_review",
    "block_task",
    "add_task_comment",
    "send_message",
    "search_knowledge",
  ],
  reviewer: ["get_task", "get_diff", "list_files", "read_file", "search_code", "get_pipeline", "submit_review", "add_task_comment", "send_message", "search_knowledge"],
  tester: ["get_task", "list_files", "read_file", "get_pipeline", "run_tests", "submit_test_result", "add_task_comment", "send_message", "search_knowledge"],
};
