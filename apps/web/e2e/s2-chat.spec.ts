import { expect, test, type Page } from "@playwright/test";
import { apiToken, shootBoth, watchConsole } from "./helpers";

test.describe.configure({ mode: "serial" });

async function signInAs(page: Page, email: string) {
  const token = await apiToken(page, email);
  await page.goto("/login");
  await page.evaluate((t) => localStorage.setItem("ap.token", t), token);
  return token;
}

test("S2: project → realtime chat between two people → refresh keeps order → search jump", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const con = watchConsole(page);
  const ownerToken = await signInAs(page, "owner@xinghe.test");
  await page.goto("/");

  // Create a project from the home page.
  await page.getByTestId("new-project").click();
  await page.locator("#p-key").fill("PAY");
  await page.locator("#p-name").fill("支付服务");
  await page.locator("#p-desc").fill("支付网关与回调处理");
  await page.getByRole("button", { name: /创建/ }).last().click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/chat\?g=/);
  const projectId = page.url().match(/projects\/([^/]+)/)![1]!;
  const groupId = new URL(page.url()).searchParams.get("g")!;
  await expect(page.getByRole("heading", { name: "支付服务 主群" })).toBeVisible();
  await expect(page.getByText("还没有消息")).toBeVisible();

  // Add 李工 to the project.
  const users = (await (await page.request.get("/api/v1/users", { headers: { authorization: `Bearer ${ownerToken}` } })).json()) as { email: string; principalId: string }[];
  const li = users.find((u) => u.email === "li@xinghe.test")!;
  const put = await page.request.put(`/api/v1/projects/${projectId}/members/${li.principalId}`, { headers: { authorization: `Bearer ${ownerToken}` }, data: { role: "member" } });
  expect(put.ok()).toBeTruthy();

  // Second person in a separate browser context.
  const ctx2 = await browser.newContext({ locale: "zh-CN", timezoneId: "Asia/Shanghai", viewport: { width: 1440, height: 900 } });
  const p2 = await ctx2.newPage();
  const liToken = await signInAs(p2, "li@xinghe.test");
  await p2.goto(`/projects/${projectId}/chat?g=${groupId}`);
  await expect(p2.getByRole("heading", { name: "支付服务 主群" })).toBeVisible();

  // Owner types with @ autocomplete.
  const box = page.getByLabel("消息输入框");
  await box.click();
  await box.pressSequentially("大家好，支付回调需要加重试 @李");
  await expect(page.getByRole("listbox", { name: "提及成员" })).toBeVisible();
  await shootBoth(page, "s2-mention-menu");
  await box.press("Enter");
  await box.pressSequentially("看一下");
  await box.press("Enter");
  // Arrives at the other person in realtime (no reload).
  await expect(p2.getByTestId("message").filter({ hasText: "支付回调需要加重试" })).toBeVisible({ timeout: 10_000 });
  await expect(p2.locator(".mention-pill, [data-mention]").first()).toBeVisible();

  const box2 = p2.getByLabel("消息输入框");
  await box2.fill("收到，我今天下午处理回调重试，**预计 3 点前**提 MR。\n- 指数退避\n- 最多 5 次");
  await box2.press("Enter");
  await expect(page.getByTestId("message").filter({ hasText: "收到，我今天下午处理回调重试" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("tab", { name: "成员" }).click();
  await shootBoth(page, "s2-chat");
  await page.getByRole("tab", { name: "摘要" }).click();

  // Seed history through the API to exercise virtualization and paging (split across two people: 60 msg/min/person limit).
  for (let i = 1; i <= 70; i++) {
    const r = await page.request.post(`/api/v1/groups/${groupId}/messages`, {
      headers: { authorization: `Bearer ${i % 2 ? ownerToken : liToken}`, "idempotency-key": `seed-${i}` },
      data: { body: i === 7 ? "对账脚本的 签名校验 失败率在灰度环境是 0.3%" : `进度同步 第 ${i} 条：联调中` },
    });
    expect(r.ok()).toBeTruthy();
  }
  await expect(p2.getByTestId("message").filter({ hasText: "第 70 条" })).toBeVisible({ timeout: 15_000 });

  // Refresh keeps order: rendered seqs must be strictly increasing.
  await page.reload();
  await expect(page.getByTestId("message").filter({ hasText: "第 70 条" })).toBeVisible();
  const seqs = await page.getByTestId("message").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-seq"))));
  expect(seqs.length).toBeGreaterThan(5);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  await shootBoth(page, "s2-chat-history");

  // Scroll to top loads older history.
  await page.getByTestId("timeline").evaluate((el) => (el.scrollTop = 0));
  await expect(page.getByText(/这是 #支付服务 主群 的开始/)).toBeVisible({ timeout: 10_000 });
  // Older page keeps the reading position (anchored), so scroll up once more to reach the very first message.
  await page.getByTestId("timeline").evaluate((el) => (el.scrollTop = 0));
  await expect(page.getByTestId("message").filter({ hasText: "大家好，支付回调需要加重试" })).toBeVisible();

  // Search → jump → highlight.
  await page.getByTestId("chat-search").fill("签名校验");
  await expect(page.getByTestId("search-hit")).toHaveCount(1);
  await shootBoth(page, "s2-search");
  await page.getByTestId("search-hit").click();
  await expect(page).toHaveURL(/seq=\d+/);
  const hit = page.getByTestId("message").filter({ hasText: "签名校验" });
  await expect(hit).toBeVisible();
  await expect(hit).toHaveClass(/bg-attention-soft/);
  await shootBoth(page, "s2-search-jump");

  // Unread badge for the other person after they navigate away and back.
  await p2.goto(`/projects/${projectId}`);
  await expect(p2.getByRole("heading", { name: "支付服务" })).toBeVisible();
  await page.getByTestId("chat-search").fill("");
  await page.getByLabel("消息输入框").fill("@李工 请看下这条签名问题");
  await page.getByLabel("消息输入框").press("Enter");
  await expect(p2.getByRole("link", { name: /进入对话 · 1 未读/ })).toBeVisible({ timeout: 10_000 });
  await shootBoth(p2, "s2-project-home");

  // Agents directory.
  await page.goto(`/projects/${projectId}/agents`);
  await expect(page.getByTestId("agent-card").first()).toBeVisible();
  await page.getByRole("button", { name: "新建 Agent" }).click();
  await page.locator("#agent-name").fill("开发 Agent A");
  await page.getByRole("dialog").getByRole("button", { name: "创建" }).click();
  await expect(page.getByTestId("agent-card")).toHaveCount(2);
  await shootBoth(page, "s2-agents");

  await ctx2.close();
  con.assertClean();
});
