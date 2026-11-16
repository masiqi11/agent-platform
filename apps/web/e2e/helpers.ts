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
