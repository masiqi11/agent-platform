import { expect, test } from "@playwright/test";
import { apiToken, seedS5, shootBoth, watchConsole } from "./helpers";

/**
 * S5 exit scenario in the browser (scripted model + local SCM): a task assigned to the dev agent
 * moves through workspace → fix → push → MR → CI → 评审中 by itself; the task page shows branch,
 * MR, CI, diff, evidence and cost. Also: repos page + binding wizard, agent load, system status.
 */
test("S5: dev agent fixes the demo bug to in_review; repos wizard; agent load; system status", async ({ page }) => {
  test.setTimeout(180_000);
  seedS5();
  const con = watchConsole(page);
  const token = await apiToken(page, "owner@xinghe.test");
  await page.goto("/login");
  await page.evaluate((t) => localStorage.setItem("ap.token", t), token);
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const pay = ((await (await page.request.get("/api/v1/projects", auth)).json()) as { id: string; key: string; mainGroupId?: string }[]).find((p) => p.key === "DPAY")!;

  // Repos page + wizard.
  await page.goto(`/projects/${pay.id}/repos`);
  await expect(page.getByTestId("repo-card").filter({ hasText: "payments" })).toBeVisible();
  await expect(page.getByTestId("repo-card").first()).toContainText("已保护");
  await shootBoth(page, "s5-repos");
  await page.getByRole("button", { name: "绑定仓库" }).first().click();
  await page.getByLabel("仓库类型").click();
  await page.getByRole("option", { name: "GitLab" }).click();
  await page.getByLabel("名称").fill("gateway");
  await page.getByLabel("项目地址").fill("https://gitlab.example.com/pay/gateway");
  await expect(page.getByRole("button", { name: "绑定" })).toBeDisabled(); // GitLab must pass the check first
  await page.waitForTimeout(300);
  await shootBoth(page, "s5-repo-wizard");
  await page.getByRole("button", { name: "取消" }).click();

  // A task for the dev agent: created with assignee + criteria, moved to ready (S3 UI covers that).
  const agents = (await (await page.request.get(`/api/v1/projects/${pay.id}/agents`, auth)).json()) as { id: string; role: string }[];
  const dev = agents.find((a) => a.role === "dev")!;
  const created = await (
    await page.request.post("/api/v1/tasks", {
      ...auth,
      data: {
        projectId: pay.id,
        title: "排查支付服务下单超时",
        description: "下单接口偶发超时，用户等待很久后失败。",
        acceptanceCriteria: ["调用网关的超时小于上游网关超时", "仓库测试全部通过"],
        assigneeAgentId: dev.id,
      },
    })
  ).json();
  expect((await page.request.post(`/api/v1/tasks/${created.id}/transition`, { ...auth, data: { to: "ready" } })).ok()).toBeTruthy();

  await page.goto(`/projects/${pay.id}/tasks/${created.id}`);
  const panel = page.getByTestId("code-panel");
  await expect(panel.getByTestId("workspace")).toContainText("task/1", { timeout: 60_000 });
  await expect(panel.getByTestId("ci-status")).toContainText("通过", { timeout: 90_000 });
  // The task moves on quickly (S6 reviewer/tester agents), so check the history rather than the current status.
  await expect(page.getByTestId("timeline")).toContainText("评审中", { timeout: 30_000 });
  await expect(panel).toContainText("!1");
  await expect(panel).toContainText(/\d+ 个文件/);
  await expect(panel).toContainText("补丁");
  await expect(panel).toContainText("日志");
  await expect(page.getByTestId("gate-checklist")).toContainText("CI 通过");
  await expect(page.getByTestId("timeline")).toContainText("创建了 MR");
  await page.waitForTimeout(400);
  await shootBoth(page, "s5-task-code", { fullPage: true });

  // Agent directory: load + recent tasks.
  await page.goto(`/projects/${pay.id}/agents`);
  await expect(page.getByTestId("agent-load").first()).toBeVisible();
  await expect(page.getByTestId("agent-card").filter({ hasText: "小码" })).toContainText("DPAY-1");
  await shootBoth(page, "s5-agents-load");

  // System status (admin).
  await page.goto("/admin/system");
  await expect(page.getByTestId("system-tile").first()).toBeVisible();
  await expect(page.getByText("事件消费者")).toBeVisible();
  await shootBoth(page, "s5-system");
  con.assertClean();
});
