import { expect, test } from "@playwright/test";
import { apiToken, shootBoth, watchConsole } from "./helpers";

/**
 * S9 IM in the browser, with the simulated IM (IM_MOCK): bind your IM identity with a one-time
 * code, bind a group with /bind from the IM side, see IM messages (and an unmapped 外部成员) in the
 * timeline, and manage the binding on the project's IM page.
 */
test("S9: identity code, /bind from the group, IM messages in the timeline, binding settings", async ({ page }) => {
  const con = watchConsole(page);
  const token = await apiToken(page, "owner@xinghe.test");
  const auth = { authorization: `Bearer ${token}` };
  const p = await page.request.post("/api/v1/projects", { headers: auth, data: { key: "IME", name: "IM 演示" } });
  expect(p.ok()).toBeTruthy();
  const project = await p.json();
  const inject = (data: Record<string, unknown>) => page.request.post("/api/v1/dev/im/receive", { headers: auth, data });
  const waitFor = async (pred: (s: { sent: Array<{ markdown: string }>; replies: Array<{ markdown: string }> }) => boolean) => {
    for (let i = 0; i < 60; i++) {
      const s = await (await page.request.get("/api/v1/dev/im/sent", { headers: auth })).json();
      if (pred(s)) return s;
      await page.waitForTimeout(250);
    }
    throw new Error("IM side never saw the expected message");
  };

  // 1) The user menu → IM 身份 → a one-time code, which the "IM user" sends to the bot by DM.
  await page.goto("/login");
  await page.evaluate((t) => localStorage.setItem("ap.token", t), token);
  await page.goto(`/projects/${project.id}/im`);
  await expect(page.getByText("还没有绑定 IM 群")).toBeVisible();
  await page.getByRole("button", { name: "用户菜单" }).click();
  await page.getByRole("menuitem", { name: "IM 身份" }).click();
  await page.getByRole("button", { name: "生成绑定码" }).click();
  const code = (await page.getByTestId("bind-code").textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{8}$/);
  await inject({ chatId: "dm-owner", chatType: "private", senderId: "mock-owner", text: code });
  await waitFor((s) => s.replies.some((r) => r.markdown.includes("绑定成功")));
  await page.getByRole("button", { name: "关闭" }).click();

  // 2) In the IM group: /bind IME, then a question for the captain and a line from a stranger.
  await inject({ chatId: "mock-chat-ime", chatTitle: "IM 演示群", senderId: "mock-owner", text: "/bind IME" });
  await waitFor((s) => s.replies.some((r) => r.markdown.includes("已绑定到项目「IM 演示」主群")));
  await inject({ chatId: "mock-chat-ime", senderId: "mock-owner", text: "支付回调最近有超时吗？", msgId: "e2e-im-1" });
  await inject({ chatId: "mock-chat-ime", senderId: "mock-stranger", senderNick: "王负责人", text: "我是外部的同事", msgId: "e2e-im-2" });

  await page.reload();
  await expect(page.getByTestId("bindings").getByText("IM 演示群")).toBeVisible();
  await expect(page.getByText("同步中")).toBeVisible();
  await shootBoth(page, "s9-im-bindings");

  // 3) The timeline: the mapped owner's message as themself, the stranger as 外部成员 (INV-20).
  await page.goto(`/projects/${project.id}/chat?g=${project.mainGroupId}`);
  const mine = page.getByTestId("message").filter({ hasText: "支付回调最近有超时吗" }).filter({ hasText: "来自模拟 IM" });
  await expect(mine).toBeVisible();
  await expect(mine.getByText("来自模拟 IM")).toBeVisible();
  const ext = page.getByTestId("message").filter({ hasText: "我是外部的同事" });
  await expect(ext.getByText("外部成员", { exact: true })).toBeVisible();
  await expect(ext.getByText("未映射")).toBeVisible();
  await shootBoth(page, "s9-im-timeline");

  // 4) Binding settings: quiet hours; then unbind.
  await page.goto(`/projects/${project.id}/im`);
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByLabel("免打扰时段").click();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("22:00–08:00")).toBeVisible();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "解绑" }).click();
  await expect(page.getByText(/已失效：已解除绑定/)).toBeVisible();
  con.assertClean();
});
