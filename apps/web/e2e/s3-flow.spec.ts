import { expect, test, type Page } from "@playwright/test";
import { apiToken, seedDemo, shootBoth, watchConsole } from "./helpers";

test.describe.configure({ mode: "serial" });

async function signIn(page: Page, email: string) {
  const token = await apiToken(page, email);
  await page.goto("/login");
  await page.evaluate((t) => localStorage.setItem("ap.token", t), token);
  return token;
}
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

test("S3: board snap-back with missing guards → assign → ready; proposal accept in chat; approval in inbox", async ({ page }) => {
  test.setTimeout(120_000);
  seedDemo();
  const con = watchConsole(page);
  const token = await signIn(page, "owner@xinghe.test");
  const auth = { authorization: `Bearer ${token}` };
  const projects = (await (await page.request.get("/api/v1/projects", { headers: auth })).json()) as { id: string; key: string }[];
  const demo = projects.find((p) => p.key === "DEMO")!;

  // Board: colour columns with the seeded tasks.
  await page.goto(`/projects/${demo.id}/board`);
  const ready = page.getByTestId("col-ready");
  const backlog = page.getByTestId("col-backlog");
  await expect(ready.getByTestId("task-card").filter({ hasText: "排查退款回调偶发 502" })).toBeVisible();
  await expect(backlog.getByTestId("task-card").filter({ hasText: "外部调用超时迁移到配置中心" })).toBeVisible();

  // Illegal drop: ready → 开发中 without a workspace → snaps back and says what's missing.
  await ready.getByTestId("task-card").first().dragTo(page.getByTestId("col-in_progress"));
  await expect(page.getByText("不能变更：缺少 工作区就绪")).toBeVisible();
  await expect(ready.getByTestId("task-card").filter({ hasText: "排查退款回调偶发 502" })).toBeVisible();
  await expect(page.getByTestId("col-in_progress").getByTestId("task-card")).toHaveCount(0);
  // Illegal drop: backlog → 就绪 without an agent.
  await backlog.getByTestId("task-card").first().dragTo(ready);
  await expect(page.getByText("不能变更：缺少 负责 Agent")).toBeVisible();
  await expect(backlog.getByTestId("task-card")).toHaveCount(1);
  await shootBoth(page, "s3-board-rejected");

  // Task detail: assign the agent, then the gate opens and 就绪 becomes available.
  await backlog.getByRole("button", { name: "外部调用超时迁移到配置中心" }).click();
  await expect(page.getByRole("heading", { name: "外部调用超时迁移到配置中心" })).toBeVisible();
  await expect(page.getByRole("button", { name: "→ 就绪" })).toBeDisabled();
  await page.getByRole("combobox", { name: "负责 Agent" }).click();
  await page.getByRole("option", { name: "小码" }).click();
  await expect(page.getByRole("button", { name: "→ 就绪" })).toBeEnabled();
  await page.getByRole("button", { name: "→ 就绪" }).click();
  await expect(page.getByText(/DEMO-2 → 就绪/)).toBeVisible();
  await page.getByRole("button", { name: "满足" }).first().click();
  await expect(page.getByTestId("criteria")).toContainText("1/1 已满足");
  await expect(page.getByTestId("timeline")).toContainText("被拒绝");
  await blur(page);
  await shootBoth(page, "s3-task-detail");

  // Chat: accept the captain's proposal inline → creates a task, card updates in place.
  await page.goto(`/projects/${demo.id}/chat`);
  const panel = page.getByTestId("proposal-panel").first();
  await expect(panel).toHaveAttribute("data-status", "pending");
  await panel.getByRole("button", { name: "确认" }).click();
  await expect(panel).toHaveAttribute("data-status", "accepted");
  await expect(panel.getByRole("link", { name: /查看任务/ })).toBeVisible();
  await blur(page);
  await shootBoth(page, "s3-proposal-accepted");

  // Inbox: a maintainer requests a budget approval; the tenant owner sees evidence and approves.
  const lin = await apiToken(page, "linzhou@xinghe.test");
  const tasks = (await (await page.request.get(`/api/v1/projects/${demo.id}/tasks`, { headers: auth })).json()) as { id: string; title: string }[];
  const t1 = tasks.find((t) => t.title === "排查退款回调偶发 502")!;
  const req = await page.request.post(`/api/v1/tasks/${t1.id}/approvals`, {
    headers: { authorization: `Bearer ${lin}` },
    data: { kind: "budget", evidence: { summary: "压测需要临时扩容 2 台（演示）", risk: "低" } },
  });
  expect(req.ok()).toBeTruthy();
  await page.goto("/inbox");
  await page.getByTestId("inbox-list").getByRole("button").filter({ hasText: "审批" }).first().click();
  const detail = page.getByTestId("approval-detail");
  await expect(detail).toContainText("压测需要临时扩容 2 台");
  await expect(detail.getByRole("button", { name: "驳回" })).toBeDisabled(); // reason required
  await blur(page);
  await shootBoth(page, "s3-inbox");
  await detail.getByRole("button", { name: "批准" }).click();
  await expect(page.getByText("已批准")).toBeVisible();

  // Board after the flow.
  await page.goto(`/projects/${demo.id}/board`);
  await expect(page.getByTestId("col-ready").getByTestId("task-card")).toHaveCount(2);
  await blur(page);
  await shootBoth(page, "s3-board");
  con.assertClean();
});
