import { redact } from "@ap/shared";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: Level = "info";
let exactSecrets: string[] = [];
const sink: { write: (line: string) => void } = { write: (l) => process.stdout.write(l + "\n") };

export function configureLogger(opts: { level?: Level; secrets?: string[]; write?: (line: string) => void }) {
  if (opts.level) minLevel = opts.level;
  if (opts.secrets) exactSecrets = opts.secrets.filter((s) => s && s.length >= 6);
  if (opts.write) sink.write = opts.write;
}
export function addRedactionValue(v: string) {
  if (v && v.length >= 6 && !exactSecrets.includes(v)) exactSecrets.push(v);
}
export function redactValue(s: string): string {
  return redact(s, exactSecrets);
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (ORDER[level] < ORDER[minLevel]) return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
  sink.write(redact(line, exactSecrets));
}

/** Structured JSON logger with redaction (§16.1). Never use console.log. */
export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};
