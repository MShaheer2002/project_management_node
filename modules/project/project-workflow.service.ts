/**
 * Project Module — Workflow Override Service Layer
 *
 * A project may either inherit the workspace's default workflow, or define its
 * own (statuses + automation). This module manages that override — the actual
 * resolution of "which workflow applies" lives in shared/workflow/effective-workflow.ts
 * and is used by every issue/cycle flow that needs it.
 */
import { Prisma } from "../../app/generated/prisma/client.js";
import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { normalizeWorkspaceStatuses, statusVisibleOnBoard } from "../../shared/workflow/workflow-automation.js";
import {
  projectHasWorkflowOverride,
  resolveEffectiveWorkflow,
  type EffectiveWorkflow,
} from "../../shared/workflow/effective-workflow.js";
import {
  validateWorkflowUserReferences,
  validateWorkflowAutomationAgainstStatuses,
  validateWorkflowStatusList,
} from "../../shared/workflow/status-validation.js";
import type {
  ClearProjectWorkflowOverrideInput,
  UpdateProjectWorkflowAutomationInput,
  UpdateProjectWorkflowStatusesInput,
} from "./project.schemas.js";
import type { WorkspaceStatusRecord } from "../../shared/workflow/workflow-automation.js";

type StatusRemovalResolution = UpdateProjectWorkflowStatusesInput["removalResolutions"][number];

async function getWorkspaceAndProject(workspaceId: string, projectId: string) {
  const [workspace, project] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { customStatuses: true, workflowAutomation: true },
    }),
    prisma.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { id: true, customStatuses: true, workflowAutomation: true },
    }),
  ]);

  if (!workspace) {
    throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace not found");
  }
  if (!project) {
    throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
  }

  return { workspace, project };
}

/**
 * Validates that every status being removed from this project's effective workflow
 * is either unused, or has an explicit resolution (move issues to another status,
 * or delete them). Mirrors the workspace-level removal safety net, scoped to this
 * project's issues only.
 */
async function reconcileStatusRemovals(
  projectId: string,
  currentStatuses: WorkspaceStatusRecord[],
  nextStatuses: WorkspaceStatusRecord[],
  removalResolutions: StatusRemovalResolution[],
) {
  const currentKeys = new Set(currentStatuses.map((status) => status.key));
  const newKeys = new Set(nextStatuses.map((status) => status.key));
  const removedKeys = [...currentKeys].filter((key) => !newKeys.has(key));
  const resolutionMap = new Map(removalResolutions.map((resolution) => [resolution.statusKey, resolution]));

  for (const resolution of removalResolutions) {
    if (!removedKeys.includes(resolution.statusKey)) {
      throw new AppError(
        422,
        ERROR_CODES.INVALID_WORKSPACE_STATUSES,
        `Removal resolution references a status that is not being removed: ${resolution.statusKey}`,
      );
    }
  }

  const removedStatusCounts =
    removedKeys.length > 0
      ? await prisma.issue.groupBy({
          by: ["status"],
          where: { projectId, status: { in: removedKeys } },
          _count: { _all: true },
        })
      : [];
  const removedStatusCountMap = new Map<string, number>(
    removedStatusCounts.map((item) => [item.status, item._count._all]),
  );

  const nextStatusMap = new Map(nextStatuses.map((status) => [status.key, status]));

  for (const removedKey of removedKeys) {
    const affectedCount = removedStatusCountMap.get(removedKey) ?? 0;
    if (affectedCount === 0) continue;

    const resolution = resolutionMap.get(removedKey);
    if (!resolution) {
      throw new AppError(
        422,
        ERROR_CODES.INVALID_WORKSPACE_STATUSES,
        `Cannot remove ${removedKey} while ${affectedCount} issue(s) in this project still use it. Move those issues to another status or delete them with the workflow.`,
      );
    }

    if (resolution.action === "move") {
      const target = resolution.targetStatusKey ? nextStatusMap.get(resolution.targetStatusKey) : undefined;
      if (!target) {
        throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, `Destination status ${resolution.targetStatusKey ?? ""} must remain in the workflow list`);
      }
      if (resolution.targetStatusKey === removedKey) {
        throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, `Destination status for ${removedKey} must be different`);
      }
    }
  }

  return { removedKeys, resolutionMap, removedStatusCountMap, nextStatusMap };
}

