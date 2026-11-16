/**
 * Drizzle schema (spec §8.2). Column names are mapped camelCase → snake_case by the
 * drizzle `casing: "snake_case"` option (D19: mapping happens only here).
 * Objects drizzle cannot express (extension, triggers, GIN/vector/partial indexes, CHECKs)
 * live in hand-written migrations under ./migrations (marked "手写，勿被生成覆盖").
 */

import { bigint, bigserial, boolean, customType, index, integer, jsonb, numeric, pgTableCreator, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** camelCase keys → snake_case columns, defined once here (D19). */
const pgTable = pgTableCreator((name) => name, "snake_case");

const ts = (name?: string) => (name ? timestamp(name, { withTimezone: true, mode: "date" }) : timestamp({ withTimezone: true, mode: "date" }));
const createdAt = () => ts().notNull().defaultNow();
const updatedAt = () => ts().notNull().defaultNow();

export const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
export const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType: (c) => `vector(${c?.dimensions ?? 768})`,
  toDriver: (v) => `[${v.join(",")}]`,
  fromDriver: (v) => (typeof v === "string" ? v.slice(1, -1).split(",").map(Number) : (v as unknown as number[])),
});

/* ───────────── better-auth tables (managed by better-auth only) ───────────── */
export const authUser = pgTable("auth_user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export const authSession = pgTable("auth_session", {
  id: text().primaryKey(),
  expiresAt: ts().notNull(),
  token: text().notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  ipAddress: text(),
  userAgent: text(),
  userId: text()
    .notNull()
    .references(() => authUser.id, { onDelete: "cascade" }),
});
export const authAccount = pgTable("auth_account", {
  id: text().primaryKey(),
  accountId: text().notNull(),
  providerId: text().notNull(),
  userId: text()
    .notNull()
    .references(() => authUser.id, { onDelete: "cascade" }),
  accessToken: text(),
  refreshToken: text(),
  idToken: text(),
  accessTokenExpiresAt: ts(),
  refreshTokenExpiresAt: ts(),
  scope: text(),
  password: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export const authVerification = pgTable("auth_verification", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: ts().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ───────────── identity & tenant ───────────── */
export const tenant = pgTable("tenant", {
  id: text().primaryKey(),
  name: text().notNull(),
  domain: text(),
  timezone: text().notNull().default("Asia/Shanghai"),
  locale: text().notNull().default("zh-CN"),
  status: text().notNull().default("active"),
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const appUser = pgTable(
  "app_user",
  {
    id: text().primaryKey(),
    tenantId: text()
      .notNull()
      .references(() => tenant.id),
    authUserId: text()
      .unique()
      .references(() => authUser.id, { onDelete: "set null" }),
    email: text().notNull(),
    name: text().notNull(),
    tenantRole: text().$type<"owner" | "admin" | "member" | "viewer" | "auditor">().notNull().default("member"),
    status: text().$type<"active" | "disabled">().notNull().default("active"),
    sessionVersion: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("app_user_tenant_email_uq").on(t.tenantId, t.email)],
);

export const principal = pgTable(
  "principal",
  {
    id: text().primaryKey(),
    tenantId: text()
      .notNull()
      .references(() => tenant.id),
    kind: text().$type<"human" | "agent" | "system">().notNull(),
    refId: text(),
    displayName: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("principal_tenant_kind_idx").on(t.tenantId, t.kind), index("principal_ref_idx").on(t.refId)],
);

export const invitation = pgTable("invitation", {
  id: text().primaryKey(),
  tenantId: text()
    .notNull()
    .references(() => tenant.id),
  email: text(),
  tenantRole: text().notNull().default("member"),
  projectId: text(),
  projectRole: text(),
  tokenHash: text().notNull().unique(),
  kind: text().$type<"invite" | "password_reset">().notNull().default("invite"),
  targetUserId: text(),
  expiresAt: ts().notNull(),
  usedAt: ts(),
  createdBy: text().notNull(),
  createdAt: createdAt(),
});

export const externalIdentity = pgTable(
  "external_identity",
  {
    id: text().primaryKey(),
    tenantId: text()
      .notNull()
      .references(() => tenant.id),
    provider: text().notNull(),
    externalUserId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => appUser.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("external_identity_uq").on(t.provider, t.externalUserId)],
);

export const bindCode = pgTable("bind_code", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  userId: text().notNull(),
  provider: text().notNull(),
  codeHash: text().notNull().unique(),
  expiresAt: ts().notNull(),
  usedAt: ts(),
  createdAt: createdAt(),
});

/* ───────────── projects & repos ───────────── */
export const project = pgTable(
  "project",
  {
    id: text().primaryKey(),
    tenantId: text()
      .notNull()
      .references(() => tenant.id),
    key: text().notNull(),
    name: text().notNull(),
    description: text().notNull().default(""),
    defaultBranch: text().notNull().default("main"),
    status: text().$type<"active" | "archived">().notNull().default("active"),
    settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    nextTaskNumber: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("project_tenant_key_uq").on(t.tenantId, t.key)],
);

export const projectMember = pgTable(
  "project_member",
  {
    tenantId: text().notNull(),
    projectId: text()
      .notNull()
      .references(() => project.id),
    principalId: text()
      .notNull()
      .references(() => principal.id),
    role: text().$type<"maintainer" | "member" | "viewer">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.principalId] })],
);

export const credential = pgTable("credential", {
  id: text().primaryKey(),
  tenantId: text()
    .notNull()
    .references(() => tenant.id),
  kind: text().$type<"scm" | "im" | "llm">().notNull(),
  name: text().notNull(),
  ciphertext: text().notNull(),
  keyVersion: integer().notNull(),
  last4: text().notNull(),
  projectIds: jsonb().$type<string[]>().notNull().default([]),
  lastUsedAt: ts(),
  lastUsedBy: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const repo = pgTable("repo", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  projectId: text()
    .notNull()
    .references(() => project.id),
  name: text().notNull(),
  provider: text().$type<"local" | "gitlab">().notNull(),
  externalId: text().notNull(),
  url: text().notNull(),
  defaultBranch: text().notNull().default("main"),
  credentialId: text(),
  webhookSecretRef: text(),
  caCertRef: text(),
  status: text().$type<"ok" | "credential_invalid" | "unreachable">().notNull().default("ok"),
  lastIndexedCommit: text(),
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const module_ = pgTable("module", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  projectId: text()
    .notNull()
    .references(() => project.id),
  repoId: text(),
  name: text().notNull(),
  path: text().notNull(),
  ownerPrincipalId: text(),
  dependsOn: jsonb().$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ───────────── groups & timeline ───────────── */
export const chatGroup = pgTable("chat_group", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  projectId: text()
    .notNull()
    .references(() => project.id),
  name: text().notNull(),
  kind: text().$type<"main" | "topic">().notNull(),
  captainAgentId: text(),
  visibility: text().notNull().default("project"),
  status: text().$type<"active" | "archived">().notNull().default("active"),
  nextSeq: bigint({ mode: "number" }).notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const groupMember = pgTable(
  "group_member",
  {
    tenantId: text().notNull(),
    groupId: text()
      .notNull()
      .references(() => chatGroup.id),
    principalId: text()
      .notNull()
      .references(() => principal.id),
    role: text().notNull().default("member"),
    notificationPref: text().notNull().default("all"),
    lastReadSeq: bigint({ mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.principalId] })],
);

export const thread = pgTable("thread", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  groupId: text()
    .notNull()
    .references(() => chatGroup.id),
  title: text().notNull(),
  status: text().$type<"open" | "closed">().notNull().default("open"),
  rootMessageId: text(),
  createdBy: text().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type MessageKind = "text" | "summary_card" | "task_card" | "proposal_card" | "question" | "decision_card" | "system";
export const message = pgTable(
  "message",
  {
    id: text().primaryKey(),
    tenantId: text().notNull(),
    groupId: text()
      .notNull()
      .references(() => chatGroup.id),
    threadId: text(),
    seq: bigint({ mode: "number" }).notNull(),
    authorPrincipalId: text()
      .notNull()
      .references(() => principal.id),
    authorLabel: text().notNull(),
    kind: text().$type<MessageKind>().notNull().default("text"),
    body: text().notNull(),
    blocks: jsonb().$type<Record<string, unknown> | null>(),
    mentions: jsonb().$type<string[]>().notNull().default([]),
    replyToId: text(),
    source: text().notNull().default("web"),
    externalId: text(),
    wakeDepth: integer().notNull().default(0),
    tokens: tsvector(),
    editedAt: ts(),
    deletedAt: ts(),
    deletedBy: text(),
    correctedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("message_group_seq_uq").on(t.groupId, t.seq), index("message_author_idx").on(t.authorPrincipalId)],
);

export const messageVersion = pgTable(
  "message_version",
  {
    messageId: text()
      .notNull()
      .references(() => message.id),
    version: integer().notNull(),
    body: text().notNull(),
    blocks: jsonb(),
    editedBy: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.version] })],
);

export const attachment = pgTable("attachment", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  messageId: text(),
  groupId: text().notNull(),
  uri: text().notNull(),
  name: text().notNull(),
  sha256: text().notNull(),
  size: integer().notNull(),
  mime: text().notNull(),
  scanStatus: text().$type<"pending" | "clean" | "infected" | "unscanned">().notNull().default("unscanned"),
  uploadedBy: text().notNull(),
  createdAt: createdAt(),
});

export const summary = pgTable("summary", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  groupId: text()
    .notNull()
    .references(() => chatGroup.id),
  fromSeq: bigint({ mode: "number" }).notNull(),
  toSeq: bigint({ mode: "number" }).notNull(),
  version: integer().notNull(),
  promptVersion: text().notNull(),
  model: text().notNull(),
  content: jsonb().$type<Record<string, unknown>>().notNull(),
  supersedesId: text(),
  correctedBy: text(),
  correction: jsonb().$type<Record<string, unknown> | null>(),
  createdAt: createdAt(),
});

export const decision = pgTable("decision", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  projectId: text().notNull(),
  groupId: text().notNull(),
  text: text().notNull(),
  status: text().$type<"proposed" | "confirmed" | "rejected" | "revoked">().notNull().default("proposed"),
  sourceMessageIds: jsonb().$type<string[]>().notNull().default([]),
  summaryId: text(),
  confirmedBy: text(),
  confirmedAt: ts(),
  revokedBy: text(),
  revokedReason: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const binding = pgTable(
  "binding",
  {
    id: text().primaryKey(),
    tenantId: text().notNull(),
    provider: text().notNull(),
    externalChatId: text().notNull(),
    groupId: text().notNull(),
    mode: text().$type<"at_only" | "passive">().notNull().default("at_only"),
    status: text().$type<"active" | "invalid">().notNull().default("active"),
    createdBy: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("binding_provider_chat_uq").on(t.provider, t.externalChatId)],
);

export const outboundDelivery = pgTable("outbound_delivery", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  bindingId: text().notNull(),
  messageId: text().notNull(),
  status: text().$type<"pending" | "sent" | "failed" | "dead" | "stopped">().notNull().default("pending"),
  attempts: integer().notNull().default(0),
  lastError: text(),
  nextAttemptAt: ts(),
  createdAt: createdAt(),
});

/* ───────────── tasks & flow ───────────── */
export type AcceptanceCriterion = { id: string; text: string; verdict?: "met" | "unmet" | "na"; note?: string };
export const task = pgTable(
  "task",
  {
    id: text().primaryKey(),
    tenantId: text().notNull(),
    projectId: text()
      .notNull()
      .references(() => project.id),
    groupId: text(),
    number: integer().notNull(),
    title: text().notNull(),
    description: text().notNull().default(""),
    type: text().$type<"feature" | "bug" | "hotfix" | "chore">().notNull().default("feature"),
    priority: text().$type<"P0" | "P1" | "P2" | "P3">().notNull().default("P2"),
    status: text().$type<"backlog" | "ready" | "in_progress" | "blocked" | "in_review" | "testing" | "done" | "cancelled">().notNull().default("backlog"),
    assigneeAgentId: text(),
    acceptanceCriteria: jsonb().$type<AcceptanceCriterion[]>().notNull().default([]),
    testPlan: jsonb().$type<Record<string, unknown> | null>(),
    dueAt: ts(),
    issueRef: text(),
    issueUrl: text(),
    sourceMessageIds: jsonb().$type<string[]>().notNull().default([]),
    followUpOf: text(),
    blockedReason: text(),
    blockedNeeds: text(),
    takenOverBy: text(),
    version: integer().notNull().default(1),
    reworkReviewCount: integer().notNull().default(0),
    reworkTestCount: integer().notNull().default(0),
    tokens: tsvector(),
    createdBy: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("task_project_number_uq").on(t.projectId, t.number), index("task_project_status_priority_idx").on(t.projectId, t.status, t.priority)],
);

export const taskOwner = pgTable(
  "task_owner",
  {
    taskId: text()
      .notNull()
      .references(() => task.id),
    principalId: text()
      .notNull()
      .references(() => principal.id),
    role: text().$type<"owner" | "reviewer">().notNull().default("owner"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.principalId, t.role] })],
);

