import { describe, expect, test } from "bun:test";
import { parseDsmlToolCalls, parseTextToolCalls, stripDsml } from "../src/tool-calls";

/** Captured verbatim from deepseek-flash (S8-7): its tool call came back as DSML text, not tool_calls. */
const LIVE =
  '我理解的情况是：支付服务近期出现超时，但还不清楚开始时间、影响范围和严重程度。我先确认几个关键点。\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="ask_question">\n<｜｜DSML｜｜ parameter name="question" string="true">为了准确定位，请补充：1）从什么时候开始出现超时（如昨天 18:00）？2）哪个环境/服务实例（生产、预发；全部还是部分）？3）超时率大概多少、有无报错或监控截图？</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="options" string="false">["我来补充具体时间和监控数据", "先按现有信息建 P1 排查任务", "只是偶发，先观察"]</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="default" string="true">先按现有信息建 P1 排查任务</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="sourceMessageIds" string="false">["msg_01a1ea89cec60004ey7agvy"]</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';

describe("DeepSeek DSML tool-call markup in text content", () => {
  test("parses the live sample into a structured call; string=false values are JSON", () => {
    const calls = parseTextToolCalls(LIVE, ["ask_question", "propose_task"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("ask_question");
    expect(typeof calls[0]!.arguments.question).toBe("string");
    expect(Array.isArray(calls[0]!.arguments.options)).toBe(true);
    expect(calls[0]!.arguments.sourceMessageIds).toEqual(["msg_01a1ea89cec60004ey7agvy"]);
  });
  test("disallowed tool names are dropped; ASCII bars and several invokes work", () => {
    const t = '<|DSML| calls>\n<|DSML| invoke name="a">\n<|DSML| parameter name="x" string="false">1</|DSML| parameter>\n</|DSML| invoke>\n<|DSML| invoke name="b">\n</|DSML| invoke>\n</|DSML| calls>';
    expect(parseDsmlToolCalls(t).map((c) => c.name)).toEqual(["a", "b"]);
    expect(parseDsmlToolCalls(t, ["b"]).map((c) => c.name)).toEqual(["b"]);
    expect(parseDsmlToolCalls(t)[0]!.arguments).toEqual({ x: 1 });
  });
  test("stripDsml leaves only the prose people should see", () => {
    const shown = stripDsml(LIVE);
    expect(shown).not.toContain("DSML");
    expect(shown.startsWith("我理解的情况是")).toBe(true);
    expect(stripDsml("普通回复")).toBe("普通回复");
  });
  test("<tool_call>name {json}</tool_call>: the name outside the JSON object", () => {
    const t = '我先确认几个点。\n\n<tool_call>ask_question {"question":"从什么时候开始？","options":["今天","昨天"]}</tool_call>';
    expect(parseTextToolCalls(t, ["ask_question"])).toEqual([{ name: "ask_question", arguments: { question: "从什么时候开始？", options: ["今天", "昨天"] } }]);
    expect(parseTextToolCalls(t, ["propose_task"])).toEqual([]);
  });
});