async function applyStatusRemovals(
  tx: any,
  projectId: string,
  removedKeys: string[],
  resolutionMap: Map<string, StatusRemovalResolution>,
  removedStatusCountMap: Map<string, number>,
  nextStatusMap: Map<string, WorkspaceStatusRecord>,
) {
  for (const removedKey of removedKeys) {
    const affectedCount = removedStatusCountMap.get(removedKey) ?? 0;
    if (affectedCount === 0) continue;

    const resolution = resolutionMap.get(removedKey)!;

    if (resolution.action === "move") {
      const targetStatus = nextStatusMap.get(resolution.targetStatusKey!)!;
      await tx.issue.updateMany({
        where: { projectId, status: removedKey },
        data: {
          status: targetStatus.key,
          completedAt: targetStatus.isFinal ? new Date() : null,
        },
      });
      continue;
    }

    await tx.issue.deleteMany({ where: { projectId, status: removedKey } });
  }
}

export async function getProjectWorkflow(workspaceId: string, projectId: string): Promise<EffectiveWorkflow> {
  const { workspace, project } = await getWorkspaceAndProject(workspaceId, projectId);
  return resolveEffectiveWorkflow(workspace, project);
}

const STATUS_USAGE_PREVIEW_LIMIT = 25;
const STATUS_USAGE_EXPORT_LIMIT = 1000;

export async function getProjectWorkflowStatusUsage(
  workspaceId: string,
  projectId: string,
  statusKey: string,
  limit?: number,
) {
  const { workspace, project } = await getWorkspaceAndProject(workspaceId, projectId);
  const effective = resolveEffectiveWorkflow(workspace, project);
  const status = effective.statuses.find((candidate) => candidate.key === statusKey);

  if (!status) {
    throw new AppError(404, ERROR_CODES.INVALID_WORKSPACE_STATUSES, "Workflow status not found");
  }

  const take = Math.min(limit ?? STATUS_USAGE_PREVIEW_LIMIT, STATUS_USAGE_EXPORT_LIMIT);

  const [issueCount, issues] = await Promise.all([
    prisma.issue.count({ where: { projectId, status: statusKey } }),
    prisma.issue.findMany({
      where: { projectId, status: statusKey },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: take + 1,
      select: { id: true, internalId: true, title: true },
    }),
  ]);

  const truncated = issues.length > take;

  return {
    statusKey,
    label: status.label,
    issueCount,
    truncated,
    issues: issues.slice(0, take).map((issue) => ({ id: issue.internalId, publicId: issue.id, title: issue.title })),
  };
}

/**
 * Merge one status of this project's override into another. Same semantics as
 * the workspace-level merge, scoped to this project's issues only. Requires the
 * project to already have an active override.
 */
export async function mergeProjectWorkflowStatus(
  workspaceId: string,
  projectId: string,
  sourceKey: string,
  targetKey: string,
) {
  if (sourceKey === targetKey) {
    throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, "Merge source and target must be different");
  }

  const { workspace, project } = await getWorkspaceAndProject(workspaceId, projectId);
  if (!projectHasWorkflowOverride(project.customStatuses)) {
    throw new AppError(409, ERROR_CODES.CONFLICT, "This project does not have a custom workflow to merge statuses in");
  }

  const statuses = normalizeWorkspaceStatuses(project.customStatuses as any[]);
  const sourceStatus = statuses.find((status) => status.key === sourceKey);
  const targetStatus = statuses.find((status) => status.key === targetKey);
  if (!sourceStatus) {
    throw new AppError(404, ERROR_CODES.INVALID_WORKSPACE_STATUSES, "Source status not found");
  }
  if (!targetStatus) {
    throw new AppError(404, ERROR_CODES.INVALID_WORKSPACE_STATUSES, "Target status not found");
  }

  const remaining = statuses
    .filter((status) => status.key !== sourceKey)
    .map((status) => ({
      ...status,
      transitions: { ...status.transitions, to: status.transitions.to.filter((key) => key !== sourceKey) },
    }));

  const validatedStatuses = validateWorkflowStatusList(remaining, ERROR_CODES.INVALID_WORKSPACE_STATUSES);
  const nextStatuses = validatedStatuses.map((status, index) => ({
    ...status,
    order: index,
    showOnBoard: statusVisibleOnBoard(status),
  }));

  const updated = await prisma.$transaction(async (tx) => {
    await tx.issue.updateMany({
      where: { projectId, status: sourceKey },
      data: { status: targetKey, completedAt: targetStatus.isFinal ? new Date() : null },
    });
    await tx.issueApproval.deleteMany({ where: { workspaceId, statusKey: sourceKey } });

    return tx.project.update({
      where: { id: projectId },
      data: {
        customStatuses: nextStatuses as any,
        workflowAutomation: validateWorkflowAutomationAgainstStatuses(
          project.workflowAutomation,
          nextStatuses,
          ERROR_CODES.INVALID_WORKSPACE_STATUSES,
        ) as any,
      },
      select: { customStatuses: true, workflowAutomation: true },
    });
  });

  return resolveEffectiveWorkflow(workspace, updated);
}

