import { Bot, Sparkle } from "lucide-react";
import { cn } from "@/lib/utils";

/** Humans: initial on a light warm circle; agents: bot glyph on soft violet — distinct everywhere (§13.3). */
export function PrincipalAvatar({ name, kind, size = "md", className }: { name: string; kind: string; size?: "sm" | "md"; className?: string }) {
  const s = size === "sm" ? "size-6 text-[11px]" : "size-9 text-[13px]";
  if (kind === "agent")
    return (
      <span className={cn("grid shrink-0 place-items-center rounded-full bg-agent-soft text-agent", s, className)} title={name} role="img" aria-label={`Agent ${name}`}>
        <Bot className={size === "sm" ? "size-3.5" : "size-4"} aria-hidden />
      </span>
    );
  if (kind === "system")
    return (
      <span className={cn("grid shrink-0 place-items-center rounded-full bg-muted text-muted-foreground", s, className)} role="img" aria-label="系统">
        <Sparkle className={size === "sm" ? "size-3" : "size-3.5"} aria-hidden />
      </span>
    );
  return (
    <span className={cn("grid shrink-0 place-items-center rounded-full bg-avatar font-medium text-avatar-foreground", s, className)} title={name} aria-hidden>
      {name.slice(0, 1)}
    </span>
  );
}
