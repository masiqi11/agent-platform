import { estimateTokens, extractFirstJson, tokenize, parseTextToolCalls, type ParsedToolCall, type ProjectSettings } from "@ap/shared";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { Audit } from "../../core/audit";
import type { Ctx } from "../../core/context";
import type { Vault } from "../../core/crypto";
import { DomainError, invalid, notFound } from "../../core/errors";
import type { Events } from "../../core/events";
import { newId } from "../../core/ids";
import { log, redactValue } from "../../core/logger";
import type { Config } from "../../config";
import type { Database } from "../../db";
import { agent, budget, credential, llmCall, model, modelProvider, project, session, tenant } from "../../db/schema";
import type { Identity } from "../identity/service";
import { SCRIPTS, type ScriptReply } from "./scripts";

type ProviderRow = typeof modelProvider.$inferSelect;
type ModelRow = typeof model.$inferSelect;

/**
 * A conversation message. Agent loops send their earlier steps as native tool messages: an
 * assistant message with `toolCalls`, then one `tool` message per call (its raw JSON result).
 * Replaying them as text taught strong models to write tool calls as text instead of calling them.
 */
export type ChatMsg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }
  | { role: "tool"; content: string; toolCallId: string; name: string };

const wrapUntrusted = (body: string) => `<untrusted source="tool">\n${body.replace(/<\/?untrusted/gi, "‹untrusted")}\n</untrusted>`;

/** Text rendering of tool history, for scripted models and models without native tool support. */
export function textHistory(messages: ChatMsg[]): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const out: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  let results: string[] = []; // the current step's results share one untrusted block
  const flush = () => {
    if (results.length) out.push({ role: "user", content: wrapUntrusted(results.join("\n")) });
    results = [];
  };
  for (const m of messages) {
    if (m.role === "tool") {
      results.push(`<tool_result name="${m.name}">${m.content}</tool_result>`);
      continue;
    }
    flush();
    if (m.role === "assistant" && m.toolCalls?.length)
      out.push({ role: "assistant", content: `${m.content}\n<tool_calls>${JSON.stringify(m.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })))}</tool_calls>` });
    else out.push({ role: m.role, content: m.content });
  }
  flush();
  return out;
}

/** Drops the oldest step of an agent transcript: one message and the tool results that answer it. */
export function dropOldestStep(convo: ChatMsg[]) {
  convo.shift();
  while (convo[0]?.role === "tool") convo.shift();
}

/** OpenAI-compatible wire format. */
function openAiMessages(messages: ChatMsg[]) {
  return messages.map((m) =>
    m.role === "tool"
      ? { role: "tool", tool_call_id: m.toolCallId, content: wrapUntrusted(m.content) }
      : m.role === "assistant" && m.toolCalls?.length
        ? { role: "assistant", content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
        : { role: m.role, content: m.content },
  );
}

/** Ollama /api/chat wire format. */
function ollamaMessages(messages: ChatMsg[]) {
  return messages.map((m) =>
    m.role === "tool"
      ? { role: "tool", tool_name: m.name, content: wrapUntrusted(m.content) }
      : m.role === "assistant" && m.toolCalls?.length
        ? { role: "assistant", content: m.content, tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) }
        : { role: m.role, content: m.content },
  );
}
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface LlmScope {
  projectId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
}
export interface CompleteInput {
  purpose: string;
  promptVersion: string;
  scope: LlmScope;
  messages: ChatMsg[];
  tools?: ToolSpec[];
  json?: boolean;
  /** Returns an error string when the parsed JSON is invalid (structured output, LLM-04). */
  validate?: (v: unknown) => string | null;
  modelPolicy?: { primary?: string; fallback?: string; temperature?: number; maxTokens?: number };
  /** Data classes leaving the box (LLM-11), e.g. ["chat"], ["code"]. */
  dataClasses?: string[];
  onDelta?: (delta: string) => void;
}
export interface CompleteResult {
  content: string;
  toolCalls: ParsedToolCall[];
  toolMode: "native" | "text" | "none";
  json?: unknown;
  valid: boolean;
  repaired: boolean;
  model: string;
  providerId: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  latencyMs: number;
  usedFallback: boolean;
}

class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly kind: "timeout" | "server" | "client" | "refused" | "network" = "server",
  ) {
    super(message);
  }
}

export class BudgetExceeded extends DomainError {
  constructor(
    readonly scopeType: string,
    readonly scopeId: string,
  ) {
    super("budget_exceeded", "预算已用尽，Agent 已暂停", { scopeType, scopeId });
  }
}
export class LlmUnavailable extends DomainError {
  constructor(reason: string) {
    super("upstream_unavailable", `模型不可用：${reason}`);
  }
}

interface RawReply {
  content: string;
  toolCalls: ParsedToolCall[];
  tokensIn?: number;
  tokensOut?: number;
}

/** Vector column dimension (§8.7): other dimensions need a new index version, not supported in place. */
export const EMBED_DIM = 768;
export const SCRIPTED_EMBED_MODEL = "scripted:embed";

/**
 * Asymmetric retrieval models need a task prefix on each input; without it their recall drops
 * noticeably. Known families only — anything else is embedded as-is.
 */
export function embedPrefix(modelName: string, kind: "query" | "document"): string {
  const n = modelName.toLowerCase();
  if (n.includes("nomic-embed")) return kind === "query" ? "search_query: " : "search_document: ";
  if (n.includes("embeddinggemma")) return kind === "query" ? "task: search result | query: " : "title: none | text: ";
  if (n.includes("mxbai-embed")) return kind === "query" ? "Represent this sentence for searching relevant passages: " : "";
  if (/\be5\b|multilingual-e5/.test(n)) return kind === "query" ? "query: " : "passage: ";
  return "";
}

/** Deterministic "embedding" for CI: hashed bag of tokens (incl. CJK bigrams), L2-normalised. */
export function hashEmbed(text: string): number[] {
  const v = Array.from({ length: EMBED_DIM }, () => 0);
  for (const tok of tokenize(text)) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
    v[(h >>> 0) % EMBED_DIM]! += 1;
  }
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / n);
}

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;

export interface LlmOptions {
  timeoutMs?: number;
  firstByteMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  fetch?: typeof fetch;
}

/**
 * Model gateway (§12.11): routing + fallback, timeouts, retries with jitter, per-provider circuit
 * breaker, structured output with one repair pass, text tool-call parsing, atomic budget
 * reserve/settle, metering, outbound redaction and data-egress control.
 */
/** Wire APIs the harness proxy serves (ADR-0010). */
export type HarnessApi = "chat" | "responses" | "messages";

const supportsApi = (p: ProviderRow, api: HarnessApi) => (p.dialect === "ollama" ? api === "chat" : (p.apis ?? ["chat"]).includes(api));

/** Upstream URL for an API on a provider: OpenAI-style bases end in /v1; Ollama serves /v1 itself. */
export function upstreamUrl(p: Pick<ProviderRow, "baseUrl" | "dialect">, api: HarnessApi): string {
  const base = p.baseUrl.replace(/\/$/, "");
  const v1 = p.dialect === "ollama" ? `${base}/v1` : base.endsWith("/v1") ? base : `${base}/v1`;
  return `${v1}/${api === "chat" ? "chat/completions" : api}`;
}