/**
 * Set or replace this project's workflow override. Any status being removed that's
 * still in use by this project's issues requires an explicit removalResolution.
 */
export async function updateProjectWorkflowStatuses(
  workspaceId: string,
  projectId: string,
  input: UpdateProjectWorkflowStatusesInput,
) {
  const { workspace, project } = await getWorkspaceAndProject(workspaceId, projectId);
  const currentEffective = resolveEffectiveWorkflow(workspace, project);

  const validatedStatuses = validateWorkflowStatusList(input.statuses, ERROR_CODES.INVALID_WORKSPACE_STATUSES);
  await validateWorkflowUserReferences(prisma, workspaceId, validatedStatuses, ERROR_CODES.INVALID_WORKSPACE_STATUSES);

  const nextStatuses = validatedStatuses.map((status, index) => ({
    ...status,
    order: index,
    showOnBoard: statusVisibleOnBoard(status),
  }));

  const { removedKeys, resolutionMap, removedStatusCountMap, nextStatusMap } = await reconcileStatusRemovals(
    projectId,
    currentEffective.statuses,
    nextStatuses,
    input.removalResolutions ?? [],
  );

  const updated = await prisma.$transaction(async (tx) => {
    await applyStatusRemovals(tx, projectId, removedKeys, resolutionMap, removedStatusCountMap, nextStatusMap);

    return tx.project.update({
      where: { id: projectId },
      data: {
        customStatuses: nextStatuses as any,
        // Carries the project's existing automation config forward (renormalized against
        // the new status set) if it already had an override; starts fresh otherwise.
        workflowAutomation: validateWorkflowAutomationAgainstStatuses(
          project.workflowAutomation,
          nextStatuses,
          ERROR_CODES.INVALID_WORKSPACE_STATUSES,
        ) as any,
      },
      select: { customStatuses: true, workflowAutomation: true },
    });
  });

  return resolveEffectiveWorkflow(workspace, updated);
}

/**
 * Clear this project's workflow override, reverting it to the workspace default.
 * Any of the override's status keys that don't exist in the workspace's current
 * default and are still in use require an explicit removalResolution.
 */
export async function clearProjectWorkflowOverride(
  workspaceId: string,
  projectId: string,
  input: ClearProjectWorkflowOverrideInput,
) {
  const { workspace, project } = await getWorkspaceAndProject(workspaceId, projectId);

  if (!projectHasWorkflowOverride(project.customStatuses)) {
    throw new AppError(409, ERROR_CODES.CONFLICT, "This project does not have a custom workflow to clear");
  }

  const currentEffective = resolveEffectiveWorkflow(workspace, project);
  const nextStatuses = normalizeWorkspaceStatuses(workspace.customStatuses as any[]);

  const { removedKeys, resolutionMap, removedStatusCountMap, nextStatusMap } = await reconcileStatusRemovals(
    projectId,
    currentEffective.statuses,
    nextStatuses,
    input.removalResolutions ?? [],
  );

  const updated = await prisma.$transaction(async (tx) => {
    await applyStatusRemovals(tx, projectId, removedKeys, resolutionMap, removedStatusCountMap, nextStatusMap);

    return tx.project.update({
      where: { id: projectId },
      data: { customStatuses: Prisma.JsonNull, workflowAutomation: Prisma.JsonNull },
      select: { customStatuses: true, workflowAutomation: true },
    });
  });

  return resolveEffectiveWorkflow(workspace, updated);
}

/**
 * Replace this project's automation config. Requires a custom workflow to already
 * be active — automation targets reference status keys from the override, so it
 * doesn't make sense to configure automation while inheriting the workspace's.
 */
export async function updateProjectWorkflowAutomation(
  workspaceId: string,
  projectId: string,
  input: UpdateProjectWorkflowAutomationInput,
) {
  const { workspace, project } = await getWorkspaceAndProject(workspaceId, projectId);

  if (!projectHasWorkflowOverride(project.customStatuses)) {
    throw new AppError(409, ERROR_CODES.CONFLICT, "Set a custom workflow for this project before configuring its automation");
  }

  const statuses = normalizeWorkspaceStatuses(project.customStatuses as any[]);
  const normalized = validateWorkflowAutomationAgainstStatuses(input, statuses, ERROR_CODES.INVALID_WORKSPACE_STATUSES);

  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { workflowAutomation: normalized as any },
    select: { workflowAutomation: true, customStatuses: true },
  });

  return resolveEffectiveWorkflow(workspace, updated);
}
