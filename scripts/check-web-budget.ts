/**
 * §13.10 front-end budget: first-screen JS (entry + modulepreloads in index.html) ≤ 250 kB gzip,
 * CSS ≤ 40 kB gzip. Run after `bun run build`; exits 1 when over budget.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const dist = join(import.meta.dir, "../apps/web/dist");
const html = readFileSync(join(dist, "index.html"), "utf8");
const assets = (re: RegExp) => [...html.matchAll(re)].map((m) => m[1]!).filter((p) => p.startsWith("/assets/"));
const js = [...new Set([...assets(/<script[^>]+type="module"[^>]+src="([^"]+)"/g), ...assets(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)])];
const css = assets(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g);
const gz = (p: string) => gzipSync(readFileSync(join(dist, p))).length;
const kb = (n: number) => Math.round((n / 1024) * 10) / 10;
const jsBytes = js.reduce((n, p) => n + gz(p), 0);
const cssBytes = css.reduce((n, p) => n + gz(p), 0);
const BUDGET = { js: 250 * 1024, css: 40 * 1024 };
const rows = js.map((p) => `  ${p.padEnd(42)} ${kb(gz(p))} kB`).join("\n");
console.log(`first-screen JS (gzip): ${kb(jsBytes)} kB / ${kb(BUDGET.js)} kB\n${rows}\nCSS (gzip): ${kb(cssBytes)} kB / ${kb(BUDGET.css)} kB`);
const over = [jsBytes > BUDGET.js && "JS", cssBytes > BUDGET.css && "CSS"].filter(Boolean);
if (over.length) {
  console.error(`over budget: ${over.join(", ")}`);
  process.exit(1);
}