export const taskComment = pgTable("task_comment", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  taskId: text()
    .notNull()
    .references(() => task.id),
  authorPrincipalId: text().notNull(),
  body: text().notNull(),
  source: text().notNull().default("web"),
  externalId: text(),
  createdAt: createdAt(),
});

export const taskLink = pgTable(
  "task_link",
  {
    taskId: text().notNull(),
    otherTaskId: text().notNull(),
    kind: text().$type<"blocks" | "relates" | "follow_up">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.otherTaskId, t.kind] })],
);

export const proposal = pgTable("proposal", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  projectId: text().notNull(),
  groupId: text(),
  kind: text().$type<"create_task" | "assign" | "transition" | "merge">().notNull(),
  payload: jsonb().$type<Record<string, unknown>>().notNull(),
  status: text().$type<"pending" | "accepted" | "rejected" | "expired" | "superseded">().notNull().default("pending"),
  sourceMessageIds: jsonb().$type<string[]>().notNull(),
  proposedBy: text().notNull(),
  decidedBy: text(),
  decidedAt: ts(),
  reason: text(),
  policy: text(),
  messageId: text(),
  resultTaskIds: jsonb().$type<string[]>().notNull().default([]),
  expiresAt: ts().notNull(),
  remindedAt: ts(),
  supersededBy: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const approval = pgTable("approval", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  taskId: text()
    .notNull()
    .references(() => task.id),
  kind: text().$type<"merge" | "release" | "credential" | "budget">().notNull(),
  status: text().$type<"pending" | "approved" | "rejected" | "expired" | "invalidated">().notNull().default("pending"),
  headSha: text(),
  requestedBy: text().notNull(),
  decidedBy: text(),
  decidedAt: ts(),
  reason: text(),
  rejectTo: text(),
  evidence: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  expiresAt: ts().notNull(),
  escalatedAt: ts(),
  createdAt: createdAt(),
});

