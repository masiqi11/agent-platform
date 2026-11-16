import { describe, expect, test } from "bun:test";
import { chunkCode, chunkDoc, chunkFile, exclusionReason, matchesPattern, rrf } from "../src/kb";

describe("KB-补1 exclusions", () => {
  test("defaults: lock files, env, keys, binaries, vendored, build output, oversize, unsupported", () => {
    expect(exclusionReason("bun.lock", 10)).toContain("excluded");
    expect(exclusionReason("apps/x/.env.local", 10)).toContain(".env*");
    expect(exclusionReason("certs/server.pem", 10)).toContain("*.pem");
    expect(exclusionReason("node_modules/a/index.js", 10)).toContain("node_modules/");
    expect(exclusionReason("web/dist/app.min.js", 10)).toBeTruthy();
    expect(exclusionReason("logo.png", 10)).toContain("*.png");
    expect(exclusionReason("src/a.ts", 2_000_000)).toBe("too_large");
    expect(exclusionReason("data.bin", 10)).toBe("unsupported_type");
    expect(exclusionReason("src/gateway.ts", 100)).toBeNull();
    expect(exclusionReason("docs/timeouts.md", 100)).toBeNull();
    expect(exclusionReason("src/secret/x.ts", 100, ["src/secret/"])).toContain("src/secret/");
  });
  test("pattern matching", () => {
    expect(matchesPattern("a/b/dist/x.js", "dist/")).toBe(true);
    expect(matchesPattern("distance.ts", "dist/")).toBe(false);
    expect(matchesPattern("x/y.min.js", "*.min.js")).toBe(true);
  });
});

describe("chunkers", () => {
  test("code: one chunk per declaration with leading comments, preamble separate, lines kept", () => {
    const src = [
      'import { a } from "./a";',
      "",
      "/** 上游网关 5 秒断开 */",
      "export const UPSTREAM = 5_000;",
      "",
      "export async function callGateway(fn: () => Promise<void>) {",
      "  return fn();",
      "}",
      "",
      "class Helper {",
      "  x = 1;",
      "}",
    ].join("\n");
    const c = chunkCode(src);
    expect(c.map((x) => x.symbol)).toEqual([null, "UPSTREAM", "callGateway", "Helper"]);
    expect(c[1]).toMatchObject({ startLine: 3, endLine: 5 });
    expect(c[1]!.text).toContain("上游网关");
    expect(c[2]).toMatchObject({ startLine: 6, endLine: 9 });
  });
  test("code without declarations and very long blocks are windowed", () => {
    const long = Array.from({ length: 200 }, (_, i) => `x${i}();`).join("\n");
    const c = chunkCode(long);
    expect(c.length).toBe(3);
    expect(c[2]!.startLine).toBe(161);
  });
  test("docs: one chunk per heading section", () => {
    const md = "# 超时约定\n\n总则\n\n## 支付网关\n上游 5s\n\n## 计费 → 支付\n单次 3s\n";
    const c = chunkDoc(md);
    expect(c.map((x) => x.symbol)).toEqual(["超时约定", "支付网关", "计费 → 支付"]);
    expect(c[2]).toMatchObject({ startLine: 8 });
  });
  test("chunkFile picks by type", () => {
    expect(chunkFile("README.md", "# t\nx")[0]!.symbol).toBe("t");
    expect(chunkFile("a.json", '{"a":1}')[0]!.symbol).toBeNull();
  });
});

describe("RRF", () => {
  test("items found by several routes rank higher", () => {
    const s = rrf([
      [{ id: "a" }, { id: "b" }],
      [{ id: "b" }, { id: "c" }],
    ]);
    expect([...s.entries()].sort((x, y) => y[1] - x[1])[0]![0]).toBe("b");
  });
});
