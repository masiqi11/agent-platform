import { Link } from "@tanstack/react-router";
import { AlertTriangle, Compass, Lock, RotateCcw, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** §13.4 page states. Every page uses these instead of ad-hoc spinners/blank screens. */

export function PageSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-3", className)} aria-busy="true" aria-label={t("state.loading")}>
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-4 w-80" />
      <div className="mt-6 space-y-2">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" style={{ opacity: 1 - i * 0.12 }} />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon = Compass, title, body, action }: { icon?: LucideIcon; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl bg-muted/45 px-6 py-14 text-center">
      <div className="mb-3 grid size-11 place-items-center rounded-full bg-card text-primary shadow-xs ring-1 ring-border">
        <Icon className="size-5" aria-hidden />
      </div>
      <p className="font-medium">{title}</p>
      {body ? <p className="mt-1 max-w-md text-sm text-muted-foreground">{body}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (error instanceof ApiError && error.status === 403) return <ForbiddenState required={error.required} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundState />;
  const e = error instanceof ApiError ? error : null;
  return (
    <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-5 py-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t("state.error")}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{e?.message ?? String((error as Error)?.message ?? error)}</p>
          {e?.traceId ? (
            <p className="mt-2 font-mono text-xs text-muted-foreground">
              {t("state.traceId")}：{e.traceId}
            </p>
          ) : null}
        </div>
        {onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RotateCcw className="size-3.5" /> {t("state.retry")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ForbiddenState({ required }: { required?: string }) {
  return (
    <CenterCard icon={Lock} title={t("state.forbidden.title")} body={t("state.forbidden.body", { required: required ?? "更高权限" })}>
      <Button asChild variant="outline">
        <Link to="/">{t("state.back")}</Link>
      </Button>
    </CenterCard>
  );
}

export function NotFoundState() {
  return (
    <CenterCard icon={Compass} title={t("state.notfound.title")} body={t("state.notfound.body")}>
      <Button asChild variant="outline">
        <Link to="/">{t("state.back")}</Link>
      </Button>
    </CenterCard>
  );
}

function CenterCard({ icon: Icon, title, body, children }: { icon: LucideIcon; title: string; body: string; children?: ReactNode }) {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-muted">
        <Icon className="size-6 text-muted-foreground" aria-hidden />
      </div>
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      <div className="mt-6">{children}</div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