export const review = pgTable("review", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  taskId: text()
    .notNull()
    .references(() => task.id),
  reviewerPrincipalId: text().notNull(),
  reviewerKind: text().$type<"agent" | "human">().notNull(),
  headSha: text().notNull(),
  verdict: text().$type<"approved" | "changes_requested">().notNull(),
  comments: jsonb().$type<Array<{ path?: string; line?: number; body: string; resolved?: boolean }>>().notNull().default([]),
  criteriaVerdicts: jsonb().$type<Record<string, string>>().notNull().default({}),
  round: integer().notNull(),
  superseded: boolean().notNull().default(false),
  createdAt: createdAt(),
});

export const testRun = pgTable("test_run", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  taskId: text()
    .notNull()
    .references(() => task.id),
  testerPrincipalId: text().notNull(),
  headSha: text().notNull(),
  plan: jsonb().$type<Record<string, unknown>>().notNull(),
  status: text().$type<"running" | "passed" | "failed" | "error">().notNull().default("running"),
  reportArtifactId: text(),
  logArtifactId: text(),
  attempt: integer().notNull().default(1),
  criteriaResults: jsonb().$type<Array<{ id: string; text: string; verdict: string; evidence?: string }>>().notNull().default([]),
  superseded: boolean().notNull().default(false),
  durationMs: integer(),
  createdAt: createdAt(),
  finishedAt: ts(),
});

