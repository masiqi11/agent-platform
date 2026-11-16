import { expect, test } from "@playwright/test";
import { apiToken, seedDemo, shootBoth, watchConsole } from "./helpers";

/**
 * Visual pass v2: seeds the 「演示数据」 project (multi-person chat, a thread, a task card, a decision
 * card, a pending proposal) via the server's seed CLI, then shoots chat + project home in both themes.
 */
test("v2 visual: demo chat and project home (演示数据)", async ({ page }) => {
  test.setTimeout(120_000);
  seedDemo();

  const con = watchConsole(page);
  const token = await apiToken(page, "owner@xinghe.test");
  await page.goto("/login");
  await page.evaluate((t) => localStorage.setItem("ap.token", t), token);
  const projects = (await (await page.request.get("/api/v1/projects", { headers: { authorization: `Bearer ${token}` } })).json()) as { id: string; key: string }[];
  const demo = projects.find((p) => p.key === "DEMO")!;
  expect(demo).toBeTruthy();

  await page.goto(`/projects/${demo.id}/chat`);
  await expect(page.getByRole("heading", { name: /支付服务（演示） 主群/ })).toBeVisible();
  await expect(page.getByTestId("task-card-inline").first()).toBeVisible();
  await expect(page.getByTestId("proposal-panel").first()).toBeVisible();
  await page.getByRole("tab", { name: "决策" }).click();
  await expect(page.getByTestId("decisions")).toContainText("外部调用超时统一走配置中心");
  await page.getByRole("tab", { name: "摘要" }).click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page.getByTestId("thread-replies").first()).toContainText("2 条回复");
  await page.waitForTimeout(300);
  await shootBoth(page, "chat-v2");

  await page.getByRole("tab", { name: "任务" }).click();
  await expect(page.getByTestId("group-tasks")).toContainText("排查退款回调偶发 502");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await shootBoth(page, "chat-tasks-v2");

  await page.goto(`/projects/${demo.id}`);
  await expect(page.getByRole("heading", { name: "支付服务（演示）" })).toBeVisible();
  await page.waitForTimeout(300);
  await shootBoth(page, "project-home-v2");
  con.assertClean();
});
