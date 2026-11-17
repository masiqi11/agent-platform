import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { agent, proposal } from "../src/db/schema";
import { createTestApp, type TestApp } from "./helpers";

/** S8-7: LLM_RECORD_FILE records what the model answered (redacted, no prompts); scripted:replay plays it back. */
const dir = mkdtempSync(join(tmpdir(), "ap-replay-"));
const file = join(dir, "run.jsonl");
const apps: TestApp[] = [];
afterAll(async () => {
  for (const a of apps) await a.close();
  rmSync(dir, { recursive: true, force: true });
});

async function conversation(model: string, env: Record<string, string>) {
  const t = await createTestApp("replay", env);
  apps.push(t);
  const owner = (await t.req("POST", "/api/v1/setup", { body: { tenantName: "R", email: "o@r.test", name: "O", password: "Correct-Horse-42" } })).body.token;
  const p = (await t.req("POST", "/api/v1/projects", { token: owner, body: { key: "RP", name: "回放" } })).body;
  const cap = (await t.req("GET", `/api/v1/projects/${p.id}/agents`, { token: owner })).body.find((a: { role: string }) => a.role === "sub_captain");
  await t.s.db.root
    .update(agent)
    .set({ modelPolicy: { primary: model } })
    .where(eq(agent.id, cap.id));
  const { registerHandlers } = await import("../src/modules/registry");
  await registerHandlers(t.s);
  await t.s.consumers.init();
  const cycle = async () => {
    for (let i = 0; i < 6; i++) if (!(await t.s.consumers.drain()) && !(await t.s.jobs.drain())) break;
  };
  for (const body of [`@[${cap.principalId}] 支付服务最近超时，帮我查一下 sk-recorded-secret-0123456789abcdef`, "从昨天下午 3 点开始，下单接口 p99 超过 30 秒才失败，上游网关 5 秒就断开"]) {
    await t.req("POST", `/api/v1/groups/${p.mainGroupId}/messages`, { token: owner, body: { body } });
    await cycle();
  }
  return (
    await t.s.db.root
      .select()
      .from(proposal)
      .where(and(eq(proposal.groupId, p.mainGroupId), eq(proposal.kind, "create_task")))
  )[0];
}

describe("S8-7 record → replay", () => {
  test("a recorded run replays to the same outcome; the recording holds replies only, redacted", async () => {
    const recorded = await conversation("scripted:demo", { LLM_RECORD_FILE: file });
    expect(recorded).toBeTruthy();
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { purpose: string; content: string; toolCalls: unknown[] });
    expect(lines.some((l) => l.purpose === "captain.turn")).toBe(true);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("sk-recorded-secret"); // redacted (a reply may quote what users wrote)
    // Replies only: never the prompt (system instructions, context, other people's messages).
    for (const l of lines) expect(Object.keys(l).sort()).toEqual(["content", "model", "purpose", "toolCalls", "tools"]);

    process.env.LLM_REPLAY_FILE = file;
    const replayed = await conversation("scripted:replay", {});
    delete process.env.LLM_REPLAY_FILE;
    expect(replayed).toBeTruthy();
    expect((replayed!.payload as { title: string }).title).toBe((recorded!.payload as { title: string }).title);
    expect((replayed!.payload as { acceptanceCriteria: string[] }).acceptanceCriteria).toEqual((recorded!.payload as { acceptanceCriteria: string[] }).acceptanceCriteria);
  });
});
