import { expect, test } from "@playwright/test";
import { PW, apiToken, shootBoth, watchConsole } from "./helpers";

test.describe.configure({ mode: "serial" });

test("S1: setup → users → invite → audit, with 403/404 states", async ({ page, browser }) => {
  const con = watchConsole(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup/);
  await shootBoth(page, "s1-setup");
  await page.getByLabel("团队 / 公司名称").fill("星河支付");
  await page.getByLabel("你的名字").fill("王晓明");
  await page.getByLabel("邮箱").fill("owner@xinghe.test");
  await page.getByLabel(/密码/).fill(PW);
  await page.getByRole("button", { name: "创建并进入" }).click();
  await expect(page.getByRole("heading", { name: /你好，王晓明/ })).toBeVisible();
  await shootBoth(page, "s1-home");

  // Invite a member through the UI.
  await page.getByRole("link", { name: "成员与邀请" }).click();
  await expect(page.getByTestId("user-row")).toHaveCount(1);
  await page.getByRole("button", { name: "邀请成员" }).first().click();
  await page.getByLabel("邮箱（可选）").fill("li@xinghe.test");
  await page.getByRole("button", { name: "生成链接" }).click();
  const link = await page.locator("input[readonly]").inputValue();
  expect(link).toContain("/invite/");
  await shootBoth(page, "s1-invite-dialog");
  await page.getByRole("button", { name: "完成" }).click();

  // Accept in a separate browser context.
  const ctx2 = await browser.newContext({ locale: "zh-CN" });
  const p2 = await ctx2.newPage();
  await p2.goto(new URL(link).pathname);
  await p2.getByLabel("你的名字").fill("李工");
  await p2.getByLabel("邮箱").fill("li@xinghe.test");
  await p2.getByLabel(/密码/).fill(PW);
  await p2.getByRole("button", { name: "加入团队" }).click();
  await expect(p2.getByRole("heading", { name: /你好，李工/ })).toBeVisible();
  // Member hitting an admin page sees the 403 state, not a blank page.
  await p2.goto("/admin/users");
  await expect(p2.getByText("没有权限")).toBeVisible();
  await shootBoth(p2, "s1-forbidden");
  await p2.goto("/no/such/page");
  await expect(p2.getByText("页面不存在")).toBeVisible();
  await ctx2.close();

  await page.reload();
  await expect(page.getByTestId("user-row")).toHaveCount(2);
  await shootBoth(page, "s1-users");

  // Audit view + chain verification.
  await page.getByRole("link", { name: "审计" }).click();
  await expect(page.getByTestId("audit-row").first()).toBeVisible();
  await page.getByTestId("audit-verify").click();
  await expect(page.getByText(/哈希链完整/)).toBeVisible();
  await page.getByTestId("audit-row").nth(1).click();
  await shootBoth(page, "s1-audit");
  con.assertClean();
});

test("S1: login page states and session expiry re-login keeps the page", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill("owner@xinghe.test");
  await page.getByLabel("密码").fill("wrong-password-1");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("alert")).toContainText("账号或密码错误");
  await shootBoth(page, "s1-login-error");
  await page.getByLabel("密码").fill(PW);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: /你好/ })).toBeVisible();
  await page.goto("/audit");
  await expect(page.getByTestId("audit-row").first()).toBeVisible();
  // Kill the session server-side; the next request must prompt an inline re-login.
  const token = await page.evaluate(() => localStorage.getItem("ap.token"));
  await page.request.post("/api/v1/auth/sign-out", { headers: { authorization: `Bearer ${token}` } });
  await page.getByRole("button", { name: "校验哈希链" }).click();
  await expect(page.getByText("登录已过期")).toBeVisible();
  await page.locator("#relogin-email").fill("owner@xinghe.test");
  await page.locator("#relogin-password").fill(PW);
  await page.getByRole("dialog").getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("登录已过期")).toBeHidden();
  await expect(page).toHaveURL(/\/audit/);
  expect(await apiToken(page, "owner@xinghe.test")).toBeTruthy();
});
