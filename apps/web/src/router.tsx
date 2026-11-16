import { createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { AppShell } from "@/components/shell";
import { NotFoundState, PageSkeleton } from "@/components/states";
import { ApiError } from "@/lib/api";
import { meQuery } from "@/lib/me";
import { queryClient } from "@/lib/query";
import { session } from "@/lib/session";
import { InvitePage, LoginPage, ResetPage, SetupPage } from "@/pages/auth";
import { HomePage } from "@/pages/home";
import { InboxPage } from "@/pages/inbox";
import { ProjectHomePage } from "@/pages/project";

// Admin/audit are split out of the first-screen bundle (§13.10).
const UsersPage = lazy(() => import("@/pages/users").then((m) => ({ default: m.UsersPage })));
const ChatPage = lazy(() => import("@/pages/chat/chat-page").then((m) => ({ default: m.ChatPage })));
const AgentsPage = lazy(() => import("@/pages/agents").then((m) => ({ default: m.AgentsPage })));
const BoardPage = lazy(() => import("@/pages/board").then((m) => ({ default: m.BoardPage })));
const TaskPage = lazy(() => import("@/pages/task").then((m) => ({ default: m.TaskPage })));
const AuditPage = lazy(() => import("@/pages/audit").then((m) => ({ default: m.AuditPage })));

const rootRoute = createRootRoute({ component: () => <Outlet />, notFoundComponent: () => <NotFoundState /> });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
  validateSearch: (s: Record<string, unknown>): { redirect?: string } => ({ redirect: typeof s.redirect === "string" ? s.redirect : undefined }),
});
const setupRoute = createRoute({ getParentRoute: () => rootRoute, path: "/setup", component: SetupPage });
const inviteRoute = createRoute({ getParentRoute: () => rootRoute, path: "/invite/$token", component: InvitePage });
const resetRoute = createRoute({ getParentRoute: () => rootRoute, path: "/reset/$token", component: ResetPage });

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async ({ location }) => {
    if (!session.get()) throw redirect({ to: "/login", search: { redirect: location.href } });
    try {
      await queryClient.ensureQueryData(meQuery);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        session.set(null);
        throw redirect({ to: "/login", search: { redirect: location.href } });
      }
      throw e;
    }
  },
  component: () => (
    <AppShell>
      <Suspense fallback={<PageSkeleton />}>
        <Outlet />
      </Suspense>
    </AppShell>
  ),
  notFoundComponent: () => <NotFoundState />,
});

const homeRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: HomePage });
const inboxRoute = createRoute({ getParentRoute: () => appRoute, path: "/inbox", component: InboxPage });
const usersRoute = createRoute({ getParentRoute: () => appRoute, path: "/admin/users", component: UsersPage });
const auditRoute = createRoute({ getParentRoute: () => appRoute, path: "/audit", component: AuditPage });

const projectRoute = createRoute({ getParentRoute: () => appRoute, path: "/projects/$projectId" });
const projectHomeRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  component: function ProjectHome() {
    const { projectId } = projectHomeRoute.useParams();
    return <ProjectHomePage projectId={projectId} />;
  },
});
export interface ChatSearch {
  g?: string;
  seq?: number;
  t?: string;
}
const chatRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/chat",
  validateSearch: (s: Record<string, unknown>): ChatSearch => ({
    g: typeof s.g === "string" ? s.g : undefined,
    seq: typeof s.seq === "number" ? s.seq : typeof s.seq === "string" && /^\d+$/.test(s.seq) ? Number(s.seq) : undefined,
    t: typeof s.t === "string" ? s.t : undefined,
  }),
  component: function Chat() {
    const { projectId } = chatRoute.useParams();
    const { g, seq, t } = chatRoute.useSearch();
    return <ChatPage projectId={projectId} groupId={g} seq={seq} threadId={t} />;
  },
});
const agentsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/agents",
  component: function Agents() {
    const { projectId } = agentsRoute.useParams();
    return <AgentsPage projectId={projectId} />;
  },
});

const boardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/board",
  component: function Board() {
    const { projectId } = boardRoute.useParams();
    return <BoardPage projectId={projectId} />;
  },
});
const taskRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/tasks/$taskId",
  component: function Task() {
    const { projectId, taskId } = taskRoute.useParams();
    return <TaskPage key={taskId} projectId={projectId} taskId={taskId} />;
  },
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  setupRoute,
  inviteRoute,
  resetRoute,
  appRoute.addChildren([homeRoute, inboxRoute, usersRoute, auditRoute, projectRoute.addChildren([projectHomeRoute, chatRoute, agentsRoute, boardRoute, taskRoute])]),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent", defaultPendingComponent: () => <PageSkeleton />, context: {} });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