function upstreamHeaders(api: HarnessApi, key: string | undefined, incoming: Headers): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (api === "messages") {
    h["anthropic-version"] = incoming.get("anthropic-version") ?? "2023-06-01";
    const beta = incoming.get("anthropic-beta");
    if (beta) h["anthropic-beta"] = beta;
    if (key) h["x-api-key"] = key;
  } else if (key) h.authorization = `Bearer ${key}`;
  const accept = incoming.get("accept");
  if (accept) h.accept = accept;
  return h;
}

/** Usage from a response body or one streamed event, per API. */
export function usageOf(api: HarnessApi, j: Record<string, unknown>): { tin?: number; tout?: number } {
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  if (api === "chat") {
    const u = j.usage as Record<string, unknown> | undefined;
    return u ? { tin: num(u.prompt_tokens), tout: num(u.completion_tokens) } : {};
  }
  if (api === "responses") {
    const u = ((j.response as Record<string, unknown> | undefined)?.usage ?? j.usage) as Record<string, unknown> | undefined;
    return u ? { tin: num(u.input_tokens), tout: num(u.output_tokens) } : {};
  }
  // Anthropic: message_start carries input usage, message_delta the running output count.
  const u = ((j.message as Record<string, unknown> | undefined)?.usage ?? j.usage) as Record<string, unknown> | undefined;
  if (!u) return {};
  const tin = num(u.input_tokens);
  return { tin: tin === undefined ? undefined : tin + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0), tout: num(u.output_tokens) };
}

