import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { apiToken, seedS5, SHOTS } from "./helpers";

/**
 * §13.10 / S8: automated accessibility (axe, WCAG 2 A/AA) on the main pages — no critical
 * violations; and every page fits a phone width without sideways scrolling. Runs after the
 * S-series (zz-…) so the demo data is there.
 */
async function login(page: Page) {
  seedS5();
  const token = await apiToken(page, "owner@xinghe.test");
  await page.goto("/login");
  await page.evaluate((t) => localStorage.setItem("ap.token", t), token);
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const projects = (await (await page.request.get("/api/v1/projects", auth)).json()) as Array<{ id: string; key: string }>;
  const pay = projects.find((p) => p.key === "DPAY") ?? projects[0]!;
  const tasks = (await (await page.request.get(`/api/v1/projects/${pay.id}/tasks`, auth)).json()) as Array<{ id: string }>;
  return { pay, taskId: tasks[0]?.id };
}

const pages = (pay: { id: string }, taskId?: string) => [
  { name: "home", path: "/" },
  { name: "inbox", path: "/inbox" },
  { name: "project", path: `/projects/${pay.id}` },
  { name: "chat", path: `/projects/${pay.id}/chat` },
  { name: "board", path: `/projects/${pay.id}/board` },
  ...(taskId ? [{ name: "task", path: `/tasks/${taskId}` }] : []),
  { name: "agents", path: `/projects/${pay.id}/agents` },
  { name: "repos", path: `/projects/${pay.id}/repos` },
  { name: "knowledge", path: `/projects/${pay.id}/knowledge` },
  { name: "models", path: "/admin/models" },
  { name: "system", path: "/admin/system" },
  { name: "users", path: "/admin/users" },
  { name: "audit", path: "/admin/audit" },
];

test("a11y: no critical axe violations on the main pages", async ({ page }) => {
  test.setTimeout(120_000);
  const { pay, taskId } = await login(page);
  const report: Array<{ page: string; critical: number; serious: number; ids: string[] }> = [];
  for (const p of pages(pay, taskId)) {
    await page.goto(p.path);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const crit = r.violations.filter((v) => v.impact === "critical");
    const ser = r.violations.filter((v) => v.impact === "serious");
    report.push({ page: p.name, critical: crit.length, serious: ser.length, ids: [...crit, ...ser].map((v) => `${v.impact}:${v.id}(${v.nodes.length})`) });
  }
  console.log(JSON.stringify(report, null, 1));
  expect(
    report.filter((r) => r.critical > 0),
    JSON.stringify(report),
  ).toEqual([]);
});

test("narrow screens: every main page fits 390 px without sideways scrolling", async ({ page }) => {
  test.setTimeout(120_000);
  const { pay, taskId } = await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow: string[] = [];
  for (const p of pages(pay, taskId)) {
    await page.goto(p.path);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (wide > 1) overflow.push(`${p.name}: +${wide}px`);
    if (["home", "chat", "board", "task", "system"].includes(p.name)) await page.screenshot({ path: `${SHOTS}/narrow-${p.name}.png` });
  }
  expect(overflow).toEqual([]);
});
