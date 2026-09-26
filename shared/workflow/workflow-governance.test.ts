import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkspaceStatuses, type WorkspaceStatusRecord } from "./workflow-automation.js";
import { changesWorkflowStructure, hasControlledStatus, isControlledStatus, isWorkflowStructureLocked } from "./workflow-governance.js";

const base = () => normalizeWorkspaceStatuses([
  { key: "todo", label: "Todo", color: "#3b82f6", order: 0, isFinal: false },
  { key: "review", label: "Review", color: "#8b5cf6", order: 1, isFinal: false },
  { key: "done", label: "Done", color: "#22c55e", order: 2, isFinal: true },
]);

/** The admin's policy: leaving Review needs one approval. */
const gated = () => base().map((s) => (s.key === "review" ? { ...s, approval: { ...s.approval, required: true, requiredCount: 1 } } : s));

const edit = (statuses: WorkspaceStatusRecord[], key: string, change: (s: WorkspaceStatusRecord) => WorkspaceStatusRecord) =>
  statuses.map((s) => (s.key === key ? change(s) : s));

test("default statuses carry no controls", () => {
  assert.equal(hasControlledStatus(base()), false);
});

test("every kind of admin control is recognised", () => {
  const s = base()[1]!;
  const controlled: WorkspaceStatusRecord[] = [
    { ...s, approval: { ...s.approval, required: true } },
    { ...s, rules: { ...s.rules, requireAssignee: true } },
    { ...s, transitions: { ...s.transitions, mode: "restricted" } },
    { ...s, transitions: { ...s.transitions, assigneeOnly: true } },
    { ...s, transitions: { ...s.transitions, creatorOnly: true } },
    { ...s, transitions: { ...s.transitions, allowedUserIds: ["u1"] } },
    { ...s, transitions: { ...s.transitions, allowedRoles: ["OWNER", "ADMIN"] } },  // members can't move issues here
  ];
  for (const status of controlled) assert.equal(isControlledStatus(status), true, JSON.stringify(status));
  assert.equal(isControlledStatus(s), false);
});

test("presentation changes are not structural", () => {
  const next = gated().map((s) => ({ ...s, label: `${s.label}!`, color: "#000000", showOnBoard: !s.showOnBoard, category: "active" as const }));
  assert.equal(changesWorkflowStructure(gated(), next), false);
});

test("re-sent unchanged, including shuffled arrays, is not structural", () => {
  const current = edit(gated(), "review", (s) => ({ ...s, transitions: { ...s.transitions, allowedRoles: ["OWNER", "ADMIN", "MEMBER"] } }));
  const same = edit(current, "review", (s) => ({ ...s, transitions: { ...s.transitions, allowedRoles: ["MEMBER", "ADMIN", "OWNER"] } }));
  assert.equal(changesWorkflowStructure(current, same), false);
});

test("every way around an approval is structural (F-37)", () => {
  const current = gated();
  const bypasses: Array<[string, WorkspaceStatusRecord[]]> = [
    ["drop the approval", edit(current, "review", (s) => ({ ...s, approval: { ...s.approval, required: false } }))],
    ["lower the count", edit(current, "review", (s) => ({ ...s, approval: { ...s.approval, requiredCount: 0 } }))],
    ["pick other reviewers", edit(current, "review", (s) => ({ ...s, approval: { ...s.approval, reviewerSource: "manual", reviewerUserIds: ["me"] } }))],
    // Approval only blocks forward moves: putting Done before Review makes review→done a "rollback".
    ["reorder", [current[0]!, { ...current[2]!, order: 1 }, { ...current[1]!, order: 2 }]],
    ["remove the gated status", current.filter((s) => s.key !== "review")],
    ["deactivate it", edit(current, "review", (s) => ({ ...s, isActive: false }))],
    ["add a status", [...current, { ...current[0]!, key: "shortcut", label: "Shortcut", order: 3 }]],
    ["flip final", edit(current, "done", (s) => ({ ...s, isFinal: false }))],
    ["loosen transitions", edit(current, "todo", (s) => ({ ...s, transitions: { ...s.transitions, allowRollback: !s.transitions.allowRollback } }))],
    ["let guests move issues", edit(current, "done", (s) => ({ ...s, transitions: { ...s.transitions, allowedRoles: [...s.transitions.allowedRoles, "GUEST"] } }))],
  ];
  for (const [what, next] of bypasses) assert.equal(changesWorkflowStructure(current, next), true, what);

  const withRule = edit(current, "done", (s) => ({ ...s, rules: { ...s.rules, requireAssignee: true } }));
  assert.equal(changesWorkflowStructure(withRule, edit(withRule, "done", (s) => ({ ...s, rules: { ...s.rules, requireAssignee: false } }))), true, "drop an entry rule");
});

test("only a non-admin on a controlled workflow is locked", () => {
  assert.equal(isWorkflowStructureLocked(false, gated()), true);
  assert.equal(isWorkflowStructureLocked(true, gated()), false, "admins are never locked");
  assert.equal(isWorkflowStructureLocked(false, base()), false, "no admin controls, nothing to protect");
});
