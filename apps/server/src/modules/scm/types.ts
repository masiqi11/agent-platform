/** SCM abstraction (§12.7): business code depends only on this interface. */

export type MrState = "opened" | "merged" | "closed";
export type PipelineStatus = "pending" | "running" | "success" | "failed" | "canceled";
export const TERMINAL_PIPELINE: readonly PipelineStatus[] = ["success", "failed", "canceled"];

export interface IssueInfo {
  iid: number;
  ref: string;
  url: string;
  state: "opened" | "closed";
  title: string;
  description: string;
  labels: string[];
}

export interface MrInfo {
  iid: number;
  ref: string;
  url: string;
  state: MrState;
  sourceBranch: string;
  targetBranch: string;
  mergeCommit?: string | null;
}

export interface PipelineInfo {
  id: string;
  sha: string;
  ref: string;
  status: PipelineStatus;
  url?: string;
}

export interface AccessCheck {
  ok: boolean;
  defaultBranch: string;
  defaultBranchProtected: boolean;
  canPush: boolean;
  warnings: string[];
  detail: string;
  /** Platform bot account on the SCM (used for loop-back suppression). */
  botUserId?: string;
}

export interface UpsertIssueInput {
  iid?: number | null;
  /** Stable marker label used to find an issue created by an earlier, interrupted attempt (convergent sync). */
  marker: string;
  title: string;
  description: string;
  labels: string[];
  state: "opened" | "closed";
}

export interface Scm {
  provider: "local" | "gitlab";
  /** Remote URL + per-call auth env for host git; `cleanup` removes one-shot askpass files. */
  gitRemote(): Promise<{ url: string; env: Record<string, string>; cleanup: () => Promise<void> }>;
  checkAccess(): Promise<AccessCheck>;
  isProtected(branch: string): Promise<boolean>;
  upsertIssue(input: UpsertIssueInput): Promise<IssueInfo>;
  getIssue(iid: number): Promise<IssueInfo | null>;
  /** Creates an MR or returns the open one for the same source branch (TRAP-9: 409 → reuse). */
  openMr(input: { sourceBranch: string; targetBranch: string; title: string; description: string }): Promise<MrInfo & { reused: boolean }>;
  getMr(iid: number): Promise<MrInfo | null>;
  closeMr(iid: number): Promise<void>;
  addNote(target: "issue" | "mr", iid: number, body: string): Promise<void>;
  latestPipeline(sha: string): Promise<PipelineInfo | null>;
}

/** Thrown when the SCM credential is rejected (401/403): the repo is marked credential_invalid. */
export class ScmAuthError extends Error {}
/** The credential is valid but lacks a specific right (e.g. merging into a protected branch): needs a human, the repo stays usable. */
export class ScmPermissionError extends Error {}
/** Merge/create not possible yet (TRAP-9: 405/406/422 after bounded retries). */
export class ScmNotReady extends Error {}
