import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ArrowRight, KeyRound, Sparkles } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api, unwrap } from "@/lib/api";
import { t } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { realtime } from "@/lib/realtime";
import { session } from "@/lib/session";

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <div className="relative hidden overflow-hidden bg-sidebar lg:block">
        <div className="absolute inset-0 opacity-[0.55] [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:18px_18px]" aria-hidden />
        <div className="relative flex h-full flex-col justify-between p-10">
          <div className="flex items-center gap-2.5">
            <Logo className="size-8" />
            <span className="font-semibold">{t("app.name")}</span>
          </div>
          <div className="max-w-md">
            <p className="text-3xl font-semibold leading-snug tracking-tight">{t("app.tagline")}</p>
            <ul className="mt-8 space-y-4 text-sm text-muted-foreground">
              {[
                ["群聊即工作台", "船长 Agent 读懂讨论，给出带来源的摘要与任务提议。"],
                ["人拍板，Agent 执行", "合并、发布、预算等关键动作都需要人类审批。"],
                ["每一步可追溯", "审计日志哈希链防篡改，任何结论都能点回原始消息。"],
              ].map(([h, b]) => (
                <li key={h} className="flex gap-3">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-attention" aria-hidden />
                  <span>
                    <span className="font-medium text-foreground">{h}</span>　{b}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">自托管 · 数据不出内网</p>
        </div>
      </div>
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <Logo />
            <span className="font-semibold">{t("app.name")}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p> : null}
          <div className="mt-8">{children}</div>
        </div>
      </div>
    </div>
  );
}

function Field({ id, label, ...rest }: { id: string; label: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} {...rest} />
    </div>
  );
}

function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  const fieldMsgs = Array.isArray(e?.details) ? (e!.details as Array<{ path: string; message: string }>).map((d) => `${d.path.replace(/^\//, "")}：${d.message}`) : [];
  return (
    <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm">
      <p>{e?.status === 401 ? t("login.failed") : (e?.message ?? String(error))}</p>
      {fieldMsgs.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{fieldMsgs.slice(0, 3).join("；")}</p>}
      {e?.traceId && e.status >= 500 ? <p className="mt-1 font-mono text-xs text-muted-foreground">{t("state.traceId")}：{e.traceId}</p> : null}
    </div>
  );
}

function useSignedIn() {
  const navigate = useNavigate();
  return (token: string, redirect?: string) => {
    session.set(token);
    queryClient.clear();
    realtime.connect();
    void navigate({ to: redirect && redirect.startsWith("/") ? redirect : "/" });
  };
}

