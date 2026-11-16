import { expect, test } from "@playwright/test";
import { apiToken, seedDemo, shootBoth, watchConsole } from "./helpers";

/**
 * S4 exit scenario in the browser with the scripted model (tenant default on a fresh install):
 * @船长 → reply + question card → answer → proposal card → accept → task assigned by policy.
 * Then summary refresh → decision card → confirm; sessions inspector; models page; global captain.
 */
test("S4: captain asks, proposes, assigns; summary + decisions; inspector; models; global ask", async ({ page }) => {
  test.setTimeout(180_000);
  seedDemo();
  const con = watchConsole(page);
  const token = await apiToken(page, "owner@xinghe.test");
  await page.goto("/login");
  await page.evaluate((t) => localStorage.setItem("ap.token", t), token);
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const demo = ((await (await page.request.get("/api/v1/projects", auth)).json()) as { id: string; key: string }[]).find((p) => p.key === "DEMO")!;

  await page.goto(`/projects/${demo.id}/chat`);
  const box = page.getByLabel("消息输入框");
  await box.fill("@船长 支付服务最近超时，帮我查一下");
  await box.press("Enter");
  const q = page.getByTestId("question-card").last();
  await expect(q).toBeVisible({ timeout: 20_000 });
  await expect(q).toHaveAttribute("data-status", "open");
  await expect(page.getByTestId("message").filter({ hasText: "收到：支付服务最近超时" })).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(400);
  await shootBoth(page, "s4-captain-question");

  // Answer via the card's free-text box → captain proposes.
  await q.getByRole("textbox", { name: "回答" }).fill("从昨天下午 3 点开始，/pay/callback 接口 p99 超过 5 秒，错误率 8%");
  await q.getByRole("button", { name: "回答" }).click();
  await expect(q).toHaveAttribute("data-status", "answered", { timeout: 20_000 });
  const panel = page.getByTestId("proposal-panel").filter({ hasText: "排查支付服务超时" }).last();
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await panel
    .getByRole("button", { name: /接受|确认/ })
    .first()
    .click();
  await expect(page.getByTestId("message").filter({ hasText: "已按分配策略" }).last()).toContainText("小码", { timeout: 20_000 });
  await page.waitForTimeout(400);
  await shootBoth(page, "s4-captain-proposal");

  // Summary refresh → decision card → confirm.
  await box.fill("决定：支付回调统一走异步队列，3 秒内先返回 200");
  await box.press("Enter");
  await page.getByRole("tab", { name: "摘要" }).click();
  await page.getByRole("button", { name: "刷新摘要" }).click();
  const dcard = page.getByTestId("decision-card").filter({ hasText: "异步队列" }).last();
  await expect(dcard).toBeVisible({ timeout: 20_000 });
  await dcard.getByRole("button", { name: "确认" }).click();
  await expect(dcard).toHaveAttribute("data-status", "confirmed");
  await expect(page.getByTestId("summary-tab")).toContainText("异步队列");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(400);
  await shootBoth(page, "s4-summary");

  // Session inspector (Maintainer+).
  await page.goto(`/projects/${demo.id}/sessions`);
  await page.getByTestId("session-row").filter({ hasText: "常驻" }).first().click();
  await expect(page.getByTestId("context-inspector").first()).toBeVisible();
  await shootBoth(page, "s4-session-inspector");

  // Models & budget admin.
  await page.goto("/admin/models");
  await expect(page.getByTestId("provider-card").first()).toContainText("脚本模型");
  await page.waitForTimeout(300);
  await shootBoth(page, "s4-models");

  // Global captain on home.
  await page.goto("/");
  await page.getByRole("textbox", { name: "问全局船长" }).fill("哪个项目在处理支付回调超时？");
  await page.getByRole("button", { name: "提问" }).click();
  await expect(page.getByTestId("global-answer")).toContainText("DEMO", { timeout: 20_000 });
  await page.waitForTimeout(300);
  await shootBoth(page, "s4-global-captain");
  con.assertClean();
});
