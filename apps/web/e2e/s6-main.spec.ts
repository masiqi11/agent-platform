import { expect, test } from "@playwright/test";
import { apiToken, seedS5, shootBoth, watchConsole } from "./helpers";

/**
 * S6 main scenario (§22.2) in the browser, scripted model + local SCM:
 * chat request → captain follow-up → answer → proposal → accept → dev fixes + MR → reviewer asks for
 * two changes → dev reworks → reviewer approves → tester passes → merge approval in the inbox →
 * merge queue merges → done + release record → captain's completion card in the group.
 */
test("S6: the ten-step main scenario end to end in the Web console", async ({ page }) => {
  test.setTimeout(240_000);
  seedS5();
  const con = watchConsole(page);
  const token = await apiToken(page, "owner@xinghe.test");
  await page.goto("/login");
  await page.evaluate((t) => localStorage.setItem("ap.token", t), token);
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const pay = ((await (await page.request.get("/api/v1/projects", auth)).json()) as { id: string; key: string }[]).find((p) => p.key === "DPAY")!;

  // Steps 1–3: request, follow-up question, details, proposal.
  await page.goto(`/projects/${pay.id}/chat`);
  const box = page.getByLabel("消息输入框");
  await box.fill("@船长 下单接口最近超时，帮我查一下");
  await box.press("Enter");
  const q = page.getByTestId("question-card").last();
  await expect(q).toBeVisible({ timeout: 30_000 });
  await q.getByRole("textbox", { name: "回答" }).fill("从昨天下午 3 点开始，下单接口 p99 超过 30 秒才失败，上游网关 5 秒就断开");
  await q.getByRole("button", { name: "回答" }).click();
  const proposalPanel = page.getByTestId("proposal-panel").last();
  await expect(proposalPanel).toBeVisible({ timeout: 30_000 });

  // Step 4: accept → task created, assigned by policy, Issue synced.
  await proposalPanel
    .getByRole("button", { name: /接受|确认/ })
    .first()
    .click();
  await expect(page.getByTestId("message").filter({ hasText: "已按分配策略" }).last()).toBeVisible({ timeout: 30_000 });
  const tasks = (await (await page.request.get(`/api/v1/projects/${pay.id}/tasks`, auth)).json()) as Array<{ id: string; title: string; ref: string; createdAt: string }>;
  const task = tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;

  // Steps 5–7 run by themselves; watch them on the task page.
  await page.goto(`/projects/${pay.id}/tasks/${task.id}`);
  await expect(page.getByTestId("review-round").filter({ hasText: "要求修改" })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("review-round").filter({ hasText: "通过" })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("test-run").filter({ hasText: "通过" })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("review-round").filter({ hasText: "已失效" })).toHaveCount(1);
  await expect(page.getByTestId("merge-gate")).toContainText("合并审批通过（当前提交）");
  await page.waitForTimeout(400);
  await shootBoth(page, "s6-task-review-test", { fullPage: true });

  // Step 8: the merge approval carries the evidence; a human approves in the inbox.
  await page.goto("/inbox");
  const entry = page
    .getByTestId("inbox-list")
    .getByRole("button")
    .filter({ hasText: `待审批（合并）：${task.ref}` })
    .first();
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  const detail = page.getByTestId("approval-detail");
  await expect(detail).toBeVisible();
  for (const label of ["MR", "变更", "评审", "测试", "CI", "成本", "风险"]) await expect(detail).toContainText(label);
  await page.waitForTimeout(300);
  await shootBoth(page, "s6-approval-evidence");
  await detail.getByRole("button", { name: "批准" }).click();

  // Merge queue → done, release record.
  await page.goto(`/projects/${pay.id}/tasks/${task.id}`);
  await expect(page.getByTestId("merge-queue-status")).toContainText("已合并", { timeout: 90_000 });
  await expect(page.getByTestId("release-record")).toBeVisible();
  await expect(page.getByText("已完成").first()).toBeVisible();
  await page.waitForTimeout(400);
  await shootBoth(page, "s6-task-done", { fullPage: true });

  // Step 9: the captain's completion summary in the group.
  await page.goto(`/projects/${pay.id}/chat`);
  const card = page.getByTestId("completion-card").last();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText(task.ref);
  await expect(card).toContainText("已由合并队列合并");
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shootBoth(page, "s6-completion-card");

  // Merge queue panel.
  await page.goto(`/projects/${pay.id}/repos`);
  await expect(page.getByTestId("merge-queue")).toContainText("已合并");
  await shootBoth(page, "s6-merge-queue");
  con.assertClean();
});