const formValues = (e: FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;

export function LoginPage() {
  const search = useSearch({ strict: false }) as { redirect?: string };
  const signedIn = useSignedIn();
  const navigate = useNavigate();
  const cfg = useQuery({ queryKey: qk.authConfig, queryFn: () => unwrap(api.api.v1.auth.config.get()) });
  const login = useMutation({
    mutationFn: (v: { email: string; password: string }) => unwrap(api.api.v1.auth["sign-in"].post(v)),
    onSuccess: (r) => signedIn(r.token, search.redirect),
  });
  const dev = useMutation({
    mutationFn: (email: string) => unwrap(api.api.v1.auth["dev-login"].post({ email })),
    onSuccess: (r) => signedIn(r.token, search.redirect),
  });
  useEffect(() => {
    if (cfg.data?.needsSetup) void navigate({ to: "/setup" });
  }, [cfg.data?.needsSetup, navigate]);
  return (
    <AuthLayout title={t("login.title")} subtitle="使用公司邮箱登录协作台">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const v = formValues(e);
          login.mutate({ email: v.email!, password: v.password! });
        }}
      >
        <Field id="email" label={t("login.email")} type="email" autoComplete="username" required autoFocus />
        <Field id="password" label={t("login.password")} type="password" autoComplete="current-password" required />
        <FormError error={login.error ?? dev.error} />
        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending ? "登录中…" : t("login.submit")} <ArrowRight className="size-4" />
        </Button>
      </form>
      {(cfg.data?.oidc || cfg.data?.devLogin) && (
        <div className="mt-6 space-y-2 border-t pt-6">
          {cfg.data?.oidc && (
            <Button variant="outline" className="w-full" asChild>
              <a href="/api/auth/sign-in/oauth2?providerId=oidc">
                <KeyRound className="size-4" /> {t("login.oidc")}
              </a>
            </Button>
          )}
          {cfg.data?.devLogin && (
            <div className="rounded-md border border-dashed p-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Sparkles className="size-3.5" /> {t("login.dev")}（仅开发环境）
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[
                  ["owner@demo.local", "负责人"],
                  ["dev@demo.local", "开发"],
                  ["auditor@demo.local", "审计"],
                ].map(([email, label]) => (
                  <Button key={email} size="sm" variant="secondary" disabled={dev.isPending} onClick={() => dev.mutate(email!)}>
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </AuthLayout>
  );
}

export function SetupPage() {
  const signedIn = useSignedIn();
  const m = useMutation({
    mutationFn: (v: Record<string, string>) => unwrap(api.api.v1.setup.post({ tenantName: v.tenantName!, email: v.email!, name: v.name!, password: v.password!, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })),
    onSuccess: (r) => signedIn(r.token),
  });
  return (
    <AuthLayout title={t("setup.title")} subtitle={t("setup.subtitle")}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate(formValues(e));
        }}
      >
        <Field id="tenantName" label={t("setup.tenant")} required autoFocus />
        <Field id="name" label={t("setup.name")} required />
        <Field id="email" label={t("login.email")} type="email" required />
        <Field id="password" label={`${t("login.password")}（至少 10 位）`} type="password" minLength={10} required autoComplete="new-password" />
        <FormError error={m.error} />
        <Button type="submit" className="w-full" disabled={m.isPending}>
          {t("setup.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}

export function InvitePage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const signedIn = useSignedIn();
  const m = useMutation({
    mutationFn: (v: Record<string, string>) => unwrap(api.api.v1.invitations({ token }).accept.post({ email: v.email!, name: v.name!, password: v.password! })),
    onSuccess: (r) => signedIn(r.token),
  });
  return (
    <AuthLayout title={t("invite.title")} subtitle="设置你的名字和密码，加入团队。">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate(formValues(e));
        }}
      >
        <Field id="name" label={t("setup.name")} required autoFocus />
        <Field id="email" label={t("login.email")} type="email" required />
        <Field id="password" label={`${t("login.password")}（至少 10 位）`} type="password" minLength={10} required autoComplete="new-password" />
        <FormError error={m.error} />
        <Button type="submit" className="w-full" disabled={m.isPending}>
          {t("invite.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}

export function ResetPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const navigate = useNavigate();
  const [done, setDone] = useState(false);
  const m = useMutation({
    mutationFn: (v: Record<string, string>) => unwrap(api.api.v1.auth.reset.post({ token, password: v.password! })),
    onSuccess: () => setDone(true),
  });
  return (
    <AuthLayout title={t("reset.title")}>
      {done ? (
        <div className="space-y-4">
          <p className="text-sm">密码已更新，所有旧会话已失效。</p>
          <Button className="w-full" onClick={() => void navigate({ to: "/login" })}>
            去登录
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate(formValues(e));
          }}
        >
          <Field id="password" label="新密码（至少 10 位）" type="password" minLength={10} required autoFocus autoComplete="new-password" />
          <FormError error={m.error} />
          <Button type="submit" className="w-full" disabled={m.isPending}>
            {t("reset.submit")}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

/** Inline re-login when the session expires: the page underneath (and its inputs) stays (§13.4). */
export function ReloginForm({ onDone }: { onDone(): void }) {
  const m = useMutation({
    mutationFn: (v: { email: string; password: string }) => unwrap(api.api.v1.auth["sign-in"].post(v)),
    onSuccess: (r) => {
      session.set(r.token);
      realtime.disconnect();
      realtime.connect();
      void queryClient.invalidateQueries();
      onDone();
    },
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const v = formValues(e);
        m.mutate({ email: v.email!, password: v.password! });
      }}
    >
      <Field id="relogin-email" label={t("login.email")} name="email" type="email" required autoFocus />
      <Field id="relogin-password" label={t("login.password")} name="password" type="password" required />
      <FormError error={m.error} />
      <Button type="submit" className="w-full" disabled={m.isPending}>
        {t("login.submit")}
      </Button>
    </form>
  );
}
