import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

/** Humans get initials on teal; agents get a bot glyph on violet — visually distinct everywhere (§13.3). */
export function PrincipalAvatar({ name, kind, size = "md", className }: { name: string; kind: string; size?: "sm" | "md"; className?: string }) {
  const s = size === "sm" ? "size-6 text-[10px]" : "size-8 text-xs";
  if (kind === "agent")
    return (
      <span className={cn("grid shrink-0 place-items-center rounded-md bg-agent-soft text-agent ring-1 ring-agent/25", s, className)} title={name} aria-label={`Agent ${name}`}>
        <Bot className={size === "sm" ? "size-3.5" : "size-4"} aria-hidden />
      </span>
    );
  if (kind === "system")
    return (
      <span className={cn("grid shrink-0 place-items-center rounded-full bg-muted text-muted-foreground", s, className)} aria-label="系统">
        ·
      </span>
    );
  return (
    <span className={cn("grid shrink-0 place-items-center rounded-full bg-accent font-medium text-accent-foreground", s, className)} title={name} aria-hidden>
      {name.slice(0, 1)}
    </span>
  );
}
