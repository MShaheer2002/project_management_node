/**
 * Shared structural validation for a workflow status list.
 *
 * Used by both workspace-level and project-level workflow updates so the two
 * scopes can never silently diverge on what counts as a valid workflow.
 * Pure — no Prisma access. Scope-specific concerns (removing statuses that are
 * still in use, reassigning affected issues) stay in each caller since the
 * affected-issue query differs by scope (workspaceId-wide vs projectId-scoped).
 */
import { AppError } from "../utils/api-error.js";
import type { ErrorCode } from "../errors/error-codes.js";
import {
  normalizeWorkflowAutomation,
  normalizeWorkspaceStatuses,
  statusAllowedInCycle,
  statusVisibleInCycleBoard,
  statusVisibleOnBoard,
  type WorkflowAutomationConfig,
  type WorkspaceStatusRecord,
} from "./workflow-automation.js";

const KEBAB_CASE_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateWorkflowStatusList(
  statuses: Array<{ key: string; isFinal: boolean }>,
  errorCode: ErrorCode,
): WorkspaceStatusRecord[] {
  if (statuses.length === 0) {
    throw new AppError(422, errorCode, "At least one status is required");
  }

  if (statuses.length > 20) {
    throw new AppError(422, errorCode, "Maximum 20 statuses allowed");
  }

  const keys = new Set<string>();
  for (const status of statuses) {
    if (!KEBAB_CASE_REGEX.test(status.key)) {
      throw new AppError(422, errorCode, `Status key "${status.key}" must be lowercase kebab-case`);
    }
    if (keys.has(status.key)) {
      throw new AppError(422, errorCode, `Duplicate status key "${status.key}"`);
    }
    keys.add(status.key);
  }

  const hasFinal = statuses.some((status) => status.isFinal);
  if (!hasFinal) {
    throw new AppError(422, errorCode, "At least one status must have isFinal: true");
  }

  const normalizedStatuses = normalizeWorkspaceStatuses(statuses as any[]);
  const activeStatuses = normalizedStatuses.filter((status) => status.isActive !== false);

  if (activeStatuses.length === 0) {
    throw new AppError(422, errorCode, "At least one workflow must stay active");
  }

  if (!activeStatuses.some((status) => statusVisibleOnBoard(status))) {
    throw new AppError(422, errorCode, "At least one status must be visible on the board");
  }

  if (!activeStatuses.some((status) => status.visibility.list !== false)) {
    throw new AppError(422, errorCode, "At least one status must stay visible in list views");
  }

  if (!activeStatuses.some((status) => status.visibility.create !== false)) {
    throw new AppError(422, errorCode, "At least one status must stay visible when creating issues");
  }

  const planningDefaults = normalizedStatuses.filter((status) => status.cycle.planIntoThisStatus);
  if (planningDefaults.length > 1) {
    throw new AppError(422, errorCode, "Only one status can be the default cycle planning status");
  }

  for (const status of normalizedStatuses) {
    const invalidTransitionTarget = status.transitions.to.find(
      (targetKey) => !normalizedStatuses.some((candidate) => candidate.key === targetKey),
    );
    if (invalidTransitionTarget) {
      throw new AppError(422, errorCode, `Status ${status.label} references unknown transition target ${invalidTransitionTarget}`);
    }
  }

  const invalidCyclePlanningTarget = planningDefaults.find(
    (status) => !statusAllowedInCycle(status) || status.isFinal || status.category === "backlog",
  );
  if (invalidCyclePlanningTarget) {
    throw new AppError(422, errorCode, "Cycle planning default must be a non-final active cycle status");
  }

  for (const status of normalizedStatuses) {
    if (status.approval.required && status.approval.reviewerSource === "manual" && status.approval.reviewerUserIds.length === 0) {
      throw new AppError(422, errorCode, `${status.label} requires approval but has no manual reviewers selected`);
    }
  }

  return normalizedStatuses;
}

/**
 * Validates that every user id referenced by transition rules (allowedUserIds)
 * or manual approval reviewers is an actual member of the workspace —
 * regardless of whether the workflow itself is workspace-scoped or
 * project-scoped, the referenced people are always workspace members.
 */