export const escalation = pgTable("escalation", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  taskId: text().notNull(),
  level: integer().notNull(),
  reason: text().notNull(),
  targetPrincipalId: text().notNull(),
  raisedAt: ts().notNull().defaultNow(),
  acknowledgedAt: ts(),
  nextEscalationAt: ts(),
});

export const inboxItem = pgTable(
  "inbox_item",
  {
    id: text().primaryKey(),
    tenantId: text().notNull(),
    principalId: text().notNull(),
    kind: text().$type<"mention" | "approval" | "task" | "escalation" | "proposal" | "question" | "budget">().notNull(),
    refType: text().notNull(),
    refId: text().notNull(),
    groupKey: text().notNull(),
    title: text().notNull(),
    count: integer().notNull().default(1),
    projectId: text(),
    readAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("inbox_principal_idx").on(t.principalId, t.readAt)],
);

export const question = pgTable("question", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  groupId: text().notNull(),
  messageId: text(),
  text: text().notNull(),
  options: jsonb().$type<string[]>().notNull().default([]),
  defaultOption: text(),
  irreversible: boolean().notNull().default(false),
  deadlineAt: ts().notNull(),
  status: text().$type<"open" | "answered" | "defaulted" | "escalated">().notNull().default("open"),
  answer: text(),
  answeredBy: text(),
  createdAt: createdAt(),
});

