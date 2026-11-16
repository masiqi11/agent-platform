/** Domain errors with a stable `code` (§10.2). Routes never throw bare strings. */
export type ErrorCode =
  | "invalid"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "illegal_transition"
  | "budget_exceeded"
  | "too_large"
  | "rate_limited"
  | "internal"
  | "upstream_unavailable";

const HTTP: Record<ErrorCode, number> = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  illegal_transition: 409,
  budget_exceeded: 409,
  too_large: 413,
  rate_limited: 429,
  internal: 500,
  upstream_unavailable: 502,
};

export class DomainError extends Error {
  readonly http: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.http = HTTP[code];
  }
}

export const notFound = (what = "资源") => new DomainError("not_found", `${what}不存在`);
export const forbidden = (required: string, message = "没有权限执行该操作") => new DomainError("forbidden", message, { required });
export const conflict = (message: string, details?: unknown) => new DomainError("conflict", message, details);
export const invalid = (message: string, details: Array<{ path: string; message: string }> = []) => new DomainError("invalid", message, details);
