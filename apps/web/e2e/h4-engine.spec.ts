import { expect, test } from "@playwright/test";
import { apiToken, seedS5, shootBoth, watchConsole } from "./helpers";

/**
 * ADR-0010 H4: an agent's execution engine + model + reasoning picker. Engines only see models whose
 * provider speaks their wire API (the rest are greyed with the reason); captains have no engine choice.
 */
test("H4: bind 小码 to OpenCode with a chat model and High reasoning; incompatible models are greyed", async ({ page }) => {
  seedS5();
  const con = watchConsole(page);
  const token = await apiToken(page, "owner@xinghe.test");
  await page.goto("/login");
  await page.evaluate((t) => localStorage.setItem("ap.token", t), token);
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const pay = ((await (await page.request.get("/api/v1/projects", auth)).json()) as { id: string; key: string }[]).find((p) => p.key === "DPAY")!;
  // A relay that speaks Chat Completions only (never called here).
  const prov = await page.request.post("/api/v1/admin/models/providers", {
    ...auth,
    data: { name: "中转站", baseUrl: "https://relay.example.com/v1", dialect: "openai", isExternal: true, apiKey: "sk-e2e-not-real-000000", apis: ["chat"], models: [{ name: "relay-opus" }] },
  });
  expect(prov.ok() || prov.status() === 409).toBeTruthy();

  await page.goto(`/projects/${pay.id}/agents`);
  const card = page.getByTestId("agent-card").filter({ hasText: "小码" });
  await expect(card.getByTestId("agent-engine")).toHaveText("内置");
  await card.getByRole("button", { name: /更多|操作/ }).click();
  await page.getByRole("menuitem", { name: /编辑/ }).click();
  const picker = page.getByTestId("engine-model-picker");
  await expect(picker).toBeVisible();
  // Built-in: no reasoning choice.
  await expect(picker.getByRole("radiogroup", { name: "推理强度" })).toHaveCount(0);

  await picker.getByRole("radio", { name: /OpenCode/ }).click();
  await expect(picker).toContainText("Chat Completions");
  await picker.getByRole("radio", { name: /Claude Code/ }).click();
  // Claude Code needs Anthropic Messages: the chat-only relay is greyed with the reason.
  const relayOpt = picker.getByRole("option", { name: /relay-opus/ });
  await expect(relayOpt).toBeDisabled();
  await expect(relayOpt).toContainText("不支持 Anthropic Messages");
  await picker.getByRole("radio", { name: /OpenCode/ }).click();
  await expect(relayOpt).toBeEnabled();
  await relayOpt.click();
  await expect(relayOpt).toHaveAttribute("aria-selected", "true");
  await picker.getByRole("radio", { name: "High" }).click();
  await page.waitForTimeout(200);
  await shootBoth(page, "h4-engine-picker");
  await page.getByRole("button", { name: "保存" }).click();

  await expect(card.getByTestId("agent-engine")).toHaveText("OpenCode");
  await expect(card).toContainText("relay-opus");
  await expect(card).toContainText("high");
  const agents = (await (await page.request.get(`/api/v1/projects/${pay.id}/agents`, auth)).json()) as Array<{ id: string; name: string; engine: string; modelPolicy: Record<string, unknown> }>;
  const xm = agents.find((a) => a.name.includes("小码"))!;
  expect(xm).toMatchObject({ engine: "opencode", modelPolicy: { primary: "relay-opus", reasoning: "high" } });
  await shootBoth(page, "h4-agents-engines");
  con.assertClean();
  // Later specs share this database and run 小码 on the built-in loop (no harness installed in e2e).
  expect((await page.request.patch(`/api/v1/agents/${xm.id}`, { ...auth, data: { engine: "builtin", modelPolicy: {} } })).ok()).toBeTruthy();
});
