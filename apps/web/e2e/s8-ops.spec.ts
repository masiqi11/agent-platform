import { expect, test } from "@playwright/test";
import { apiToken, shootBoth, watchConsole } from "./helpers";

/** S8 ops in the browser: dead-letter panel on the system page, trace lookup by request id, /metrics. */
test("S8: system page shows dead letters and finds a request's trace", async ({ page }) => {
  const con = watchConsole(page);
  const token = await apiToken(page, "owner@xinghe.test");
  await page.goto("/login");
  await page.evaluate((t) => localStorage.setItem("ap.token", t), token);
  const auth = { authorization: `Bearer ${token}` };
  // A request with a known trace id: what a user would copy from an error toast.
  const created = await page.request.post("/api/v1/projects", { headers: { ...auth, "x-request-id": "trc_e2e_ops_lookup" }, data: { key: "OPSE", name: "运维演示" } });
  expect(created.ok() || created.status() === 409).toBeTruthy();

  await page.goto("/admin/system");
  await expect(page.getByRole("heading", { name: /死信/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "链路追踪" })).toBeVisible();
  await page.getByLabel("追踪标识或任务 ID").fill("trc_e2e_ops_lookup");
  await page.getByRole("button", { name: "查询" }).click();
  if (created.ok()) await expect(page.getByTestId("trace-row").filter({ hasText: "project.created" })).toBeVisible();
  await page.getByTestId("trace-row").last().scrollIntoViewIfNeeded();
  await shootBoth(page, "s8-system-trace");

  // Outside production without METRICS_TOKEN, /metrics is open (the e2e server is not production).
  const m = await page.request.get("/metrics");
  expect(m.ok()).toBeTruthy();
  expect(await m.text()).toContain("ap_http_requests_total");
  con.assertClean();
});
