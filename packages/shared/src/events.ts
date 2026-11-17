/** Event catalog (spec §11.2). Contract: payloads only gain fields, never change. Payloads carry ids only (INV-13). */
export const EVENT_TYPES = [
  "message.created",
  "message.updated",
  "message.deleted",
  "member.changed",
  "summary.updated",
  "decision.proposed",
  "decision.confirmed",
  "decision.rejected",
  "decision.revoked",
  "proposal.created",
  "proposal.updated",
  "proposal.decided",
  "task.created",
  "task.updated",
  "task.assigned",
  "task.status_changed",
  "task.transition_denied",
  "task.comment_added",
  "task.takeover",
  "wake.requested",
  "session.started",
  "session.completed",
  "session.interrupted",
  "session.failed",
  "workspace.created",
  "workspace.released",
  "session.cancelled",
  "commit.pushed",
  "mr.opened",
  "mr.updated",
  "pipeline.completed",
  "review.submitted",
  "test_run.started",
  "test_run.completed",
  "approval.requested",
  "approval.decided",
  "approval.invalidated",
  "gate.evaluated",
  "merge.queued",
  "merge.completed",
  "merge.failed",
  "release.recorded",
  "escalation.raised",
  "inbox.updated",
  "question.asked",
  "question.resolved",
  "budget.exceeded",
  "repo.bound",
  "repo.credential_invalid",
  "binding.created",
  "binding.invalidated",
  "project.created",
  "project.updated",
  "project.archived",
  "group.created",
  "thread.created",
  "agent.created",
  "agent.updated",
  "agents.paused",
  "user.created",
  "user.updated",
  "invitation.created",
  "invitation.accepted",
  "credential.changed",
  "index.updated",
  "issue.synced",
  // §1.3 metric "知识库回答带有效引用": counts only, never the answer (INV-13).
  "kb.answered",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type AggregateType =
  | "message"
  | "task"
  | "session"
  | "approval"
  | "binding"
  | "summary"
  | "decision"
  | "proposal"
  | "project"
  | "group"
  | "agent"
  | "user"
  | "tenant"
  | "repo"
  | "workspace"
  | "merge"
  | "index"
  | "invitation"
  | "credential"
  | "question";

export interface DomainEvent<T = Record<string, unknown>> {
  id: string;
  tenantId: string;
  type: EventType;
  aggregateType: AggregateType;
  aggregateId: string;
  actorPrincipalId: string;
  occurredAt: string;
  seq: number;
  payload: T;
  traceId: string;
  idempotencyKey?: string;
}

/** WS topics (§10.6). */
export type Topic = `project:${string}` | `group:${string}` | `task:${string}` | `inbox:${string}`;

export type WsClientFrame =
  | { type: "auth"; token: string }
  | { type: "subscribe"; topic: string; lastSeq?: number }
  | { type: "unsubscribe"; topic: string }
  | { type: "ack"; topic: string; seq: number }
  | { type: "ping" };

export type WsServerFrame =
  | { type: "ready"; principalId: string }
  | { type: "subscribed"; topic: string }
  | { type: "event"; topic: string; seq: number; event: { type: EventType; aggregateType: string; aggregateId: string; payload: Record<string, unknown> } }
  | { type: "resync"; topic: string }
  | { type: "stream"; topic: string; messageId: string; delta: string; done?: boolean }
  | { type: "error"; code: string; message: string }
  | { type: "unsubscribed"; topic: string; reason?: string }
  | { type: "pong" };
