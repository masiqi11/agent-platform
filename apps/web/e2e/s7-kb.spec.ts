import { expect, test } from "@playwright/test";
import { apiToken, seedS5, shootBoth, watchConsole } from "./helpers";

/**
 * S7 exit scenario in the browser: the demo repos get indexed in the background; the project
 * captain answers with clickable citations (file at that commit, lines highlighted); search shows
 * which route found what; on the home page the global captain answers a cross-project question
 * ("超时相关的计费逻辑在哪个仓库哪个文件") by consulting the billing project's captain.
 */
test("S7: knowledge page, explainable search, citations, global captain across projects", async ({ page }) => {
  test.setTimeout(150_000);
  seedS5();
  const con = watchConsole(page);
  const token = await apiToken(page, "owner@xinghe.test");
  await page.goto("/login");
  await page.evaluate((t) => localStorage.setItem("ap.token", t), token);
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const projects = (await (await page.request.get("/api/v1/projects", auth)).json()) as { id: string; key: string }[];
  const pay = projects.find((p) => p.key === "DPAY")!;
  const bill = projects.find((p) => p.key === "DBILL")!;
  // Background indexing (repo.bound → kb.index job) for both demo repos.
  for (const p of [pay, bill])
    await expect
      .poll(
        async () =>
          ((await (await page.request.get(`/api/v1/projects/${p.id}/knowledge/status`, auth)).json()) as { indexes: { repoId: string | null; status: string }[] }).indexes
            .filter((i) => i.repoId)
            .every((i) => i.status === "ready"),
        { timeout: 60_000 },
      )
      .toBe(true);

  await page.goto(`/projects/${pay.id}/knowledge`);
  await expect(page.getByTestId("kb-status")).toContainText("payments");
  await expect(page.getByTestId("kb-catalog")).toContainText("小码");

  // Ask the project captain.
  await page.getByLabel("问项目船长").fill("支付回调如何验签");
  await page.getByTestId("kb-ask").getByRole("button", { name: "提问" }).click();
  const answer = page.getByTestId("kb-answer");
  await expect(answer).toContainText("src/callback.ts");
  await expect(answer.getByTestId("citation").first()).toBeVisible();

  // Explainable search: per-route candidates and per-hit route ranks.
  await page.getByLabel("检索知识库").fill("退款金额校验");
  await page.getByTestId("kb-search").getByRole("button", { name: "检索" }).click();
  await expect(page.getByTestId("kb-results")).toContainText("src/refund.ts");
  await expect(page.getByTestId("kb-search")).toContainText("候选");
  await expect(
    page
      .getByTestId("kb-results")
      .getByText(/关键词 #\d/)
      .first(),
  ).toBeVisible();
  await page.waitForTimeout(300);
  await shootBoth(page, "s7-knowledge", { fullPage: true });

  // INV-04: no evidence.
  await page.getByLabel("问项目船长").fill("量子纠缠的哈密顿量怎么写");
  await page.getByTestId("kb-ask").getByRole("button", { name: "提问" }).click();
  await expect(answer).toContainText("未检索到依据");
  await expect(answer).toContainText("置信度低");

  // Global captain on the home page: cross-project, clickable citation into the billing repo.
  await page.goto("/");
  await page.getByLabel("问全局船长").fill("超时相关的计费逻辑在哪个仓库哪个文件");
  await page.getByTestId("ask-global").getByRole("button", { name: "提问" }).click();
  const g = page.getByTestId("global-answer");
  await expect(g).toContainText("DBILL", { timeout: 30_000 });
  const cite = g.getByTestId("citation").filter({ hasText: "billing/src/payments-client.ts" }).first();
  await expect(cite).toBeVisible();
  await page.waitForTimeout(300);
  await shootBoth(page, "s7-global-captain");
  await cite.click();
  const viewer = page.getByTestId("citation-viewer");
  await expect(viewer).toContainText("PAYMENTS_CALL_TIMEOUT_MS");
  await expect(viewer.locator("[data-hit]").first()).toBeVisible();
  await page.waitForTimeout(300);
  await shootBoth(page, "s7-citation");
  void bill;

  // §8.7: the embedding model is chosen on 模型与预算 (the demo uses the deterministic stand-in).
  await page.keyboard.press("Escape");
  await page.goto("/admin/models");
  const emb = page.getByTestId("embedding-card");
  await expect(emb).toContainText("知识库嵌入");
  await expect(emb.getByLabel("嵌入模型")).toContainText("scripted:embed");
  await expect(page.getByTestId("provider-card").filter({ hasText: "scripted:embed" })).toContainText("嵌入 · 768 维");
  con.assertClean();
});
