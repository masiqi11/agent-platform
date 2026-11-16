import { describe, expect, test } from "bun:test";
import { TASK_STATUSES, TRANSITIONS, checkTransition, emptyFacts, nextStatuses, type TaskActorRole, type TaskFacts, type TaskStatus } from "../src";

const all = (over: Partial<TaskFacts> = {}): TaskFacts => ({
  ...emptyFacts(),
  hasTitle: true,
  hasAcceptanceCriteria: true,
  hasAssignee: true,
  hasHumanOwner: true,
  workspaceReady: true,
  mrOpened: true,
  ciPassed: true,
  evidenceComplete: true,
  reviewApproved: true,
  testPlanExists: true,
  testPassed: true,
  merged: true,
  issueClosed: true,
  mergeApproved: true,
  ...over,
});
const roles = (...r: TaskActorRole[]) => new Set(r);

describe("task state machine (FR-TSK-05)", () => {
  test("every listed legal transition passes with the right actor and facts", () => {
    for (const rule of TRANSITIONS) {
      const froms: TaskStatus[] = rule.from === "*" ? TASK_STATUSES.filter((s) => s !== "done" && s !== "cancelled") : [rule.from];
      for (const from of froms) {
        const r = checkTransition(from, rule.to, roles(rule.actors[0]!), all(), { reason: "x", needs: "y", evidenceArtifactId: "art_1" });
        expect(r.ok).toBe(true);
      }
    }
  });

  test("every unlisted pair is rejected as no_such_transition", () => {
    let rejected = 0;
    for (const from of TASK_STATUSES)
      for (const to of TASK_STATUSES) {
        const legal = TRANSITIONS.some((r) => r.to === to && (r.from === from || (r.from === "*" && from !== "done" && from !== "cancelled")));
        if (legal) continue;
        const r = checkTransition(from, to, roles("maintainer", "human_owner", "assignee_agent", "merge_queue", "reviewer_agent", "tester_agent"), all(), { reason: "x", needs: "y" });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("no_such_transition");
        rejected++;
      }
    expect(rejected).toBeGreaterThan(40);
  });

  test("terminal states have no outgoing transitions (TSK-补1)", () => {
    expect(nextStatuses("done")).toEqual([]);
    expect(nextStatuses("cancelled")).toEqual([]);
    expect(checkTransition("done", "in_progress", roles("maintainer"), all()).ok).toBe(false);
    expect(checkTransition("done", "cancelled", roles("maintainer"), all(), { reason: "x" }).ok).toBe(false);
  });

  test("guards report missing items (backlog → ready)", () => {
    const r = checkTransition("backlog", "ready", roles("human_owner"), all({ hasAcceptanceCriteria: false, hasAssignee: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("guard_failed");
      expect(r.missing).toEqual(["acceptance_criteria", "assignee"]);
      expect(r.reason).toContain("验收标准");
    }
  });

  test("INV-07 captain-like roles cannot transition: only listed actors", () => {
    const r = checkTransition("backlog", "ready", roles(), all());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("actor_not_allowed");
  });

  test("INV-08 dev agent cannot move in_review → testing (needs reviewer)", () => {
    const r = checkTransition("in_review", "testing", roles("assignee_agent"), all());
    expect(r.ok).toBe(false);
  });

  test("only the assignee agent submits for review; humans cannot", () => {
    expect(checkTransition("in_progress", "in_review", roles("maintainer", "human_owner"), all()).ok).toBe(false);
    expect(checkTransition("in_progress", "in_review", roles("assignee_agent"), all()).ok).toBe(true);
  });

  test("blocked requires reason and needs; cancel requires reason", () => {
    expect(checkTransition("in_progress", "blocked", roles("assignee_agent"), all(), { reason: "x" }).ok).toBe(false);
    expect(checkTransition("in_progress", "blocked", roles("assignee_agent"), all(), { reason: "x", needs: "PM" }).ok).toBe(true);
    expect(checkTransition("ready", "cancelled", roles("maintainer"), all(), {}).ok).toBe(false);
  });

  test("testing → done needs merged + issue closed", () => {
    const r = checkTransition("testing", "done", roles("merge_queue"), all({ merged: false, issueClosed: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(["merged", "issue_closed"]);
  });

  test("testing → in_progress requires failure evidence and tester agent", () => {
    expect(checkTransition("testing", "in_progress", roles("tester_agent"), all(), {}).ok).toBe(false);
    expect(checkTransition("testing", "in_progress", roles("tester_agent"), all(), { evidenceArtifactId: "art_1" }).ok).toBe(true);
    expect(checkTransition("testing", "in_progress", roles("assignee_agent"), all(), { evidenceArtifactId: "art_1" }).ok).toBe(false);
  });
});
