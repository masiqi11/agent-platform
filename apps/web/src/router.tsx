import { createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { AppShell } from "@/components/shell";
import { NotFoundState, PageSkeleton } from "@/components/states";
import { ApiError } from "@/lib/api";
import { meQuery } from "@/lib/me";
import { queryClient } from "@/lib/query";
import { session } from "@/lib/session";
import { InvitePage, LoginPage, ResetPage, SetupPage } from "@/pages/auth";
import { HomePage, InboxPage } from "@/pages/home";

// Admin/audit are split out of the first-screen bundle (§13.10).
const UsersPage = lazy(() => import("@/pages/users").then((m) => ({ default: m.UsersPage })));
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

const routeTree = rootRoute.addChildren([loginRoute, setupRoute, inviteRoute, resetRoute, appRoute.addChildren([homeRoute, inboxRoute, usersRoute, auditRoute])]);

export const router = createRouter({ routeTree, defaultPreload: "intent", defaultPendingComponent: () => <PageSkeleton />, context: {} });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
