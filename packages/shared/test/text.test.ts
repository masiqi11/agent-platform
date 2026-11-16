import { describe, expect, test } from "bun:test";
import { canonicalJson, estimateTokens, findSecrets, isSubstantive, parseAcceptanceCriteria, parseCommand, parseMentions, parseTextToolCalls, redact, similarity, toTsQuery, tokenize, extractFirstJson } from "../src";

describe("tokenize", () => {
  test("CJK unigrams+bigrams and latin words", () => {
    const t = tokenize("支付超时 payment_timeout");
    expect(t).toContain("支付");
    expect(t).toContain("超时");
    expect(t).toContain("payment_timeout");
    expect(t).toContain("timeout");
  });
  test("tsquery is quoted and safe", () => {
    expect(toTsQuery("a'b; drop")).not.toContain(";");
  });
});

describe("mentions (GRP-补2)", () => {
  const c = [
    { principalId: "prn_1", name: "支付船长", kind: "agent" as const },
    { principalId: "prn_2", name: "张 三", kind: "human" as const },
    { principalId: "prn_3", name: "dev", kind: "agent" as const },
    { principalId: "prn_4", name: "dev", kind: "human" as const },
  ];
  test("quoted names with spaces", () => {
    expect(parseMentions('@"张 三" 看一下', c).principalIds).toEqual(["prn_2"]);
  });
  test("prefix match for CJK without separator", () => {
    expect(parseMentions("@支付船长，帮我查一下", c).principalIds).toEqual(["prn_1"]);
  });
  test("ambiguous same names reported", () => {
    const r = parseMentions("@dev hi", c);
    expect(r.principalIds).toEqual([]);
    expect(r.ambiguous).toEqual(["dev"]);
  });
  test("explicit id form after disambiguation", () => {
    expect(parseMentions("@[prn_4] hi", c).principalIds).toEqual(["prn_4"]);
  });
  test("@所有人", () => {
    expect(parseMentions("@所有人 注意", c).all).toBe(true);
  });
});

describe("TRAP-04 acceptance criteria keep newlines", () => {
  test("multi-line list is split by line, not whitespace", () => {
    const ac = parseAcceptanceCriteria("修复超时\n验收标准：\n- 超时阈值可配置 默认 3 秒\n- 重试不超过 2 次\n3. 有回归测试");
    expect(ac).toEqual(["超时阈值可配置 默认 3 秒", "重试不超过 2 次", "有回归测试"]);
  });
  test("/task command preserves newlines in args", () => {
    const c = parseCommand("/task 修复超时\n- a b\n- c");
    expect(c?.name).toBe("task");
    expect(c?.args).toBe("修复超时\n- a b\n- c");
  });
});

describe("TRAP-13 text tool calls", () => {
  test("fenced json", () => {
    const r = parseTextToolCalls('好的\n```json\n{"name":"propose_task","arguments":{"title":"x"}}\n```');
    expect(r).toEqual([{ name: "propose_task", arguments: { title: "x" } }]);
  });
  test("<tool_call> tags and string arguments", () => {
    const r = parseTextToolCalls('<tool_call>{"name":"send_message","arguments":"{\\"body\\":\\"hi\\"}"}</tool_call>');
    expect(r[0]?.arguments).toEqual({ body: "hi" });
  });
  test("openai style function wrapper inside bare text", () => {
    const r = parseTextToolCalls('I will call {"type":"function","function":{"name":"get_task","arguments":{"id":"t"}}} now');
    expect(r[0]?.name).toBe("get_task");
  });
  test("disallowed names are dropped", () => {
    expect(parseTextToolCalls('{"name":"merge","arguments":{}}', ["send_message"])).toEqual([]);
  });
  test("trailing commas tolerated", () => {
    expect(extractFirstJson('{"a":1,}')).toEqual({ a: 1 });
  });
});

describe("misc", () => {
  test("TRAP-02 canonical json is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
  test("secret detection & redaction", () => {
    const s = "key sk-abcdefghijklmnopqrstuvwxyz123 and glpat-abcdefghijklmnopqrstu";
    expect(findSecrets(s).length).toBe(2);
    expect(redact(s)).not.toContain("sk-abc");
    expect(redact("my value hunter2xyz", ["hunter2xyz"])).toBe("my value [REDACTED]");
  });
  test("similarity", () => {
    expect(similarity("支付服务超时修复", "修复支付服务超时问题")).toBeGreaterThan(0.4);
    expect(similarity("支付服务超时", "前端按钮颜色")).toBeLessThan(0.1);
  });
  test("estimateTokens is conservative for CJK", () => {
    expect(estimateTokens("中文测试")).toBe(4);
  });
  test("substantive", () => {
    expect(isSubstantive("👍")).toBe(false);
    expect(isSubstantive("收到")).toBe(false);
    expect(isSubstantive("支付服务超时了")).toBe(true);
  });
});
