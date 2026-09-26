import test from "node:test";
import assert from "node:assert/strict";
import { automationTransitionBlockedBy } from "./workflow-automation-runtime.js";

const status = (key: string, order: number, over: Record<string, unknown> = {}) => ({
  key,
  label: key,
  order,
  isFinal: key === "done",
  approval: { required: false, requiredCount: 0, ...(over.approval as object ?? {}) },
  transitions: {
    mode: "open",
    to: [],
    allowRollback: true,
    allowedRoles: ["MEMBER", "ADMIN", "OWNER"],
    allowedUserIds: [],
    assigneeOnly: false,
    creatorOnly: false,
    ...(over.transitions as object ?? {}),
  },
  rules: {},
}) as never;

const open = [status("todo", 0), status("review", 1), status("done", 2)];

test("an unrestricted forward move is allowed", () => {
  assert.equal(automationTransitionBlockedBy(open, "todo", "review"), null);
});

test("completing subtasks cannot push an issue out of an approval-gated status (F-21)", () => {
  // The attack: gate "review", then add+complete a subtask so the automation
  // moves the issue to done without the required sign-off.
  const gated = [
    status("todo", 0),
    status("review", 1, { approval: { required: true, requiredCount: 2 } }),
    status("done", 2),
  ];
  assert.match(automationTransitionBlockedBy(gated, "review", "done") ?? "", /approval/i);
});

test("a rollback out of a gated status is still allowed", () => {
  // Sending work back for changes needs no sign-off — matches
  // assertTransitionPermission, which only gates forward moves.
  const gated = [
    status("todo", 0),
    status("review", 1, { approval: { required: true, requiredCount: 2 } }),
    status("done", 2),
  ];
  assert.equal(automationTransitionBlockedBy(gated, "review", "todo"), null);
});

test("a restricted transition the workflow does not list is refused", () => {
  const restricted = [
    status("todo", 0, { transitions: { mode: "restricted", to: ["review"], allowRollback: false } }),
    status("review", 1),
    status("done", 2),
  ];
  assert.equal(automationTransitionBlockedBy(restricted, "todo", "review"), null);
  assert.match(automationTransitionBlockedBy(restricted, "todo", "done") ?? "", /cannot transition/i);
});

test("person-specific gates are refused — an automation is nobody", () => {
  const assigneeOnly = [status("todo", 0), status("review", 1, { transitions: { assigneeOnly: true } }), status("done", 2)];
  assert.match(automationTransitionBlockedBy(assigneeOnly, "todo", "review") ?? "", /assignee/i);

  const creatorOnly = [status("todo", 0), status("review", 1, { transitions: { creatorOnly: true } }), status("done", 2)];
  assert.match(automationTransitionBlockedBy(creatorOnly, "todo", "review") ?? "", /creator/i);
});

test("an unknown status is refused rather than assumed safe", () => {
  assert.ok(automationTransitionBlockedBy(open, "todo", "nonexistent"));
});