/** Outbound redaction (LLM-10) over every string in a request body. */
function redactDeep(v: unknown): unknown {
  if (typeof v === "string") return redactValue(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

const jsonError = (status: number, message: string) => Response.json({ error: { type: "platform_proxy_error", message } }, { status });

/**
 * Rebuilds an OpenAI chat completion as the stream a client asked for: one content chunk, one
 * complete chunk per tool call (index = position), then finish + usage and [DONE].
 */
export function chatCompletionAsSse(j: Record<string, unknown>): string {
  const ch = ((j.choices as unknown[]) ?? [])[0] as
    | { message?: { role?: string; content?: string | null; reasoning_content?: string; tool_calls?: Array<Record<string, unknown>> }; finish_reason?: string }
    | undefined;
  const msg = ch?.message ?? {};
  const base = { id: j.id ?? "chatcmpl-proxy", object: "chat.completion.chunk", created: j.created ?? Math.floor(Date.now() / 1000), model: j.model };
  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null, ...extra }] })}\n\n`;
  let out = chunk({ role: "assistant", content: "" });
  if (msg.reasoning_content) out += chunk({ reasoning_content: msg.reasoning_content });
  if (msg.content) out += chunk({ content: msg.content });
  for (const [i, tc] of (msg.tool_calls ?? []).entries()) out += chunk({ tool_calls: [{ index: i, ...tc }] });
  out += `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: ch?.finish_reason ?? "stop" }], ...(j.usage ? { usage: j.usage } : {}) })}\n\n`;
  return `${out}data: [DONE]\n\n`;
}

export function createLlm(d: { config: Config; db: Database; audit: Audit; events: Events; identity: Identity; vault: Vault }, opts: LlmOptions = {}) {
  const { db } = d;
  const timeoutMs = opts.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? 180_000);
  const firstByteMs = opts.firstByteMs ?? Number(process.env.LLM_FIRST_BYTE_MS ?? 120_000);
  const maxRetries = opts.maxRetries ?? 3;
  const backoffMs = opts.backoffMs ?? Number(process.env.LLM_BACKOFF_MS ?? 400);
  const doFetch = opts.fetch ?? fetch;

  /* ───────────── registry ───────────── */

  /** Seeds the scripted provider (always) and the env bootstrap provider (if configured). Idempotent. */
  async function ensureDefaults(tenantId: string) {
    const existing = await db.root.select().from(modelProvider).where(eq(modelProvider.tenantId, tenantId));
    if (!existing.some((p) => p.kind === "scripted")) {
      const pid = newId("mpv");
      await db.root.insert(modelProvider).values({ id: pid, tenantId, name: "脚本模型（演示 / CI）", baseUrl: "scripted://", kind: "scripted", dialect: "openai", isExternal: false });
      for (const s of Object.keys(SCRIPTS))
        await db.root.insert(model).values({
          id: newId("mdl"),
          tenantId,
          providerId: pid,
          name: `scripted:${s}`,
          contextWindow: 8192,
          supportsTools: true,
          supportsJson: true,
          inputPrice: 0,
          outputPrice: 0,
          notes: "确定性脚本模型",
        });
    }
    // S7: deterministic embedding model for CI / demos (768-d to match the vector column, §8.7).
    const [sp] = await db.root
      .select()
      .from(modelProvider)
      .where(and(eq(modelProvider.tenantId, tenantId), eq(modelProvider.kind, "scripted")));
    if (sp && !(await findModel(tenantId, SCRIPTED_EMBED_MODEL)))
      await db.root.insert(model).values({
        id: newId("mdl"),
        tenantId,
        providerId: sp.id,
        name: SCRIPTED_EMBED_MODEL,
        contextWindow: 8192,
        embeddingDim: EMBED_DIM,
        inputPrice: 0,
        outputPrice: 0,
        notes: "确定性嵌入（哈希词袋）",
      });
    const boot = d.config.llmBootstrap;
    if (boot && !existing.some((p) => p.kind === "openai_compatible" && p.baseUrl === boot.baseUrl)) {
      const ollama = /11434/.test(boot.baseUrl) || process.env.LLM_DIALECT === "ollama";
      const local = /127\.0\.0\.1|localhost|11434/.test(boot.baseUrl);
      const pid = newId("mpv");
      let credentialId: string | null = null;
      if (boot.apiKey) {
        const enc = d.vault.encrypt(boot.apiKey);
        credentialId = newId("cred");
        await db.root
          .insert(credential)
          .values({ id: credentialId, tenantId, kind: "llm", name: "LLM 启动密钥", ciphertext: enc.ciphertext, keyVersion: enc.keyVersion, last4: boot.apiKey.slice(-4) });
      }
      await db.root.insert(modelProvider).values({
        id: pid,
        tenantId,
        name: ollama ? "本地 Ollama" : "OpenAI 兼容端点",
        baseUrl: boot.baseUrl.replace(/\/v1\/?$/, ollama ? "" : "/v1"),
        kind: "openai_compatible",
        dialect: ollama ? "ollama" : "openai",
        isExternal: !local,
        apis: boot.apis?.length ? boot.apis : ["chat"],
        credentialId,
      });
      // ADR-0003: gemma4:e2b think:false — tools + JSON ok, 8k context.
      await db.root.insert(model).values({
        id: newId("mdl"),
        tenantId,
        providerId: pid,
        name: boot.model,
        contextWindow: 8192,
        supportsTools: true,
        supportsJson: true,
        thinkOff: true,
        inputPrice: 0,
        outputPrice: 0,
        notes: "环境变量引导",
      });
      if (boot.embeddingModel)
        await db.root.insert(model).values({
          id: newId("mdl"),
          tenantId,
          providerId: pid,
          name: boot.embeddingModel,
          contextWindow: 8192,
          embeddingDim: EMBED_DIM,
          inputPrice: 0,
          outputPrice: 0,
          notes: "环境变量引导（嵌入）",
        });
    }
  }

  async function tenantSettings(tenantId: string) {
    const [t] = await db.root.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
    return (t?.settings ?? {}) as { defaultModel?: string; agentsPaused?: boolean; embeddingModel?: string | null };
  }

  async function findModel(tenantId: string, name: string) {
    const [r] = await db.root
      .select({ m: model, p: modelProvider })
      .from(model)
      .innerJoin(modelProvider, eq(model.providerId, modelProvider.id))
      .where(and(eq(model.tenantId, tenantId), eq(model.name, name)))
      .orderBy(desc(model.createdAt))
      .limit(1);
    return r ?? null;
  }

  /** Default model: tenant setting → env bootstrap model → scripted demo. */
  async function defaultModelName(tenantId: string) {
    const s = await tenantSettings(tenantId);
    return s.defaultModel ?? d.config.llmBootstrap?.model ?? "scripted:demo";
  }

  async function candidates(tenantId: string, policy: CompleteInput["modelPolicy"]) {
    const names = [policy?.primary ?? (await defaultModelName(tenantId)), policy?.fallback].filter((x): x is string => Boolean(x));
    const out: Array<{ m: ModelRow; p: ProviderRow }> = [];
    for (const n of new Set(names)) {
      const r = await findModel(tenantId, n);
      if (r && r.p.status === "active") out.push(r);
    }
    return out;
  }

  /* ───────────── egress (LLM-11) ───────────── */

  async function egressAllowed(projectId: string | null | undefined, p: ProviderRow): Promise<string | null> {
    if (!projectId) return null;
    const [pr] = await db.root.select({ settings: project.settings }).from(project).where(eq(project.id, projectId));
    const s = (pr?.settings ?? {}) as Partial<ProjectSettings>;
    if (s.localModelsOnly && p.isExternal) return "项目只允许本地模型";
    if (s.allowedProviderIds && s.allowedProviderIds.length && !s.allowedProviderIds.includes(p.id)) return "供应商不在项目白名单";
    return null;
  }

  /* ───────────── circuit breaker (LLM-06) ───────────── */

  function circuitOpen(p: ProviderRow): boolean {
    const c = p.circuitState;
    if (c.state !== "open") return false;
    return Date.now() - new Date(c.openedAt ?? 0).getTime() < CIRCUIT_COOLDOWN_MS; // after cooldown: half-open trial
  }
  async function recordOutcome(p: ProviderRow, ok: boolean) {
    const [cur] = await db.root.select({ c: modelProvider.circuitState }).from(modelProvider).where(eq(modelProvider.id, p.id));
    const c = cur?.c ?? { state: "closed" as const, failures: 0 };
    let next: ProviderRow["circuitState"];
    if (ok) next = { state: "closed", failures: 0 };
    else {
      const failures = c.failures + 1;
      next = failures >= CIRCUIT_THRESHOLD || c.state === "open" ? { state: "open", failures, openedAt: new Date().toISOString() } : { state: "closed", failures };
      if (next.state === "open" && c.state !== "open") log.warn("llm.circuit_open", { providerId: p.id });
    }
    if (next.state !== c.state || next.failures !== c.failures) await db.root.update(modelProvider).set({ circuitState: next, updatedAt: new Date() }).where(eq(modelProvider.id, p.id));
  }

  /* ───────────── budget (LLM-08, INV-19) ───────────── */

  async function budgetRows(tenantId: string, scope: LlmScope) {
    const keys: Array<[string, string]> = [["tenant", tenantId]];
    if (scope.projectId) keys.push(["project", scope.projectId]);
    if (scope.taskId) keys.push(["task", scope.taskId]);
    const rows = [];
    for (const [t, id] of keys) {
      const [r] = await db.root
        .select()
        .from(budget)
        .where(and(eq(budget.tenantId, tenantId), eq(budget.scopeType, t as "tenant"), eq(budget.scopeId, id), eq(budget.period, "total")));
      if (r) rows.push(r);
    }
    return rows;
  }

  /** Atomically reserves on every applicable budget row; all-or-nothing. */
  async function reserve(ctx: Ctx, scope: LlmScope, tokens: number, cost: number) {
    const rows = await budgetRows(ctx.tenantId, scope);
    const done: string[] = [];
    for (const r of rows) {
      const res = await db.root.execute<{ id: string }>(sql`
        update budget set reserved_tokens = reserved_tokens + ${tokens}, reserved_cost = reserved_cost + ${cost}, updated_at = now()
        where id = ${r.id} and status = 'ok'
          and (limit_tokens is null or used_tokens + reserved_tokens + ${tokens} <= limit_tokens)
          and (limit_cost is null or used_cost + reserved_cost + ${cost} <= limit_cost)
        returning id`);
      if (!(res as unknown as { rows: unknown[] }).rows.length) {
        for (const id of done) await release(id, tokens, cost, 0, 0);
        await db.root.update(budget).set({ status: "exceeded", updatedAt: new Date() }).where(eq(budget.id, r.id));
        await d.events.emit(ctx, {
          type: "budget.exceeded",
          aggregateType: r.scopeType === "task" ? "task" : r.scopeType === "project" ? "project" : "tenant",
          aggregateId: r.scopeId,
          payload: { budgetId: r.id, scopeType: r.scopeType, scopeId: r.scopeId, projectId: scope.projectId ?? null, taskId: scope.taskId ?? null },
        });
        throw new BudgetExceeded(r.scopeType, r.scopeId);
      }
      done.push(r.id);
    }
    return done;
  }
  async function release(id: string, rTokens: number, rCost: number, uTokens: number, uCost: number) {
    await db.root.execute(sql`
      update budget set reserved_tokens = greatest(0, reserved_tokens - ${rTokens}), reserved_cost = greatest(0, reserved_cost - ${rCost}),
        used_tokens = used_tokens + ${uTokens}, used_cost = used_cost + ${uCost}, updated_at = now()
      where id = ${id}`);
  }

  /** Checks without reserving (for pre-flight checks before starting a session). */
  async function budgetBlocked(tenantId: string, scope: LlmScope) {
    const rows = await budgetRows(tenantId, scope);
    return rows.find((r) => r.status === "exceeded" || (r.limitTokens != null && r.usedTokens >= r.limitTokens) || (r.limitCost != null && r.usedCost >= r.limitCost)) ?? null;
  }

  /* ───────────── adapters ───────────── */

  async function apiKeyFor(p: ProviderRow): Promise<string | undefined> {
    if (!p.credentialId) return undefined;
    const [c] = await db.root.select().from(credential).where(eq(credential.id, p.credentialId));
    if (!c) return undefined;
    await db.root.update(credential).set({ lastUsedAt: new Date(), lastUsedBy: "llm" }).where(eq(credential.id, c.id));
    return d.vault.decrypt(c.ciphertext, c.keyVersion);
  }

  async function withTimeout<T>(fn: (signal: AbortSignal, markFirstByte: () => void) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    let firstByte = false;
    const total = setTimeout(() => ac.abort(new ProviderError("总超时", true, "timeout")), timeoutMs);
    const fb = setTimeout(() => {
      if (!firstByte) ac.abort(new ProviderError("首字节超时", true, "timeout"));
    }, firstByteMs);
    try {
      return await fn(ac.signal, () => {
        firstByte = true;
        clearTimeout(fb);
      });
    } catch (e) {
      if (ac.signal.aborted) throw ac.signal.reason instanceof ProviderError ? ac.signal.reason : new ProviderError("超时", true, "timeout");
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(`网络错误：${(e as Error).message}`, true, "network");
    } finally {
      clearTimeout(total);
      clearTimeout(fb);
    }
  }

  function httpError(status: number, text: string) {
    return new ProviderError(`HTTP ${status}: ${text.slice(0, 200)}`, status === 429 || status >= 500, status >= 500 || status === 429 ? "server" : "client");
  }

  async function readLines(res: Response, onLine: (line: string) => void, markFirstByte: () => void) {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      markFirstByte();
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    }
    if (buf.trim()) onLine(buf.trim());
  }

  const toolDefs = (tools: ToolSpec[]) => tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

  async function callOllama(m: ModelRow, p: ProviderRow, key: string | undefined, req: CompleteInput): Promise<RawReply> {
    const stream = Boolean(req.onDelta) && m.supportsStreaming;
    const body: Record<string, unknown> = {
      model: m.name,
      messages: req.tools?.length && m.supportsTools ? ollamaMessages(req.messages) : textHistory(req.messages),
      stream,
      options: { temperature: req.modelPolicy?.temperature ?? 0.2, num_predict: req.modelPolicy?.maxTokens ?? 1024, num_ctx: m.contextWindow },
    };
    if (m.thinkOff) body.think = false;
    if (req.tools?.length && m.supportsTools) body.tools = toolDefs(req.tools);
    if (req.json && m.supportsJson && !req.tools?.length) body.format = "json";
    return withTimeout(async (signal, mark) => {
      const res = await doFetch(`${p.baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw httpError(res.status, await res.text());
      const out: RawReply = { content: "", toolCalls: [] };
      const take = (j: Record<string, unknown>) => {
        const msg = (j.message ?? {}) as { content?: string; tool_calls?: Array<{ function: { name: string; arguments: unknown } }> };
        if (msg.content) {
          out.content += msg.content;
          req.onDelta?.(msg.content);
        }
        for (const tc of msg.tool_calls ?? [])
          out.toolCalls.push({
            name: tc.function.name,
            arguments: (typeof tc.function.arguments === "string" ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : (tc.function.arguments as Record<string, unknown>)) ?? {},
          });
        if (typeof j.prompt_eval_count === "number") out.tokensIn = j.prompt_eval_count;
        if (typeof j.eval_count === "number") out.tokensOut = j.eval_count;
      };
      if (stream) await readLines(res, (l) => take(JSON.parse(l) as Record<string, unknown>), mark);
      else {
        mark();
        take((await res.json()) as Record<string, unknown>);
      }
      return out;
    });
  }

  async function callOpenAi(m: ModelRow, p: ProviderRow, key: string | undefined, req: CompleteInput): Promise<RawReply> {
    const stream = Boolean(req.onDelta) && m.supportsStreaming;
    const body: Record<string, unknown> = {
      model: m.name,
      messages: req.tools?.length && m.supportsTools ? openAiMessages(req.messages) : textHistory(req.messages),
      temperature: req.modelPolicy?.temperature ?? 0.2,
      max_tokens: req.modelPolicy?.maxTokens ?? 1024,
      stream,
    };
    if (req.tools?.length && m.supportsTools) body.tools = toolDefs(req.tools);
    if (req.json && m.supportsJson && !req.tools?.length) body.response_format = { type: "json_object" };
    if (stream) body.stream_options = { include_usage: true };
    let malformedStream = false;
    const reply = await withTimeout(async (signal, mark) => {
      const res = await doFetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw httpError(res.status, await res.text());
      const out: RawReply = { content: "", toolCalls: [] };
      // Keyed by tool-call id when the stream gives one: some gateways (seen on a Claude relay) send
      // every parallel call with index 0, so the index alone would glue their arguments together.
      const partial = new Map<string, { name: string; args: string }>();
      const openAt = new Map<number, string>();
      let refused = false;
      const take = (j: Record<string, unknown>, delta: boolean) => {
        const ch = ((j.choices as unknown[]) ?? [])[0] as Record<string, unknown> | undefined;
        if (ch?.finish_reason === "content_filter") refused = true;
        const msg = (delta ? ch?.delta : ch?.message) as { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } | undefined;
        if (msg?.content) {
          out.content += msg.content;
          if (delta) req.onDelta?.(msg.content);
        }
        for (const [i, tc] of (msg?.tool_calls ?? []).entries()) {
          const idx = tc.index ?? i;
          // A fragment with an id opens (or continues) that call; id-less fragments continue the call last opened at this index.
          const key = tc.id ?? openAt.get(idx) ?? `#${idx}`;
          openAt.set(idx, key);
          let cur = partial.get(key);
          if (!cur) partial.set(key, (cur = { name: "", args: "" }));
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
        }
        const u = j.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
        if (u) {
          out.tokensIn = u.prompt_tokens;
          out.tokensOut = u.completion_tokens;
        }
      };
      if (stream)
        await readLines(
          res,
          (l) => {
            // SSE: only `data:` lines carry chunks; `: ping` comments, `event:`, `id:`, `retry:` are skipped.
            if (!l.startsWith("data:")) return;
            const data = l.slice(5).trim();
            if (data && data !== "[DONE]") take(JSON.parse(data) as Record<string, unknown>, true);
          },
          mark,
        );
      else {
        mark();
        take((await res.json()) as Record<string, unknown>, false);
      }
      if (refused) throw new ProviderError("模型拒答（content_filter）", false, "refused");
      for (const pc of partial.values()) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(pc.args || "{}") as Record<string, unknown>;
        } catch {
          // Malformed args → empty; tool validation rejects the call and the caller's fallback applies.
          log.warn("llm.tool_args_malformed", { model: m.name, tool: pc.name, length: pc.args.length, stream });
          if (stream) malformedStream = true;
        }
        if (pc.name) out.toolCalls.push({ name: pc.name, arguments: args });
      }
      return out;
    });
    // Some gateways mislabel parallel tool-call fragments when streaming (all arguments under one
    // index, interleaved), which no client can reassemble. The same request without streaming is
    // correct there, so retry once that way; the streamed text was only a live preview.
    if (malformedStream) return callOpenAi(m, p, key, { ...req, onDelta: undefined });
    return reply;
  }

  async function callScripted(m: ModelRow, req: CompleteInput): Promise<RawReply> {
    const name = m.name.replace(/^scripted:/, "");
    const script = SCRIPTS[name];
    if (!script) throw new ProviderError(`未知脚本 ${name}`, false, "client");
    const r: ScriptReply = script({ purpose: req.purpose, messages: textHistory(req.messages), toolNames: (req.tools ?? []).map((t) => t.name), json: Boolean(req.json) });
    if (r.fail === "timeout") throw new ProviderError("脚本模拟超时", true, "timeout");
    if (r.fail === "server_error") throw new ProviderError("脚本模拟 500", true, "server");
    if (r.fail === "refused") throw new ProviderError("脚本模拟拒答", false, "refused");
    if (req.onDelta) for (const chunk of r.content.match(/[\s\S]{1,12}/g) ?? []) req.onDelta(chunk);
    return { content: r.content, toolCalls: r.toolCalls ?? [] };
  }

  async function rawCall(m: ModelRow, p: ProviderRow, req: CompleteInput): Promise<RawReply> {
    if (p.kind === "scripted") return callScripted(m, req);
    const key = await apiKeyFor(p);
    return p.dialect === "ollama" ? callOllama(m, p, key, req) : callOpenAi(m, p, key, req);
  }

  /* ───────────── main entry ───────────── */

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function meter(ctx: Ctx, input: CompleteInput, row: Partial<typeof llmCall.$inferInsert> & { model: string; status: string }) {
    const id = newId("llm");
    await db.root.insert(llmCall).values({
      id,
      tenantId: ctx.tenantId,
      projectId: input.scope.projectId ?? null,
      taskId: input.scope.taskId ?? null,
      sessionId: input.scope.sessionId ?? null,
      agentId: input.scope.agentId ?? null,
      purpose: input.purpose,
      promptVersion: input.promptVersion,
      traceId: ctx.traceId,
      ...row,
    });
    return id;
  }

  /** One provider attempt including retries; throws ProviderError when exhausted. */
  async function attempt(ctx: Ctx, input: CompleteInput, m: ModelRow, p: ProviderRow, messages: ChatMsg[], fallbackFrom: string | null, dataClasses: string[]) {
    const estIn = messages.reduce((n, x) => n + estimateTokens(x.content), 0);
    const estOut = input.modelPolicy?.maxTokens ?? 1024;
    const price = (tin: number, tout: number) => ((m.inputPrice ?? 0) * tin + (m.outputPrice ?? 0) * tout) / 1_000_000;
    const reserved = await reserve(ctx, input.scope, estIn + estOut, price(estIn, estOut));
    let lastErr: ProviderError | null = null;
    for (let i = 0; i <= maxRetries; i++) {
      const t0 = Date.now();
      try {
        const r = await rawCall(m, p, { ...input, messages });
        const tin = r.tokensIn ?? estIn;
        const tout = r.tokensOut ?? estimateTokens(r.content + JSON.stringify(r.toolCalls));
        const cost = price(tin, tout);
        for (const id of reserved) await release(id, estIn + estOut, price(estIn, estOut), tin + tout, cost);
        await recordOutcome(p, true);
        const latencyMs = Date.now() - t0;
        const callId = await meter(ctx, input, {
          model: m.name,
          providerId: p.id,
          tokensIn: tin,
          tokensOut: tout,
          cost,
          latencyMs,
          status: "ok",
          fallbackFrom,
          dataClasses,
          usedFallback: Boolean(fallbackFrom),
        });
        return { r, tin, tout, cost, latencyMs, callId };
      } catch (e) {
        lastErr = e instanceof ProviderError ? e : new ProviderError((e as Error).message, false, "client");
        await meter(ctx, input, { model: m.name, providerId: p.id, latencyMs: Date.now() - t0, status: "error", error: lastErr.message.slice(0, 300), fallbackFrom, dataClasses });
        if (!lastErr.retryable || i === maxRetries) break;
        await sleep(backoffMs * 2 ** i * (0.5 + Math.random()));
      }
    }
    for (const id of reserved) await release(id, estIn + estOut, price(estIn, estOut), 0, 0);
    await recordOutcome(p, false);
    throw lastErr!;
  }

  function parseJson(content: string): unknown {
    try {
      return JSON.parse(content);
    } catch {
      return extractFirstJson(content);
    }
  }

  async function complete(ctx: Ctx, input: CompleteInput): Promise<CompleteResult> {
    await ensureDefaults(ctx.tenantId);
    const cands = await candidates(ctx.tenantId, input.modelPolicy);
    if (!cands.length) throw new LlmUnavailable("没有可用的模型配置");
    // Outbound redaction (LLM-10): secrets never leave, whatever the provider.
    const messages = input.messages.map((m) => ({ ...m, content: redactValue(m.content) }));
    const reasons: string[] = [];
    let prev: string | null = null;
    for (const { m, p } of cands) {
      const denied = await egressAllowed(input.scope.projectId, p);
      if (denied) {
        reasons.push(`${m.name}: ${denied}`);
        continue;
      }
      if (circuitOpen(p)) {
        reasons.push(`${m.name}: 熔断中`);
        continue;
      }
      const dataClasses = p.isExternal ? (input.dataClasses ?? ["chat"]) : [];
      try {
        const a = await attempt(ctx, input, m, p, messages, prev, dataClasses);
        let toolCalls = a.r.toolCalls;
        let toolMode: CompleteResult["toolMode"] = toolCalls.length ? "native" : "none";
        if (!toolCalls.length && input.tools?.length) {
          toolCalls = parseTextToolCalls(a.r.content);
          if (toolCalls.length) toolMode = "text";
        }
        let content = a.r.content;
        let json: unknown;
        let valid = true;
        let repaired = false;
        let { tin, tout, cost, latencyMs } = a;
        if (input.json || input.validate) {
          json = parseJson(content);
          let err = json === undefined ? "不是合法 JSON" : (input.validate?.(json) ?? null);
          if (err) {
            // One repair pass (LLM-04), then the caller's deterministic fallback.
            repaired = true;
            try {
              const fix = await attempt(
                ctx,
                { ...input, onDelta: undefined, purpose: `${input.purpose}.repair` },
                m,
                p,
                [...messages, { role: "assistant", content }, { role: "user", content: `上次输出不符合要求：${err}。只输出修正后的 JSON，不要任何解释。` }],
                prev,
                dataClasses,
              );
              content = fix.r.content;
              json = parseJson(content);
              err = json === undefined ? "不是合法 JSON" : (input.validate?.(json) ?? null);
              tin += fix.tin;
              tout += fix.tout;
              cost += fix.cost;
              latencyMs += fix.latencyMs;
            } catch {
              err = "修复调用失败";
            }
            valid = !err;
            if (!valid) json = undefined;
          }
        }
        if (toolMode !== "none" || repaired) {
          await db.root.update(llmCall).set({ toolMode, repaired }).where(eq(llmCall.id, a.callId));
        }
        return { content, toolCalls, toolMode, json, valid, repaired, model: m.name, providerId: p.id, tokensIn: tin, tokensOut: tout, cost, latencyMs, usedFallback: Boolean(prev) };
      } catch (e) {
        if (e instanceof BudgetExceeded) throw e;
        reasons.push(`${m.name}: ${(e as Error).message}`);
        prev = m.name;
      }
    }
    throw new LlmUnavailable(reasons.join("；"));
  }

  /* ───────────── admin ───────────── */

  async function listProviders(ctx: Ctx) {
    await d.identity.require(ctx, "credential.manage");
    await ensureDefaults(ctx.tenantId);
    const ps = await db.root.select().from(modelProvider).where(eq(modelProvider.tenantId, ctx.tenantId)).orderBy(asc(modelProvider.createdAt));
    const ms = await db.root.select().from(model).where(eq(model.tenantId, ctx.tenantId)).orderBy(asc(model.createdAt));
    const creds = await db.root.select({ id: credential.id, last4: credential.last4 }).from(credential).where(eq(credential.tenantId, ctx.tenantId));
    const def = await defaultModelName(ctx.tenantId);
    return {
      defaultModel: def,
      embeddingModel: await embeddingModelName(ctx.tenantId),
      providers: ps.map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        kind: p.kind,
        dialect: p.dialect,
        isExternal: p.isExternal,
        apis: p.apis,
        status: p.status,
        circuit: p.circuitState.state,
        keyLast4: creds.find((c) => c.id === p.credentialId)?.last4 ?? null,
        models: ms
          .filter((m) => m.providerId === p.id)
          .map((m) => ({
            id: m.id,
            name: m.name,
            contextWindow: m.contextWindow,
            supportsTools: m.supportsTools,
            supportsJson: m.supportsJson,
            thinkOff: m.thinkOff,
            tier: m.tier,
            inputPrice: m.inputPrice,
            outputPrice: m.outputPrice,
            embeddingDim: m.embeddingDim,
            notes: m.notes,
          })),
      })),
    };
  }

  async function createProvider(
    ctx: Ctx,
    input: {
      name: string;
      baseUrl: string;
      dialect: "openai" | "ollama";
      isExternal: boolean;
      apiKey?: string;
      /** Wire APIs the endpoint accepts (harness proxy); defaults to chat only. */
      apis?: Array<"chat" | "responses" | "messages">;
      models: Array<{
        name: string;
        contextWindow?: number;
        supportsTools?: boolean;
        supportsJson?: boolean;
        thinkOff?: boolean;
        tier?: "small" | "large";
        inputPrice?: number;
        outputPrice?: number;
        embeddingDim?: number;
      }>;
    },
  ) {
    await d.identity.require(ctx, "credential.manage");
    const badDim = input.models.find((m) => m.embeddingDim !== undefined && m.embeddingDim !== EMBED_DIM);
    if (badDim) throw invalid(`嵌入维度固定为 ${EMBED_DIM}（§8.7），${badDim.name} 为 ${badDim.embeddingDim}`, [{ path: "/models", message: "维度不符" }]);
    if (!/^https?:\/\//.test(input.baseUrl)) throw invalid("Base URL 需以 http(s):// 开头", [{ path: "/baseUrl", message: "格式不正确" }]);
    if (!input.models.length) throw invalid("至少登记一个模型", [{ path: "/models", message: "为空" }]);
    const pid = newId("mpv");
    let credentialId: string | null = null;
    await db.tx(async (q) => {
      if (input.apiKey) {
        const enc = d.vault.encrypt(input.apiKey);
        credentialId = newId("cred");
        await q
          .insert(credential)
          .values({ id: credentialId, tenantId: ctx.tenantId, kind: "llm", name: `${input.name} 密钥`, ciphertext: enc.ciphertext, keyVersion: enc.keyVersion, last4: input.apiKey.slice(-4) });
      }
      await q.insert(modelProvider).values({
        id: pid,
        tenantId: ctx.tenantId,
        name: input.name,
        baseUrl: input.baseUrl.replace(/\/$/, ""),
        kind: "openai_compatible",
        dialect: input.dialect,
        isExternal: input.isExternal,
        apis: input.apis?.length ? [...new Set(input.apis)] : ["chat"],
        credentialId,
      });
      for (const m of input.models)
        await q.insert(model).values({
          id: newId("mdl"),
          tenantId: ctx.tenantId,
          providerId: pid,
          name: m.name,
          contextWindow: m.contextWindow ?? 8192,
          supportsTools: m.supportsTools ?? false,
          supportsJson: m.supportsJson ?? false,
          thinkOff: m.thinkOff ?? false,
          tier: m.tier ?? "small",
          inputPrice: m.inputPrice ?? null,
          outputPrice: m.outputPrice ?? null,
          embeddingDim: m.embeddingDim ?? null,
        });
      await d.audit.write(ctx, {
        action: "model_provider.create",
        resourceType: "model_provider",
        resourceId: pid,
        after: { name: input.name, baseUrl: input.baseUrl, dialect: input.dialect, isExternal: input.isExternal, models: input.models.map((m) => m.name), hasKey: Boolean(input.apiKey) },
      });
    });
    return { id: pid };
  }

  /** Connectivity test (ADM-补3): one tiny call, measured, never billed to a project. */
  async function testProvider(ctx: Ctx, providerId: string) {
    await d.identity.require(ctx, "credential.manage");
    const [p] = await db.root
      .select()
      .from(modelProvider)
      .where(and(eq(modelProvider.id, providerId), eq(modelProvider.tenantId, ctx.tenantId)));
    if (!p) throw notFound("模型供应商");
    const [m] = await db.root.select().from(model).where(eq(model.providerId, p.id)).limit(1);
    if (!m) throw invalid("该供应商没有登记模型");
    const t0 = Date.now();
    try {
      // Embedding models cannot chat: test them with one embedding of the expected dimension.
      const sample = m.embeddingDim
        ? `${(await rawEmbed(m, p, ["连通性测试"]))[0]!.length} 维向量`
        : (await rawCall(m, p, { purpose: "admin.test", promptVersion: "test.v1", scope: {}, messages: [{ role: "user", content: "只回复 OK" }], modelPolicy: { maxTokens: 8 } })).content.slice(0, 40);
      await d.audit.write(ctx, { action: "model_provider.test", resourceType: "model_provider", resourceId: p.id, after: { ok: true, latencyMs: Date.now() - t0 } });
      return { ok: true, latencyMs: Date.now() - t0, sample };
    } catch (e) {
      await d.audit.write(ctx, { action: "model_provider.test", resourceType: "model_provider", resourceId: p.id, after: { ok: false } });
      return { ok: false, latencyMs: Date.now() - t0, error: redactValue((e as Error).message).slice(0, 200) };
    }
  }

  async function setDefaultModel(ctx: Ctx, name: string) {
    await d.identity.require(ctx, "tenant.settings");
    await ensureDefaults(ctx.tenantId);
    if (!(await findModel(ctx.tenantId, name))) throw invalid("模型未登记", [{ path: "/name", message: "不存在" }]);
    await db.root.execute(sql`update tenant set settings = settings || ${JSON.stringify({ defaultModel: name })}::jsonb, updated_at = now() where id = ${ctx.tenantId}`);
    await d.audit.write(ctx, { action: "tenant.default_model", resourceType: "tenant", resourceId: ctx.tenantId, after: { defaultModel: name } });
    return { defaultModel: name };
  }

  /**
   * Selects the tenant's embedding model (§8.7): it must be registered with dimension 768. `null`
   * turns the vector route off. Indexes built with another model are rebuilt (the caller enqueues it).
   */
  async function setEmbeddingModel(ctx: Ctx, name: string | null) {
    await d.identity.require(ctx, "tenant.settings");
    await ensureDefaults(ctx.tenantId);
    if (name !== null) {
      const r = await findModel(ctx.tenantId, name);
      if (!r) throw invalid("模型未登记", [{ path: "/name", message: "不存在" }]);
      if (r.m.embeddingDim !== EMBED_DIM) throw invalid(`不是 ${EMBED_DIM} 维的嵌入模型`, [{ path: "/name", message: "维度不符" }]);
    }
    const before = await embeddingModelName(ctx.tenantId);
    await db.root.execute(sql`update tenant set settings = settings || ${JSON.stringify({ embeddingModel: name })}::jsonb, updated_at = now() where id = ${ctx.tenantId}`);
    await d.audit.write(ctx, { action: "tenant.embedding_model", resourceType: "tenant", resourceId: ctx.tenantId, before: { embeddingModel: before }, after: { embeddingModel: name } });
    return { embeddingModel: name, changed: before !== name };
  }

  /* ───────────── budgets & usage (ADM-02) ───────────── */

  async function setBudget(ctx: Ctx, input: { scopeType: "tenant" | "project" | "task"; scopeId: string; limitTokens?: number | null; limitCost?: number | null }) {
    await d.identity.require(ctx, "tenant.settings");
    const [r] = await db.root
      .insert(budget)
      .values({ id: newId("bdg"), tenantId: ctx.tenantId, scopeType: input.scopeType, scopeId: input.scopeId, limitTokens: input.limitTokens ?? null, limitCost: input.limitCost ?? null })
      .onConflictDoUpdate({
        target: [budget.scopeType, budget.scopeId, budget.period],
        set: { limitTokens: input.limitTokens ?? null, limitCost: input.limitCost ?? null, status: "ok", updatedAt: new Date() },
      })
      .returning();
    await d.audit.write(ctx, { action: "budget.set", resourceType: "budget", resourceId: r!.id, after: input });
    return r!;
  }

  async function usage(ctx: Ctx, days = 7) {
    await d.identity.require(ctx, "tenant.settings");
    const since = new Date(Date.now() - days * 86400_000);
    const byModel = await db.root
      .select({
        model: llmCall.model,
        purpose: llmCall.purpose,
        calls: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where ${llmCall.status} <> 'ok')::int`,
        tokensIn: sql<number>`coalesce(sum(${llmCall.tokensIn}),0)::int`,
        tokensOut: sql<number>`coalesce(sum(${llmCall.tokensOut}),0)::int`,
        cost: sql<number>`coalesce(sum(${llmCall.cost}),0)::float`,
        avgLatencyMs: sql<number>`coalesce(avg(${llmCall.latencyMs}) filter (where ${llmCall.status} = 'ok'),0)::int`,
      })
      .from(llmCall)
      .where(and(eq(llmCall.tenantId, ctx.tenantId), gte(llmCall.createdAt, since)))
      .groupBy(llmCall.model, llmCall.purpose)
      .orderBy(desc(sql`count(*)`));
    const budgets = await db.root.select().from(budget).where(eq(budget.tenantId, ctx.tenantId));
    return {
      days,
      byModel,
      budgets: budgets.map((b) => ({
        id: b.id,
        scopeType: b.scopeType,
        scopeId: b.scopeId,
        limitTokens: b.limitTokens,
        limitCost: b.limitCost,
        usedTokens: b.usedTokens,
        usedCost: b.usedCost,
        reservedTokens: b.reservedTokens,
        status: b.status,
      })),
    };
  }

  /* ───────────── embeddings (S7, §8.7) ───────────── */

  /** Embedding model in effect: tenant setting → env bootstrap → none (vector route off, not an error). */
  async function embeddingModelName(tenantId: string): Promise<string | null> {
    const s = await tenantSettings(tenantId);
    if (s.embeddingModel === null) return null;
    return s.embeddingModel ?? d.config.llmBootstrap?.embeddingModel ?? null;
  }

  /**
   * Embeds texts with the tenant's embedding model. Returns null when none is configured, the
   * dimension does not match the vector column, or egress rules forbid the provider for the project.
   * Inputs are redacted first (LLM-10) and the call is metered (purpose "embed", OBS-补4).
   */
  async function rawEmbed(m: ModelRow, p: ProviderRow, input: string[]): Promise<number[][]> {
    if (p.kind === "scripted") return input.map(hashEmbed);
    const key = await apiKeyFor(p);
    const base = p.baseUrl.replace(/\/$/, "");
    const ollama = p.dialect === "ollama";
    const res = await doFetch(ollama ? `${base}/api/embed` : `${base}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: m.name, input }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status >= 500, "server");
    const body = (await res.json()) as { embeddings?: number[][]; data?: Array<{ embedding: number[] }> };
    const vectors = ollama ? (body.embeddings ?? []) : (body.data ?? []).map((x) => x.embedding);
    if (vectors.length !== input.length || vectors.some((v) => v.length !== EMBED_DIM)) throw new ProviderError(`嵌入维度或数量不符（返回 ${vectors[0]?.length ?? 0} 维）`, false, "client");
    return vectors;
  }

  async function embed(ctx: Ctx, texts: string[], scope: LlmScope = {}, kind: "query" | "document" = "document"): Promise<{ model: string; vectors: number[][] } | null> {
    await ensureDefaults(ctx.tenantId);
    const name = await embeddingModelName(ctx.tenantId);
    if (!name || !texts.length) return null;
    const r = await findModel(ctx.tenantId, name);
    if (!r || r.m.embeddingDim !== EMBED_DIM) return null;
    if (await egressAllowed(scope.projectId, r.p)) return null;
    const prefix = embedPrefix(r.m.name, kind);
    const input = texts.map((t) => prefix + redactValue(t).slice(0, 8000));
    const t0 = Date.now();
    let vectors: number[][];
    try {
      vectors = await rawEmbed(r.m, r.p, input);
      await meter(
        ctx,
        { purpose: "embed", promptVersion: "embed@1", scope, messages: [] },
        { model: r.m.name, providerId: r.p.id, tokensIn: input.reduce((n, x) => n + estimateTokens(x), 0), tokensOut: 0, cost: 0, latencyMs: Date.now() - t0, status: "ok", dataClasses: ["code"] },
      );
      return { model: r.m.name, vectors };
    } catch (e) {
      await meter(
        ctx,
        { purpose: "embed", promptVersion: "embed@1", scope, messages: [] },
        { model: r.m.name, providerId: r.p.id, latencyMs: Date.now() - t0, status: "error", error: (e as Error).message.slice(0, 300), dataClasses: ["code"] },
      );
      log.warn("llm.embed_failed", { err: (e as Error).message.slice(0, 200) });
      return null;
    }
  }

  /* ───────────── harness model proxy (ADR-0010) ───────────── */

  /** Proxy entry for an agent session token: the session gives budget scope, the agent its model policy. */
  async function proxyForAgent(ctx: Ctx, api: HarnessApi, body: Record<string, unknown>, headers: Headers): Promise<Response> {
    if (ctx.actor.kind !== "agent" || !ctx.actor.sessionId || !ctx.actor.agentId) return jsonError(403, "只接受 Agent 会话令牌");
    const [ses] = await db.root.select().from(session).where(eq(session.id, ctx.actor.sessionId));
    if (!ses || ses.agentId !== ctx.actor.agentId || !["running", "queued"].includes(ses.status)) return jsonError(403, "会话不存在或已结束");
    const [a] = await db.root.select().from(agent).where(eq(agent.id, ctx.actor.agentId));
    if (!a || a.status !== "active") return jsonError(403, "Agent 未启用");
    return proxy(ctx, api, {
      body,
      headers,
      policy: a.modelPolicy,
      purpose: `harness.${a.role}`,
      scope: { projectId: ses.projectId ?? undefined, taskId: ses.scopeType === "task" ? ses.scopeId : undefined, sessionId: ses.id, agentId: a.id },
    });
  }

  /**
   * Model proxy for external harnesses (Claude Code / Codex / OpenCode / pi). The harness speaks its
   * own wire API with a session token; the platform resolves the agent's model, checks egress and
   * the circuit, reserves budget, redacts, forwards to a provider that accepts the same API, and
   * meters from the upstream's own usage (streaming included). The real key never leaves.
   */
  async function proxy(
    ctx: Ctx,
    api: HarnessApi,
    input: { body: Record<string, unknown>; headers: Headers; scope: LlmScope; purpose: string; policy?: CompleteInput["modelPolicy"] },
  ): Promise<Response> {
    await ensureDefaults(ctx.tenantId);
    const cands = (await candidates(ctx.tenantId, input.policy)).filter((c) => c.p.kind === "openai_compatible" && supportsApi(c.p, api));
    if (!cands.length) return jsonError(400, `没有可用的模型：需要支持 ${api} 接口的供应商`);
    // Chat streams are fetched whole and re-streamed: relays interleave parallel tool-call fragments
    // under one index (ADR-0009 #2), which no client can untangle; their non-streamed answers are right.
    const synth = input.body.stream === true && api === "chat";
    const stream = input.body.stream === true && !synth;
    const body = redactDeep(input.body) as Record<string, unknown>;
    if (synth) {
      body.stream = false;
      delete body.stream_options;
    }
    const estIn = estimateTokens(JSON.stringify(body));
    const estOut = Number(body.max_tokens ?? body.max_output_tokens ?? 4096);
    const reasons: string[] = [];
    for (const { m, p } of cands) {
      const denied = await egressAllowed(input.scope.projectId, p);
      if (denied) {
        reasons.push(`${m.name}: ${denied}`);
        continue;
      }
      if (circuitOpen(p)) {
        reasons.push(`${m.name}: 熔断中`);
        continue;
      }
      const price = (tin: number, tout: number) => ((m.inputPrice ?? 0) * tin + (m.outputPrice ?? 0) * tout) / 1_000_000;
      let reserved: string[];
      try {
        reserved = await reserve(ctx, input.scope, estIn + estOut, price(estIn, estOut));
      } catch (e) {
        if (e instanceof BudgetExceeded) return jsonError(429, `预算已用尽（${e.message}）`);
        throw e;
      }
      const key = await apiKeyFor(p);
      const t0 = Date.now();
      const meta = { purpose: input.purpose, promptVersion: "harness@1", scope: input.scope, messages: [] } as CompleteInput;
      const settle = async (tin: number, tout: number, status: "ok" | "error", error?: string) => {
        for (const id of reserved) await release(id, estIn + estOut, price(estIn, estOut), tin + tout, price(tin, tout));
        await meter(ctx, meta, {
          model: m.name,
          providerId: p.id,
          tokensIn: tin,
          tokensOut: tout,
          cost: price(tin, tout),
          latencyMs: Date.now() - t0,
          status,
          ...(error ? { error } : {}),
          toolMode: "harness",
          dataClasses: p.isExternal ? ["code", "task"] : [],
        });
      };
      let res: Response;
      try {
        res = await doFetch(upstreamUrl(p, api), {
          method: "POST",
          headers: upstreamHeaders(api, key, input.headers),
          body: JSON.stringify({ ...body, model: m.name }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        await recordOutcome(p, false);
        await settle(0, 0, "error", redactValue((e as Error).message).slice(0, 300));
        reasons.push(`${m.name}: ${(e as Error).message}`);
        continue; // nothing reached the harness yet: the next candidate may serve it
      }
      if (!res.ok) {
        const text = await res.text();
        await recordOutcome(p, res.status < 500);
        await settle(0, 0, "error", `HTTP ${res.status}: ${redactValue(text).slice(0, 300)}`);
        if (res.status >= 500 && cands.at(-1)!.m.id !== m.id) {
          reasons.push(`${m.name}: HTTP ${res.status}`);
          continue;
        }
        return new Response(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
      }
      await recordOutcome(p, true);
      if (!stream || !res.body) {
        const json = (await res.json()) as Record<string, unknown>;
        const u = usageOf(api, json);
        await settle(u.tin ?? estIn, u.tout ?? 0, "ok");
        if (synth) return new Response(chatCompletionAsSse(json), { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
        return Response.json(json);
      }
      // Streaming: pass bytes through untouched, read usage from the SSE events on the way.
      const usage: { tin?: number; tout?: number } = {};
      const dec = new TextDecoder();
      let buf = "";
      const tap = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          ctl.enqueue(chunk);
          buf += dec.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const u = usageOf(api, JSON.parse(data) as Record<string, unknown>);
              if (u.tin !== undefined) usage.tin = u.tin;
              if (u.tout !== undefined) usage.tout = u.tout;
            } catch {
              /* not JSON: ignore */
            }
          }
        },
        async flush() {
          await settle(usage.tin ?? estIn, usage.tout ?? 0, "ok").catch((e) => log.warn("llm.proxy_settle_failed", { err: (e as Error).message }));
        },
      });
      return new Response(res.body.pipeThrough(tap), { status: 200, headers: { "content-type": res.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache" } });
    }
    return jsonError(503, `模型不可用：${reasons.join("；")}`);
  }

  return {
    proxy,
    proxyForAgent,
    embed,
    embeddingModelName,
    setEmbeddingModel,
    complete,
    defaultModelName,
    ensureDefaults,
    budgetBlocked,
    tenantSettings,
    listProviders,
    createProvider,
    testProvider,
    setDefaultModel,
    setBudget,
    usage,
    findModel,
  };
}
export type Llm = ReturnType<typeof createLlm>;
