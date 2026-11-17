import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clean, changedLines, validFindings, run } from "./main-review.mjs";

test("changed line validation rejects context/deleted lines and unknown issue targets", () => {
  const addedLines = changedLines("@@ -8,3 +8,3 @@\n context\n-old\n+new\n context");
  assert.deepEqual(addedLines, [9]);
  const f = { path: "a.js", line: 9, priority: "P1", confidence: 0.95, title: "Bug", body: "Concrete trigger and observable impact with a reproduction." };
  const files = [{ filename: "a.js", addedLines }];
  assert.equal(validFindings({ findings: [f, { ...f, line: 8 }, { ...f, existing_issue_number: 999 }] }, files, []).length, 1);
  assert.throws(() => validFindings({}, files, []));
  assert.equal(clean("sk-12345678901234567890"), "[REDACTED]");
});

test("CI failure is reported even without model credentials; rerun does not duplicate the issue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "main-review-test-"));
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;
  const savedExit = process.exitCode;
  const issues = [];
  let creates = 0;
  try {
    const event = {
      workflow_run: {
        id: 3,
        workflow_id: 1,
        run_number: 3,
        event: "push",
        head_branch: "main",
        head_repository: { full_name: "test/repo" },
        head_sha: "a".repeat(40),
        conclusion: "failure",
        html_url: "https://github.com/test/repo/actions/runs/3",
      },
    };
    await writeFile(join(dir, "event.json"), JSON.stringify(event));
    Object.assign(process.env, { GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_REPOSITORY: "test/repo", GH_TOKEN: "test-only", GITHUB_STEP_SUMMARY: join(dir, "summary.md") });
    delete process.env.DEEPSEEK_API_KEY;
    globalThis.fetch = async (url, init) => {
      const p = new URL(url).pathname;
      let data;
      if (p.endsWith("/jobs")) data = { jobs: [{ name: "check", conclusion: "failure", steps: [{ name: "typecheck", conclusion: "failure" }], html_url: event.workflow_run.html_url }] };
      else if (p.endsWith("/issues") && init.method === "GET") data = issues;
      else if (p.endsWith("/issues") && init.method === "POST") {
        creates++;
        data = { ...JSON.parse(init.body), number: 10, html_url: "https://github.com/test/repo/issues/10" };
        issues.push(data);
      } else throw new Error("Unexpected request: " + p);
      return Response.json(data);
    };
    await run();
    await run();
    assert.equal(creates, 1);
    assert.equal(process.exitCode, 1); // absent model credentials must not look like successful review
    assert.match(issues[0].body, /尚未确认是代码缺陷还是环境问题/);
    await writeFile(join(dir, "event.json"), JSON.stringify({ workflow_run: { ...event.workflow_run, event: "pull_request" } }));
    await assert.rejects(run, /Unexpected event scope/);
  } finally {
    globalThis.fetch = savedFetch;
    process.exitCode = savedExit;
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    await rm(dir, { recursive: true, force: true });
  }
});

test("AI review includes all commits since previous push and publishes only changed-line findings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "main-review-ai-"));
  const saved = { ...process.env };
  const original = globalThis.fetch;
  const code = process.exitCode;
  let published;
  let compared;
  const sha = "b".repeat(40);
  const base = "a".repeat(40);
  try {
    await writeFile(
      join(dir, "event.json"),
      JSON.stringify({
        workflow_run: {
          id: 2,
          workflow_id: 1,
          run_number: 2,
          event: "push",
          head_branch: "main",
          head_repository: { full_name: "test/repo" },
          head_sha: sha,
          conclusion: "success",
          html_url: "https://github.com/test/repo/actions/runs/2",
        },
      }),
    );
    Object.assign(process.env, {
      GITHUB_EVENT_PATH: join(dir, "event.json"),
      GITHUB_REPOSITORY: "test/repo",
      GH_TOKEN: "test-only",
      DEEPSEEK_API_KEY: "test-only",
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
    });
    globalThis.fetch = async (url, init) => {
      const p = new URL(url).pathname;
      let data;
      if (url.startsWith("https://api.deepseek.com/")) {
        const body = JSON.parse(init.body);
        assert.equal(body.thinking.type, "disabled");
        assert.equal(body.messages[1].content.includes("SECRET_FILE"), false);
        data = {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  findings: [
                    {
                      path: "a.js",
                      line: 1,
                      title: "Unchecked input breaks access control",
                      body: "When untrusted input reaches this changed function it bypasses the access control check.",
                      confidence: 0.95,
                      priority: "P1",
                    },
                    { path: "a.js", line: 99, title: "Wrong line", body: "This finding references an unchanged line and must not create an issue.", confidence: 0.99, priority: "P1" },
                  ],
                }),
              },
            },
          ],
        };
      } else if (p.endsWith("/issues") && init.method === "GET") data = [];
      else if (p.endsWith("/runs")) data = { workflow_runs: [{ run_number: 1, head_sha: base }] };
      else if (p.includes("/compare/")) {
        compared = p;
        data = {
          files: [
            { filename: "a.js", patch: "@@ -1 +1 @@\n-old\n+new" },
            { filename: ".env", patch: "+SECRET_FILE" },
          ],
        };
      } else if (p.endsWith("/issues") && init.method === "POST") {
        published = JSON.parse(init.body);
        data = { ...published, number: 1, html_url: "https://github.com/test/repo/issues/1" };
      } else throw new Error("Unexpected route " + p);
      return Response.json(data);
    };
    await run();
    assert.equal(compared, `/repos/test/repo/compare/${base}...${sha}`);
    assert.match(published.title, /Unchecked input/);
    assert.match(published.body, /#L1/);
  } finally {
    globalThis.fetch = original;
    process.exitCode = code;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(dir, { recursive: true, force: true });
  }
});