export async function validateWorkflowUserReferences(
  prisma: { workspaceMembership: { findMany: (args: any) => Promise<Array<{ userId: string }>> } },
  workspaceId: string,
  statuses: WorkspaceStatusRecord[],
  errorCode: ErrorCode,
): Promise<void> {
  const referencedUserIds = [
    ...new Set(
      statuses.flatMap((status) => [...status.transitions.allowedUserIds, ...status.approval.reviewerUserIds]),
    ),
  ];
  if (referencedUserIds.length === 0) return;

  const memberships = await prisma.workspaceMembership.findMany({
    where: { workspaceId, userId: { in: referencedUserIds } },
    select: { userId: true },
  });
  const memberIds = new Set(memberships.map((membership) => membership.userId));
  const invalidUserId = referencedUserIds.find((userId) => !memberIds.has(userId));
  if (invalidUserId) {
    throw new AppError(422, errorCode, `Workflow rules reference a user who is not a workspace member: ${invalidUserId}`);
  }
}

/**
 * Validates a workflow automation config against the status set it's meant to run on
 * (every enabled automation must target a status that actually exists, with the right
 * shape — e.g. a completion target must be final). Shared between workspace-level and
 * project-level automation updates so the two can't silently diverge on these rules.
 */
export function validateWorkflowAutomationAgainstStatuses(
  rawAutomation: unknown,
  statuses: WorkspaceStatusRecord[],
  errorCode: ErrorCode,
): WorkflowAutomationConfig {
  const statusKeys = new Set(statuses.map((status) => status.key));
  const finalKeys = new Set(statuses.filter((status) => status.isFinal).map((status) => status.key));
  const activeKeys = new Set(
    statuses.filter((status) => status.isFinal !== true && statusVisibleOnBoard(status)).map((status) => status.key),
  );
  const cycleBoardKeys = new Set(
    statuses
      .filter((status) => status.isFinal !== true && statusVisibleInCycleBoard(status) && statusAllowedInCycle(status))
      .map((status) => status.key),
  );

  const requireStatus = (statusKey: string | null, field: string) => {
    if (!statusKey || !statusKeys.has(statusKey)) {
      throw new AppError(422, errorCode, `${field} must reference an existing status`);
    }
  };

  const normalized = normalizeWorkflowAutomation(rawAutomation, statuses);

  if (normalized.subtaskCompletion.enabled) {
    requireStatus(normalized.subtaskCompletion.targetStatusKey, "Subtask completion target");
    if (!finalKeys.has(normalized.subtaskCompletion.targetStatusKey!)) {
      throw new AppError(422, errorCode, "Subtask completion target must be a final status");
    }
  }

  if (normalized.cycleStart.enabled) {
    requireStatus(normalized.cycleStart.fromStatusKey, "Cycle start source status");
    requireStatus(normalized.cycleStart.targetStatusKey, "Cycle start target status");
    if (!cycleBoardKeys.has(normalized.cycleStart.targetStatusKey!)) {
      throw new AppError(422, errorCode, "Cycle start target must be a cycle-board-visible active status");
    }
    if (normalized.cycleStart.fromStatusKey === normalized.cycleStart.targetStatusKey) {
      throw new AppError(422, errorCode, "Cycle start source and target must be different");
    }
  }

  if (normalized.githubPullRequest.opened.enabled) {
    requireStatus(normalized.githubPullRequest.opened.targetStatusKey, "GitHub PR opened target");
    if (!activeKeys.has(normalized.githubPullRequest.opened.targetStatusKey!)) {
      throw new AppError(422, errorCode, "GitHub PR opened target must be a board-visible active status");
    }
  }

  if (normalized.githubPullRequest.merged.enabled) {
    requireStatus(normalized.githubPullRequest.merged.targetStatusKey, "GitHub PR merged target");
    if (!finalKeys.has(normalized.githubPullRequest.merged.targetStatusKey!)) {
      throw new AppError(422, errorCode, "GitHub PR merged target must be a final status");
    }
  }

  return normalized;
}
