/**
 * Module boundary check (§5.2): web may import server only as types; modules talk through
 * services, never another module's tables or internals; shared imports nothing app-specific.
 */
import { Glob } from "bun";

const violations: string[] = [];
const scan = async (pattern: string, rule: (file: string, src: string) => string | null) => {
  for await (const f of new Glob(pattern).scan(".")) {
    if (f.includes("node_modules")) continue;
    const msg = rule(f, await Bun.file(f).text());
    if (msg) violations.push(`${f}: ${msg}`);
  }
};

await scan("apps/web/src/**/*.{ts,tsx}", (_f, s) => (/^import (?!type )[^;]*from "@ap\/server/m.test(s) ? "web must import @ap/server with `import type` only" : null));
await scan("packages/shared/src/**/*.ts", (_f, s) => (/from "(elysia|drizzle-orm|pg|react|better-auth)/.test(s) ? "shared must stay framework-free" : null));
await scan("apps/server/src/modules/*/**/*.ts", (f, s) => {
  const mod = f.split("/")[4];
  const m = s.match(/from "\.\.\/(\w+)\/(?!service")[^"]+"/);
  if (m && m[1] !== mod) return `imports internals of module "${m[1]}" (use its service)`;
  return null;
});
await scan("apps/server/src/routes/**/*.ts", (_f, s) => (/from "\.\.\/db\/schema"/.test(s) ? "routes must not touch tables directly; call a service" : null));

if (violations.length) {
  console.error(`check-deps: ${violations.length} violation(s)\n${violations.join("\n")}`);
  process.exit(1);
}
console.log("check-deps: ok");
