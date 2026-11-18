import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BookOpen,
  Activity,
  Cpu,
  GitFork,
  History,
  Bot,
  ChevronsLeft,
  ChevronsRight,
  FolderKanban,
  Home,
  Inbox,
  KanbanSquare,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  Monitor,
  Moon,
  ScrollText,
  Search,
  Sun,
  Users,
  WifiOff,
  MessageCircle,
  type LucideIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Logo } from "@/components/logo";
import { api } from "@/lib/api";
import { t, type MsgKey } from "@/lib/i18n";
import { inboxQuery, useInboxLive } from "@/lib/inbox";
import { canAudit, isAdmin, useMe } from "@/lib/me";
import { useGroups, useProjectLive, useProjects } from "@/lib/projects";
import { queryClient } from "@/lib/query";
import { realtime, useConnectionStatus } from "@/lib/realtime";
import { session } from "@/lib/session";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: MsgKey;
  icon: LucideIcon;
  badge?: number;
  /** label is a literal string, not an i18n key */
  raw?: boolean;
  exact?: boolean;
}

function NavLink({ item, collapsed, path: given }: { item: NavItem; collapsed: boolean; path?: string }) {
  const current = useRouterState({ select: (s) => s.location.pathname });
  const path = given ?? current;
  const active = item.to === "/" || item.exact ? path === item.to : path.startsWith(item.to);
  const label = item.raw ? item.label : t(item.label);
  const body = (
    <Link
      to={item.to}
      className={cn(
        "group flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-active/60 hover:text-sidebar-foreground",
        active && "bg-sidebar-active font-medium text-sidebar-foreground shadow-xs ring-1 ring-border/80",
        collapsed && "justify-center px-0",
      )}
      aria-current={active ? "page" : undefined}
    >
      <item.icon className={cn("size-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} aria-hidden />
      {!collapsed && <span className="truncate">{label}</span>}
      {!collapsed && item.badge ? <span className="ml-auto rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-5 text-accent-foreground tabular-nums">{item.badge}</span> : null}
    </Link>
  );
  if (!collapsed) return body;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function InboxNav({ collapsed }: { collapsed: boolean }) {
  useInboxLive();
  const q = useQuery(inboxQuery("all"));
  return <NavLink item={{ to: "/inbox", label: "nav.inbox", icon: Inbox, badge: q.data?.unread }} collapsed={collapsed} />;
}

function Section({ label, collapsed, children }: { label: string; collapsed: boolean; children: ReactNode }) {
  return (
    <div className="mt-5">
      {!collapsed && <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function ProjectNav({ collapsed }: { collapsed: boolean }) {
  const { data: projects } = useProjects();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const activeId = path.match(/^\/projects\/([^/]+)/)?.[1];
  const list = (projects ?? []).filter((p) => p.status === "active" || p.id === activeId);
  if (list.length === 0) return null;
  return (
    <Section label="项目" collapsed={collapsed}>
      {list.map((p) =>
        p.id === activeId ? (
          <ActiveProject key={p.id} id={p.id} name={p.name} pkey={p.key} collapsed={collapsed} path={path} />
        ) : (
          <NavLink key={p.id} item={{ to: `/projects/${p.id}`, label: p.name as MsgKey, icon: FolderKanban, raw: true }} collapsed={collapsed} />
        ),
      )}
    </Section>
  );
}

function ActiveProject({ id, name, pkey, collapsed, path }: { id: string; name: string; pkey: string; collapsed: boolean; path: string }) {
  const { data: groups } = useGroups(id);
  useProjectLive(id);
  const unread = (groups ?? []).reduce((n, g) => n + (g.member ? g.unread : 0), 0);
  const subs: NavItem[] = [
    { to: `/projects/${id}`, label: "概览" as MsgKey, icon: LayoutDashboard, raw: true, exact: true },
    { to: `/projects/${id}/chat`, label: "对话" as MsgKey, icon: MessagesSquare, raw: true, badge: unread },
    { to: `/projects/${id}/board`, label: "看板" as MsgKey, icon: KanbanSquare, raw: true },
    { to: `/projects/${id}/agents`, label: "Agent" as MsgKey, icon: Bot, raw: true },
    { to: `/projects/${id}/sessions`, label: "会话" as MsgKey, icon: History, raw: true },
    { to: `/projects/${id}/repos`, label: "仓库" as MsgKey, icon: GitFork, raw: true },
    { to: `/projects/${id}/knowledge`, label: "知识库" as MsgKey, icon: BookOpen, raw: true },
    { to: `/projects/${id}/im`, label: "IM 群" as MsgKey, icon: MessageCircle, raw: true },
  ];
  return (
    <div className="py-0.5">
      {!collapsed && (
        <p className="flex items-center gap-2 px-2 py-1 text-sm font-medium" title={name}>
          <FolderKanban className="size-4 text-primary" aria-hidden />
          <span className="truncate">{name}</span>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">{pkey}</span>
        </p>
      )}
      <div className={cn("space-y-0.5", !collapsed && "ml-3.5 border-l pl-2")}>
        {subs.map((i) => (
          <NavLink key={i.to} item={i} collapsed={collapsed} path={path} />
        ))}
      </div>
    </div>
  );
}

export function Sidebar({ collapsed, onToggle, onSearch, extra }: { collapsed: boolean; onToggle(): void; onSearch(): void; extra?: ReactNode }) {
  const { data: me } = useMe();
  const admin: NavItem[] = [];
  if (isAdmin(me)) admin.push({ to: "/admin/users", label: "nav.users", icon: Users });
  if (isAdmin(me)) admin.push({ to: "/admin/models", label: "模型与预算" as MsgKey, icon: Cpu, raw: true });
  if (isAdmin(me)) admin.push({ to: "/admin/system", label: "系统状态" as MsgKey, icon: Activity, raw: true });
  if (canAudit(me)) admin.push({ to: "/audit", label: "nav.audit", icon: ScrollText });
  return (
    <aside className={cn("flex h-dvh shrink-0 flex-col border-r bg-sidebar px-2.5 py-3 transition-[width]", collapsed ? "w-14" : "w-60")} aria-label="主导航">
      <div className={cn("mb-4 flex items-center gap-2 px-1", collapsed && "justify-center px-0")}>
        <Logo />
        {!collapsed && (
          <div className="leading-tight">
            <p className="text-sm font-semibold">{t("app.name")}</p>
            <p className="text-[11px] text-muted-foreground">{me?.tenant.name ?? "—"}</p>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onSearch}
        aria-label={t("top.search")}
        className={cn("mb-3 flex h-8 items-center gap-2 rounded-lg border bg-card/70 px-2.5 text-sm text-muted-foreground transition-colors hover:border-ring/50", collapsed && "justify-center px-0")}
      >
        <Search className="size-3.5 shrink-0" aria-hidden />
        {!collapsed && (
          <>
            <span className="truncate">{t("top.search")}</span>
            <kbd className="ml-auto rounded border bg-muted px-1 font-mono text-[10px]">⌘K</kbd>
          </>
        )}
      </button>
      <nav className="flex-1 overflow-y-auto">
        <div className="space-y-0.5">
          <NavLink item={{ to: "/", label: "nav.home", icon: Home }} collapsed={collapsed} />
          <InboxNav collapsed={collapsed} />
        </div>
        <ProjectNav collapsed={collapsed} />
        {extra}
        {admin.length > 0 && (
          <Section label={t("nav.admin")} collapsed={collapsed}>
            {admin.map((i) => (
              <NavLink key={i.to} item={i} collapsed={collapsed} />
            ))}
          </Section>
        )}
      </nav>
      <div className={cn("mt-2 flex items-center gap-1 border-t pt-2.5", collapsed && "flex-col")}>
        <UserMenu collapsed={collapsed} />
        <ThemeMenu />
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={onToggle} aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}>
          {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
        </Button>
      </div>
    </aside>
  );
}

function ThemeMenu() {
  const { pref, setPref, resolved } = useTheme();
  const Icon = resolved === "dark" ? Moon : Sun;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={t("top.theme")} data-testid="theme-toggle">
          <Icon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(
          [
            ["light", Sun, "theme.light"],
            ["dark", Moon, "theme.dark"],
            ["system", Monitor, "theme.system"],
          ] as const
        ).map(([v, I, k]) => (
          <DropdownMenuItem key={v} onClick={() => setPref(v)} data-active={pref === v}>
            <I className="size-4" /> {t(k)} {pref === v ? "·" : ""}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const TENANT_ROLE: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员", viewer: "只读", auditor: "审计员" };

const ImIdentityDialog = lazy(() => import("@/pages/im").then((m) => ({ default: m.ImIdentityDialog })));

function UserMenu({ collapsed }: { collapsed: boolean }) {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const initials = (me?.displayName ?? "?").slice(0, 1);
  const [imOpen, setImOpen] = useState(false);
  return (
    <>
      {imOpen && (
        <Suspense fallback={null}>
          <ImIdentityDialog onClose={() => setImOpen(false)} />
        </Suspense>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className={cn("h-10 min-w-0 gap-2 px-1.5", !collapsed && "flex-1 justify-start")} aria-label="用户菜单">
            <Avatar className="size-7">
              <AvatarFallback className="bg-avatar text-[12px] font-medium text-avatar-foreground">{initials}</AvatarFallback>
            </Avatar>
            {!collapsed && (
              <span className="min-w-0 text-left leading-tight">
                <span className="block truncate text-sm font-medium">{me?.displayName}</span>
                <span className="block text-[11px] text-muted-foreground">{TENANT_ROLE[me?.tenantRole ?? ""] ?? ""}</span>
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-56">
          <DropdownMenuLabel>
            <p className="font-medium">{me?.displayName}</p>
            <p className="text-xs font-normal text-muted-foreground">{me?.email}</p>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setImOpen(true)}>
            <MessageCircle className="size-4" /> IM 身份
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={async () => {
              await api.api.v1.auth["sign-out"].post().catch(() => {});
              session.set(null);
              realtime.disconnect();
              queryClient.clear();
              void navigate({ to: "/login" });
            }}
          >
            <LogOut className="size-4" /> {t("user.signout")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange(v: boolean): void }) {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const { data: projects } = useProjects();
  const go = (to: string) => {
    onOpenChange(false);
    void navigate({ to });
  };
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="命令面板" description="跳转或执行动作">
      <CommandInput placeholder={t("top.search")} />
      <CommandList>
        <CommandEmpty>没有匹配项</CommandEmpty>
        <CommandGroup heading="跳转">
          <CommandItem onSelect={() => go("/")}>
            <Home /> {t("nav.home")}
          </CommandItem>
          <CommandItem onSelect={() => go("/inbox")}>
            <Inbox /> {t("nav.inbox")}
          </CommandItem>
          {isAdmin(me) && (
            <CommandItem onSelect={() => go("/admin/users")}>
              <Users /> {t("nav.users")}
            </CommandItem>
          )}
          {canAudit(me) && (
            <CommandItem onSelect={() => go("/audit")}>
              <ScrollText /> {t("nav.audit")}
            </CommandItem>
          )}
        </CommandGroup>
        {projects && projects.length > 0 && (
          <CommandGroup heading="项目">
            {projects.map((p) => (
              <CommandItem key={p.id} value={`${p.key} ${p.name}`} onSelect={() => go(`/projects/${p.id}/chat`)}>
                <MessagesSquare /> {p.name} <span className="ml-auto font-mono text-xs text-muted-foreground">{p.key}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

function ConnectionBar() {
  const status = useConnectionStatus();
  if (status !== "reconnecting") return null;
  return (
    <div role="status" className="flex items-center justify-center gap-2 bg-attention-soft py-1 text-xs text-foreground" data-testid="conn-lost">
      <WifiOff className="size-3.5 text-attention" aria-hidden /> {t("conn.lost")}
    </div>
  );
}

export function AppShell({ children, sidebarExtra }: { children: ReactNode; sidebarExtra?: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("ap.sidebar") === "1" || window.innerWidth < 1280);
  const [cmd, setCmd] = useState(false);
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const bleed = /^\/projects\/[^/]+\/chat/.test(path);
  // Board and inbox fill the viewport and scroll inside their own panes.
  const fill = /^\/projects\/[^/]+\/board$|^\/inbox$/.test(path);
  useEffect(() => {
    let g = false;
    const on = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmd((v) => !v);
        return;
      }
      if (typing) return;
      if (e.key === "/") {
        e.preventDefault();
        setCmd(true);
      } else if (e.key.toLowerCase() === "g") {
        g = true;
        setTimeout(() => (g = false), 800);
      } else if (g && e.key.toLowerCase() === "i") void navigate({ to: "/inbox" });
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [navigate]);
  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar
        collapsed={collapsed}
        extra={sidebarExtra}
        onSearch={() => setCmd(true)}
        onToggle={() =>
          setCollapsed((c) => {
            localStorage.setItem("ap.sidebar", c ? "0" : "1");
            return !c;
          })
        }
      />
      <div className={cn("flex min-w-0 flex-1 flex-col", bleed || fill ? "overflow-hidden" : "overflow-y-auto")}>
        <ConnectionBar />
        <main className={bleed ? "flex min-h-0 flex-1" : fill ? "flex min-h-0 w-full flex-1 flex-col px-6 pt-6 pb-3" : "mx-auto w-full max-w-[1400px] flex-1 px-6 py-6"}>{children}</main>
      </div>
      <CommandPalette open={cmd} onOpenChange={setCmd} />
    </div>
  );
}
