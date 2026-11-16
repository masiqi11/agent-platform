import { describe, expect, test } from "bun:test";
import { AGENT_TOOL_ROLES, CAPTAIN_FORBIDDEN_TOOLS, can, type Subject } from "../src";

const H = (tenantRole: "owner" | "admin" | "member" | "viewer" | "auditor", projectRole?: "maintainer" | "member" | "viewer"): Subject => ({ kind: "human", tenantRole, projectRole });
const A = (agentRole: "captain" | "sub_captain" | "dev" | "reviewer" | "tester", isProjectMember = true): Subject => ({ kind: "agent", agentRole, isProjectMember });

describe("permission matrix §9.7", () => {
  test("project.create only Owner", () => {
    expect(can(H("owner"), "project.create").allowed).toBe(true);
    expect(can(H("member", "maintainer"), "project.create").allowed).toBe(false);
    expect(can(A("dev"), "project.create").allowed).toBe(false);
  });
  test("bind repo / create group: Owner+Maintainer", () => {
    expect(can(H("member", "maintainer"), "repo.bind").allowed).toBe(true);
    expect(can(H("member", "member"), "repo.bind").allowed).toBe(false);
    expect(can(H("member", "member"), "group.create").allowed).toBe(false);
  });
  test("everyone in project can send messages; viewer cannot", () => {
    for (const s of [H("owner"), H("member", "maintainer"), H("member", "member"), A("dev"), A("reviewer"), A("tester"), A("sub_captain")]) expect(can(s, "message.send").allowed).toBe(true);
    expect(can(H("viewer", "viewer"), "message.send").allowed).toBe(false);
  });
  test("tester agent cannot create tasks; dev and reviewer can", () => {
    expect(can(A("tester"), "task.create").allowed).toBe(false);
    expect(can(A("dev"), "task.create").allowed).toBe(true);
    expect(can(A("reviewer"), "task.create").allowed).toBe(true);
  });
  test("member cannot merge-approve; admin cannot merge-approve; maintainer can", () => {
    expect(can(H("member", "member"), "merge.approve").allowed).toBe(false);
    expect(can(H("admin"), "merge.approve").allowed).toBe(false);
    expect(can(H("member", "maintainer"), "merge.approve").allowed).toBe(true);
    expect(can(H("owner"), "merge.approve").allowed).toBe(true);
  });
  test("budget/credential approvals: Owner+Admin only", () => {
    expect(can(H("admin"), "approval.decide_budget_credential").allowed).toBe(true);
    expect(can(H("member", "maintainer"), "approval.decide_budget_credential").allowed).toBe(false);
  });
  test("cancel: member only own tasks", () => {
    expect(can(H("member", "member"), "task.cancel").allowed).toBe(false);
    expect(can(H("member", "member"), "task.cancel", { isTaskOwner: true }).allowed).toBe(true);
    expect(can(H("admin"), "task.cancel").allowed).toBe(false);
  });
  test("INV-08 reviewer/tester agent cannot act on own (assignee) task", () => {
    expect(can(A("reviewer"), "review.approve", { isTaskAssignee: true }).allowed).toBe(false);
    expect(can(A("reviewer"), "review.approve").allowed).toBe(true);
    expect(can(A("tester"), "test.run").allowed).toBe(true);
    expect(can(A("dev"), "test.run").allowed).toBe(false);
    expect(can(A("dev"), "review.approve").allowed).toBe(false);
  });
  test("dev agent can start/submit only as assignee", () => {
    expect(can(A("dev"), "task.start").allowed).toBe(false);
    expect(can(A("dev"), "task.start", { isTaskAssignee: true }).allowed).toBe(true);
  });
  test("auditor sees audit, not projects", () => {
    expect(can(H("auditor"), "audit.view").allowed).toBe(true);
    expect(can(H("auditor"), "project.view").allowed).toBe(false);
  });
  test("non-member agent denied", () => {
    expect(can(A("dev", false), "message.send").allowed).toBe(false);
  });
  test("INV-07 captain tool set has no state-changing tool", () => {
    for (const role of ["captain", "sub_captain"] as const)
      for (const t of CAPTAIN_FORBIDDEN_TOOLS) expect(AGENT_TOOL_ROLES[role]).not.toContain(t);
  });
  test("denial carries required role", () => {
    const d = can(H("member", "member"), "merge.approve");
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.required).toContain("Maintainer");
  });
});