/* ───────────── code & delivery ───────────── */
export const workspace = pgTable(
  "workspace",
  {
    id: text().primaryKey(),
    tenantId: text().notNull(),
    taskId: text()
      .notNull()
      .references(() => task.id),
    repoId: text()
      .notNull()
      .references(() => repo.id),
    branch: text().notNull(),
    baseCommit: text(),
    headCommit: text(),
    worktreePath: text(),
    containerId: text(),
    workerId: text(),
    mrRef: text(),
    mrUrl: text(),
    ci: jsonb().$type<{ status: string; sha: string; url?: string; finishedAt?: string } | null>(),
    diffStat: jsonb().$type<{ files: number; additions: number; deletions: number; paths: string[] } | null>(),
    status: text().$type<"creating" | "ready" | "conflict" | "released">().notNull().default("creating"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("workspace_task_repo_uq").on(t.taskId, t.repoId)],
);

export const mergeQueueItem = pgTable("merge_queue_item", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  projectId: text().notNull(),
  taskId: text().notNull().unique(),
  position: bigserial({ mode: "number" }).notNull(),
  status: text().$type<"queued" | "rebasing" | "waiting_ci" | "merging" | "merged" | "failed" | "needs_human">().notNull().default("queued"),
  headSha: text(),
  attempts: integer().notNull().default(0),
  lastError: text(),
  enqueuedAt: ts().notNull().defaultNow(),
  updatedAt: updatedAt(),
});

export const releaseRecord = pgTable("release_record", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  taskId: text().notNull(),
  mrRef: text(),
  mergeCommit: text().notNull(),
  testRunId: text(),
  approvedBy: text(),
  createdAt: createdAt(),
});

export const artifact = pgTable("artifact", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  taskId: text(),
  sessionId: text(),
  kind: text().$type<"patch" | "test_report" | "log" | "screenshot" | "doc" | "coverage">().notNull(),
  name: text().notNull(),
  uri: text().notNull(),
  sha256: text().notNull(),
  size: integer().notNull(),
  createdBy: text().notNull(),
  createdAt: createdAt(),
});

/* ───────────── agents & sessions ───────────── */
export const agent = pgTable(
  "agent",
  {
    id: text().primaryKey(),
    tenantId: text().notNull(),
    projectId: text(),
    principalId: text().notNull(),
    name: text().notNull(),
    role: text().$type<"captain" | "sub_captain" | "dev" | "reviewer" | "tester">().notNull(),
    instructions: text().notNull().default(""),
    avatar: text(),
    modelPolicy: jsonb().$type<{ primary?: string; fallback?: string; temperature?: number; maxTokens?: number }>().notNull().default({}),
    toolAllowlist: jsonb().$type<string[]>().notNull().default([]),
    mcpServers: jsonb().$type<unknown[]>().notNull().default([]),
    sandboxPolicy: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    budget: jsonb().$type<{ maxSteps?: number; maxTokens?: number; maxCostUsd?: number; wallClockMs?: number }>().notNull().default({}),
    maxConcurrency: integer().notNull().default(3),
    status: text().$type<"active" | "paused" | "disabled">().notNull().default("active"),
    configVersion: integer().notNull().default(1),
    tokenVersion: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("agent_project_idx").on(t.projectId)],
);

