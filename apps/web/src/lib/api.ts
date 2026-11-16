import { treaty } from "@elysia/eden";
import type { App } from "@ap/server";
import { session, sessionExpired } from "./session";

/** Typed API client (§13.5): every request goes through treaty<App>. */
export const api = treaty<App>(typeof window === "undefined" ? "http://localhost:3000" : window.location.origin, {
  headers: () => {
    const t = session.get();
    return t ? { authorization: `Bearer ${t}` } : {};
  },
});

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly traceId?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
  get required(): string | undefined {
    return (this.details as { required?: string } | undefined)?.required;
  }
}

type TreatyResult<T> = { data: T | null; error: { status: unknown; value: unknown } | null; status?: number; response?: Response };

/** Unwraps a treaty response; throws ApiError with the server's stable error shape (§10.2). */
export async function unwrap<T>(p: Promise<TreatyResult<T>>): Promise<T> {
  let r: TreatyResult<T>;
  try {
    r = await p;
  } catch {
    throw new ApiError(0, "network", "网络异常，无法连接服务器");
  }
  if (r.error) {
    const status = Number(r.error.status) || 0;
    const v = (r.error.value ?? {}) as { error?: string; message?: string; traceId?: string; details?: unknown };
    if (status === 401 && session.get()) sessionExpired.dispatchEvent(new Event("expired"));
    throw new ApiError(status, v.error ?? "internal", v.message ?? "请求失败", v.traceId ?? r.response?.headers.get("x-request-id") ?? undefined, v.details);
  }
  return r.data as T;
}

export const newIdempotencyKey = () => crypto.randomUUID();
