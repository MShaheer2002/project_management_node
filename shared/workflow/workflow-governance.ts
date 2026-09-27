/**
 * Who may change the shape of a project workflow (F-37).
 *
 * Workflow controls — approvals, entry rules, restricted transitions, role or
 * person limits — are an admin's policy. A project lead (any role) used to be
 * able to override them wholesale. Checking individual fields for "weakening"
 * doesn't hold up: approval gates only block *forward* moves by `order`, so
 * reordering statuses or slotting a new status in turns a gated move into an
 * ungated "rollback". So the rule is structural: once a workflow has any
 * control, only admins change its structure; everyone else may change only
 * presentation (label, colour, board/list visibility, reporting category).
 *
 * Pure functions — no Prisma access.
 */
import type { WorkspaceStatusRecord } from "./workflow-automation.js";

/** Who may move issues by default (guests are excluded unless an admin adds them). */
const DEFAULT_MOVER_ROLES = ["OWNER", "ADMIN", "MEMBER"];

/** Does this status carry any admin control? */
export function isControlledStatus(status: WorkspaceStatusRecord) {
  const { approval, rules, transitions } = status;
  return (
    approval.required ||
    Object.values(rules).some(Boolean) ||
    transitions.mode === "restricted" ||
    transitions.assigneeOnly ||
    transitions.creatorOnly ||
    transitions.allowedUserIds.length > 0 ||
    DEFAULT_MOVER_ROLES.some((role) => !transitions.allowedRoles.includes(role as never))
  );
}

export function hasControlledStatus(statuses: WorkspaceStatusRecord[]) {
  return statuses.some(isControlledStatus);
}

const sorted = (values: string[]) => [...values].sort();

/** Everything that decides where an issue may go and who may move it. */
function structureOf(statuses: WorkspaceStatusRecord[]) {
  return JSON.stringify(
    [...statuses]
      .sort((a, b) => a.order - b.order)
      .map((status) => ({
        key: status.key,
        isActive: status.isActive,
        isFinal: status.isFinal,
        transitions: {
          ...status.transitions,
          to: sorted(status.transitions.to),
          allowedRoles: sorted(status.transitions.allowedRoles),
          allowedUserIds: sorted(status.transitions.allowedUserIds),
        },
        rules: status.rules,
        approval: { ...status.approval, reviewerUserIds: sorted(status.approval.reviewerUserIds) },
      })),
  );
}

/** Would going from `current` to `next` change more than presentation? */
export function changesWorkflowStructure(current: WorkspaceStatusRecord[], next: WorkspaceStatusRecord[]) {
  return structureOf(current) !== structureOf(next);
}

/** Only admins restructure a workflow that carries controls. */
export function isWorkflowStructureLocked(isAdmin: boolean, current: WorkspaceStatusRecord[]) {
  return !isAdmin && hasControlledStatus(current);
}