export const session = pgTable("session", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  agentId: text().notNull(),
  projectId: text(),
  scopeType: text().$type<"resident" | "task" | "thread" | "one_shot">().notNull(),
  scopeId: text().notNull(),
  status: text().$type<"idle" | "queued" | "running" | "suspended" | "interrupted" | "completed" | "failed">().notNull().default("idle"),
  agentConfigVersion: integer().notNull(),
  summary: text(),
  checkpoint: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  lastEventSeq: bigint({ mode: "number" }).notNull().default(0),
  model: text(),
  steps: integer().notNull().default(0),
  tokensUsed: integer().notNull().default(0),
  costUsed: numeric({ precision: 14, scale: 6, mode: "number" }).notNull().default(0),
  stopReason: text(),
  leaseOwner: text(),
  heartbeatAt: ts(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessionTurn = pgTable("session_turn", {
  id: text().primaryKey(),
  sessionId: text()
    .notNull()
    .references(() => session.id),
  idx: integer().notNull(),
  role: text().notNull(),
  content: text().notNull().default(""),
  toolCalls: jsonb().$type<unknown[]>().notNull().default([]),
  contextPackage: jsonb().$type<Record<string, unknown> | null>(),
  tokensIn: integer().notNull().default(0),
  tokensOut: integer().notNull().default(0),
  createdAt: createdAt(),
});

export const memoryEntry = pgTable("memory_entry", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  projectId: text().notNull(),
  agentId: text(),
  content: text().notNull(),
  sourceRef: text(),
  writtenBy: text().notNull(),
  status: text().$type<"unconfirmed" | "confirmed" | "disabled">().notNull().default("unconfirmed"),
  createdAt: createdAt(),
});

/* ───────────── models & cost ───────────── */
export const modelProvider = pgTable("model_provider", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  name: text().notNull(),
  baseUrl: text().notNull(),
  credentialId: text(),
  kind: text().$type<"openai_compatible" | "scripted">().notNull(),
  /** Wire dialect for openai_compatible providers: plain OpenAI chat/completions, or Ollama's native /api/chat (think:false). */
  dialect: text().$type<"openai" | "ollama">().notNull().default("openai"),
  isExternal: boolean().notNull().default(true),
  status: text().notNull().default("active"),
  circuitState: jsonb().$type<{ state: "closed" | "open" | "half_open"; failures: number; openedAt?: string }>().notNull().default({ state: "closed", failures: 0 }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const model = pgTable("model", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  providerId: text()
    .notNull()
    .references(() => modelProvider.id),
  name: text().notNull(),
  contextWindow: integer().notNull().default(8192),
  supportsTools: boolean().notNull().default(false),
  supportsJson: boolean().notNull().default(false),
  inputPrice: numeric({ precision: 14, scale: 8, mode: "number" }),
  outputPrice: numeric({ precision: 14, scale: 8, mode: "number" }),
  currency: text().notNull().default("USD"),
  embeddingDim: integer(),
  supportsStreaming: boolean().notNull().default(true),
  /** Ollama: disable "thinking" for reasoning-capable small models (ADR-0003). */
  thinkOff: boolean().notNull().default(false),
  tier: text().$type<"small" | "large">().notNull().default("small"),
  notes: text(),
  createdAt: createdAt(),
});

export const llmCall = pgTable(
  "llm_call",
  {
    id: text().primaryKey(),
    tenantId: text().notNull(),
    projectId: text(),
    taskId: text(),
    sessionId: text(),
    agentId: text(),
    purpose: text().notNull(),
    model: text().notNull(),
    providerId: text(),
    promptVersion: text(),
    tokensIn: integer().notNull().default(0),
    tokensOut: integer().notNull().default(0),
    cost: numeric({ precision: 14, scale: 6, mode: "number" }).notNull().default(0),
    latencyMs: integer().notNull().default(0),
    status: text().notNull(),
    error: text(),
    fallbackFrom: text(),
    toolMode: text(),
    repaired: boolean().notNull().default(false),
    usedFallback: boolean().notNull().default(false),
    dataClasses: jsonb().$type<string[]>().notNull().default([]),
    traceId: text(),
    createdAt: createdAt(),
  },
  (t) => [index("llm_call_task_idx").on(t.taskId), index("llm_call_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

export const budget = pgTable(
  "budget",
  {
    id: text().primaryKey(),
    tenantId: text().notNull(),
    scopeType: text().$type<"tenant" | "project" | "task">().notNull(),
    scopeId: text().notNull(),
    period: text().notNull().default("total"),
    limitTokens: integer(),
    limitCost: numeric({ precision: 14, scale: 6, mode: "number" }),
    usedTokens: integer().notNull().default(0),
    usedCost: numeric({ precision: 14, scale: 6, mode: "number" }).notNull().default(0),
    reservedCost: numeric({ precision: 14, scale: 6, mode: "number" }).notNull().default(0),
    reservedTokens: integer().notNull().default(0),
    status: text().$type<"ok" | "exceeded">().notNull().default("ok"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("budget_scope_uq").on(t.scopeType, t.scopeId, t.period)],
);

/* ───────────── knowledge ───────────── */
export const projectIndex = pgTable("project_index", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  projectId: text().notNull(),
  repoId: text(),
  version: integer().notNull(),
  isActive: boolean().notNull().default(false),
  commit: text(),
  embeddingModel: text(),
  embeddingDim: integer(),
  tokenizerVersion: text().notNull(),
  status: text().$type<"building" | "ready" | "failed">().notNull().default("building"),
  stats: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const documentChunk = pgTable(
  "document_chunk",
  {
    id: text().primaryKey(),
    indexId: text().notNull(),
    tenantId: text().notNull(),
    projectId: text().notNull(),
    repoId: text(),
    groupId: text(),
    sourceKind: text().$type<"code" | "doc" | "issue" | "mr" | "chat" | "decision" | "summary">().notNull(),
    path: text().notNull(),
    symbol: text(),
    commit: text().notNull(),
    startLine: integer().notNull().default(1),
    endLine: integer().notNull().default(1),
    text: text().notNull(),
    tokens: tsvector(),
    embedding: vector({ dimensions: 768 }),
    tombstonedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index("chunk_index_path_idx").on(t.indexId, t.path), index("chunk_project_idx").on(t.projectId)],
);

export const fileState = pgTable(
  "file_state",
  {
    indexId: text().notNull(),
    path: text().notNull(),
    blobSha: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.indexId, t.path] })],
);

export const depEdge = pgTable("dep_edge", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  projectId: text().notNull(),
  fromRef: text().notNull(),
  toRef: text().notNull(),
  kind: text().$type<"import" | "manifest" | "openapi" | "proto" | "deploy">().notNull(),
  commit: text().notNull(),
  createdAt: createdAt(),
});

export const evalQuestion = pgTable("eval_question", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  projectId: text().notNull(),
  question: text().notNull(),
  expectedRefs: jsonb().$type<string[]>().notNull().default([]),
  tags: jsonb().$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
});

export const sag2Cache = pgTable("sag2_cache", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  createdAt: createdAt(),
});

/* ───────────── platform kernel ───────────── */
export const event = pgTable(
  "event",
  {
    id: text().primaryKey(),
    tenantId: text().notNull(),
    seq: bigserial({ mode: "number" }).notNull().unique(),
    type: text().notNull(),
    aggregateType: text().notNull(),
    aggregateId: text().notNull(),
    actorPrincipalId: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    traceId: text().notNull(),
    idempotencyKey: text(),
    occurredAt: ts().notNull().defaultNow(),
  },
  (t) => [index("event_aggregate_idx").on(t.tenantId, t.aggregateType, t.aggregateId, t.seq)],
);

export const eventConsumer = pgTable("event_consumer", {
  name: text().primaryKey(),
  offsetSeq: bigint({ mode: "number" }).notNull().default(0),
  leaseOwner: text(),
  leaseUntil: ts(),
  lastError: text(),
  attempts: integer().notNull().default(0),
  updatedAt: updatedAt(),
});

export const deadLetter = pgTable("dead_letter", {
  id: text().primaryKey(),
  tenantId: text(),
  source: text().$type<"event" | "job" | "im">().notNull(),
  refId: text().notNull(),
  consumer: text(),
  payload: jsonb().notNull(),
  error: text().notNull(),
  attempts: integer().notNull(),
  createdAt: createdAt(),
  replayedAt: ts(),
  discardedBy: text(),
});

export const job = pgTable(
  "job",
  {
    id: text().primaryKey(),
    tenantId: text(),
    type: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: text().$type<"queued" | "running" | "succeeded" | "failed" | "dead">().notNull().default("queued"),
    runAt: ts().notNull().defaultNow(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    dedupeKey: text(),
    concurrencyKey: text(),
    leaseOwner: text(),
    leaseUntil: ts(),
    heartbeatAt: ts(),
    lastError: text(),
    cron: text(),
    traceId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("job_status_run_idx").on(t.status, t.runAt)],
);

export const idempotencyRecord = pgTable(
  "idempotency_record",
  {
    actorPrincipalId: text().notNull(),
    key: text().notNull(),
    requestHash: text().notNull(),
    response: jsonb(),
    statusCode: integer().notNull(),
    expiresAt: ts().notNull(),
  },
  (t) => [primaryKey({ columns: [t.actorPrincipalId, t.key] })],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: text().primaryKey(),
    tenantId: text().notNull(),
    seq: bigint({ mode: "number" }).notNull(),
    actorPrincipalId: text().notNull(),
    action: text().notNull(),
    resourceType: text().notNull(),
    resourceId: text().notNull(),
    projectId: text(),
    before: jsonb(),
    after: jsonb(),
    policy: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    outcome: text().$type<"allowed" | "denied">().notNull(),
    traceId: text().notNull(),
    prevHash: text().notNull(),
    hash: text().notNull(),
    createdAt: ts().notNull(),
  },
  (t) => [uniqueIndex("audit_tenant_seq_uq").on(t.tenantId, t.seq), index("audit_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

export const auditAnchor = pgTable("audit_anchor", {
  id: text().primaryKey(),
  tenantId: text().notNull(),
  seq: bigint({ mode: "number" }).notNull(),
  hash: text().notNull(),
  exportedTo: text(),
  createdAt: createdAt(),
});

export const rateLimit = pgTable("rate_limit", {
  key: text().primaryKey(),
  count: integer().notNull(),
  windowStart: ts().notNull(),
});

/* local SCM provider (provider=local only) */
export const localScmIssue = pgTable("local_scm_issue", {
  id: text().primaryKey(),
  repoPath: text().notNull(),
  iid: integer().notNull(),
  title: text().notNull(),
  description: text().notNull().default(""),
  state: text().$type<"opened" | "closed">().notNull().default("opened"),
  labels: jsonb().$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export const localScmMr = pgTable("local_scm_mr", {
  id: text().primaryKey(),
  repoPath: text().notNull(),
  iid: integer().notNull(),
  sourceBranch: text().notNull(),
  targetBranch: text().notNull(),
  title: text().notNull(),
  description: text().notNull().default(""),
  state: text().$type<"opened" | "merged" | "closed">().notNull().default("opened"),
  mergeCommit: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export const localScmNote = pgTable("local_scm_note", {
  id: text().primaryKey(),
  repoPath: text().notNull(),
  targetType: text().$type<"issue" | "mr">().notNull(),
  targetIid: integer().notNull(),
  body: text().notNull(),
  author: text().notNull(),
  createdAt: createdAt(),
});
export const localScmPipeline = pgTable("local_scm_pipeline", {
  id: text().primaryKey(),
  repoPath: text().notNull(),
  sha: text().notNull(),
  ref: text().notNull(),
  status: text().$type<"running" | "success" | "failed" | "canceled">().notNull(),
  log: text(),
  createdAt: createdAt(),
  finishedAt: ts(),
});
