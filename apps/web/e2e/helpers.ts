import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

export const SHOTS = "../../screenshots";
export const PW = "Correct-Horse-42";

/** Takes the same view in light and dark (§13.11). */
export async function shootBoth(page: Page, name: string, opts: { fullPage?: boolean } = {}) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => {
      localStorage.setItem("ap.theme", t);
      document.documentElement.classList.toggle("dark", t === "dark");
    }, theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png`, fullPage: opts.fullPage ?? false });
  }
  await page.evaluate(() => {
    localStorage.setItem("ap.theme", "light");
    document.documentElement.classList.remove("dark");
  });
}

export function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/401|403|404|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return { assertClean: () => expect(errors, errors.join("\n")).toEqual([]) };
}

export async function apiToken(page: Page, email: string, password = PW): Promise<string> {
  const r = await page.request.post("/api/v1/auth/sign-in", { data: { email, password } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).token;
}

/** Seeds the 【演示数据】 project (idempotent) through the server's seed CLI on the e2e database. */
export function seedDemo() {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error("TEST_DATABASE_URL is required");
  const u = new URL(base);
  u.pathname = `/${process.env.E2E_DB ?? "agent_platform_e2e"}`;
  execFileSync("bun", ["src/cli/seed-demo.ts", "--owner", "owner@xinghe.test"], { cwd: "../server", env: { ...process.env, DATABASE_URL: u.toString(), SEED_PASSWORD: PW }, stdio: "inherit" });
}

/** Seeds the S5 demo projects (PAY / BILL with local repos and dev/reviewer/tester agents). */
export function seedS5() {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error("TEST_DATABASE_URL is required");
  const u = new URL(base);
  u.pathname = `/${process.env.E2E_DB ?? "agent_platform_e2e"}`;
  const DATA_DIR = process.env.E2E_DATA_DIR ?? join(tmpdir(), "ap-e2e-data");
  execFileSync("bun", ["src/cli/seed.ts", "--owner", "owner@xinghe.test"], { cwd: "../server", env: { ...process.env, DATABASE_URL: u.toString(), SEED_PASSWORD: PW, DATA_DIR }, stdio: "inherit" });
}
