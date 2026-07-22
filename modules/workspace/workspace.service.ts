/**
 * Workspace Module — Service Layer
 *
 * Business logic for workspace CRUD operations.
 * All workspace queries are scoped correctly — no cross-tenant leaks.
 *
 * Key operations:
 *   - Create workspace + OWNER membership in a single transaction
 *   - List workspaces for a user (returns workspaces they belong to)
 *   - Check slug availability
 *   - Update/delete workspace with permission enforcement
 */

import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import {
  normalizeWorkflowAutomation,
  normalizeWorkspaceStatuses,
  statusVisibleOnBoard,
} from "../../shared/workflow/workflow-automation.js";
import {
  validateWorkflowUserReferences,
  validateWorkflowAutomationAgainstStatuses,
  validateWorkflowStatusList,
} from "../../shared/workflow/status-validation.js";
import { createInitialWorkspaceSubscription } from "../billing/billing.service.js";
import type {
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  UpdateWorkspaceStatusesInput,
  UpdateWorkflowAutomationInput,
} from "./workspace.schemas.js";

/**
 * Create a workspace and set up the initial structure:
 *   1. Create Workspace
 *   2. Create WorkspaceMembership (OWNER) for the creator
 *   3. Create a default Team (same name as workspace) with creator as lead
 *   4. Create TeamMembership for the creator in the default team
 *
 * All records are created in a single transaction — if any fails, nothing is persisted.
 * The default team ensures the workspace is immediately usable (issues, projects, cycles
 * all belong to a team, so at least one team must exist).
 */
/**
 * Generate an issue prefix from the workspace name.
 * Takes first 2-3 uppercase letters, deduplicates by appending a digit if taken.
 *
 * Examples: "Vative" → "VAT", "Fission" → "FIS", "My App" → "MA"
 */
async function generateUniquePrefix(name: string, explicitPrefix?: string): Promise<string> {
  if (explicitPrefix) {
    const normalized = explicitPrefix.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5);
    if (normalized.length < 2) {
      throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "Issue prefix must be at least 2 uppercase letters");
    }
    const existing = await prisma.workspace.findUnique({
      where: { issuePrefix: normalized },
      select: { id: true },
    });
    if (existing) {
      throw new AppError(409, ERROR_CODES.WORKSPACE_PREFIX_TAKEN, `Issue prefix "${normalized}" is already taken`);
    }
    return normalized;
  }

  // Auto-generate from name: take uppercase consonants + first letter, 2-3 chars
  const letters = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
  const base = letters.length >= 3 ? letters.slice(0, 3) : letters.slice(0, Math.max(2, letters.length));

  if (base.length < 2) {
    // Fallback for very short names
    return generateUniquePrefix(name, `${base}X`);
  }

  // Check if base is available
  const existing = await prisma.workspace.findUnique({
    where: { issuePrefix: base },
    select: { id: true },
  });

  if (!existing) return base;

  // Try with suffix: VAT → VAT2 → VAT3 → ...
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base.slice(0, 3)}${i}`;
    const taken = await prisma.workspace.findUnique({
      where: { issuePrefix: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }

  // Extremely unlikely fallback
  throw new AppError(409, ERROR_CODES.WORKSPACE_PREFIX_TAKEN, "Could not generate a unique issue prefix");
}

export async function createWorkspace(userId: string, input: CreateWorkspaceInput) {
  // Check if slug is already taken
  const existing = await prisma.workspace.findUnique({
    where: { slug: input.slug },
    select: { id: true },
  });

  if (existing) {
    throw new AppError(409, ERROR_CODES.WORKSPACE_SLUG_TAKEN, "This workspace URL is already taken");
  }

  // Generate or validate issue prefix
  const issuePrefix = await generateUniquePrefix(input.name, (input as any).issuePrefix);

  // Create workspace + OWNER membership + default team atomically
  const result = await prisma.$transaction(async (tx) => {
    // 1. Create the workspace
    const ws = await tx.workspace.create({
      data: {
        name: input.name,
        slug: input.slug,
        issuePrefix,
        teamSize: input.teamSize ?? null,
        createdById: userId,
      },
    });

    // 2. Make the creator the OWNER
    await tx.workspaceMembership.create({
      data: {
        userId,
        workspaceId: ws.id,
        role: "OWNER",
      },
    });

    // 3. Create a default team with the same name as the workspace
    //    Every workspace needs at least one team — issues, projects, and cycles
    //    all belong to a team. This makes the workspace immediately usable.
    const defaultTeam = await tx.team.create({
      data: {
        workspaceId: ws.id,
        name: input.name,
        leadId: userId,
      },
    });

    // 4. Add the creator as a member of the default team
    await tx.teamMembership.create({
      data: {
        userId,
        teamId: defaultTeam.id,
      },
    });

    // 5. Create the initial FREE workspace subscription state
    await createInitialWorkspaceSubscription(tx, ws.id);

    return { workspace: ws, defaultTeam };
  });

  return {
    id: result.workspace.id,
    name: result.workspace.name,
    slug: result.workspace.slug,
    logo: result.workspace.logo,
    teamSize: result.workspace.teamSize,
    issuePrefix: result.workspace.issuePrefix,
    customStatuses: normalizeWorkspaceStatuses((result.workspace as any).customStatuses),
    workflowAutomation: normalizeWorkflowAutomation(
      (result.workspace as any).workflowAutomation,
      (result.workspace as any).customStatuses,
    ),
    role: "OWNER" as const,
    defaultTeamId: result.defaultTeam.id,
    createdAt: result.workspace.createdAt,
  };
}

/**
 * List all workspaces the user belongs to.
 * Returns workspace details + the user's role in each + default team + unread notifications.
 * Used by frontend to populate workspace switcher and determine onboarding state.
 */
export async function listWorkspaces(userId: string) {
  const memberships = await prisma.workspaceMembership.findMany({
    where: { userId },
    include: {
      workspace: {
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          teamSize: true,
          issuePrefix: true,
          customStatuses: true,
          workflowAutomation: true,
          uploadPolicy: true,
          createdAt: true,
        },
      },
    },
    orderBy: { joinedAt: "desc" },
  });

  const workspaceIds = memberships.map((m) => m.workspaceId);

  if (workspaceIds.length === 0) {
    return [];
  }

  // Batch: per-workspace unread notification counts + default team per workspace
  const [unreadCounts, defaultTeams] = await Promise.all([
    (prisma as any).notification.groupBy({
      by: ["workspaceId"],
      where: {
        recipientUserId: userId,
        readAt: null,
        workspaceId: { in: workspaceIds },
      },
      _count: true,
    }),
    prisma.team.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: { id: true, workspaceId: true },
      orderBy: { createdAt: "asc" },
      distinct: ["workspaceId"],
    }),
  ]);

  const unreadMap = new Map<string, number>(
    unreadCounts.map((c: any) => [c.workspaceId, c._count]),
  );
  const defaultTeamMap = new Map<string, string>(
    defaultTeams.map((t: { id: string; workspaceId: string }) => [t.workspaceId, t.id]),
  );

  return memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    slug: m.workspace.slug,
    logo: m.workspace.logo,
    teamSize: m.workspace.teamSize,
    issuePrefix: m.workspace.issuePrefix,
    customStatuses: normalizeWorkspaceStatuses(m.workspace.customStatuses as any[]),
    workflowAutomation: normalizeWorkflowAutomation(
      m.workspace.workflowAutomation,
      m.workspace.customStatuses as any[],
    ),
    uploadPolicy: m.workspace.uploadPolicy,
    role: m.role,
    defaultTeamId: defaultTeamMap.get(m.workspace.id) ?? null,
    unreadNotifications: unreadMap.get(m.workspace.id) ?? 0,
    joinedAt: m.joinedAt,
    createdAt: m.workspace.createdAt,
  }));
}

/**
 * Get workspace details by ID.
 * Only returns data if the user is a member (enforced by requireWorkspace middleware).
 */
export async function getWorkspaceById(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      teamSize: true,
      issuePrefix: true,
      issueCounter: true,
      customStatuses: true,
      workflowAutomation: true,
      uploadPolicy: true,
      createdById: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          memberships: true,
          projects: true,
          issues: true,
          teams: true,
          departments: true,
        },
      },
    },
  });

  if (!workspace) {
    throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace not found");
  }

  return {
    ...workspace,
    customStatuses: normalizeWorkspaceStatuses(workspace.customStatuses as any[]),
    workflowAutomation: normalizeWorkflowAutomation(workspace.workflowAutomation, workspace.customStatuses as any[]),
  };
}

/**
 * Update workspace settings (name, logo).
 * Slug cannot be changed after creation.
 */
export async function updateWorkspace(workspaceId: string, input: UpdateWorkspaceInput) {
  const workspace = await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.logo !== undefined && { logo: input.logo }),
      ...(input.uploadPolicy !== undefined && { uploadPolicy: input.uploadPolicy }),
    },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      teamSize: true,
      customStatuses: true,
      workflowAutomation: true,
      uploadPolicy: true,
      updatedAt: true,
    },
  });

  return {
    ...workspace,
    customStatuses: normalizeWorkspaceStatuses(workspace.customStatuses as any[]),
    workflowAutomation: normalizeWorkflowAutomation(workspace.workflowAutomation, workspace.customStatuses as any[]),
  };
}

/**
 * Delete a workspace and ALL its data (cascade).
 * This is irreversible — departments, teams, projects, issues, comments, everything is gone.
 */
export async function deleteWorkspace(workspaceId: string) {
  await prisma.workspace.delete({ where: { id: workspaceId } });
}

/**
 * Check if a slug is available.
 * Used by frontend for real-time validation as user types.
 */
export async function checkSlugAvailability(slug: string) {
  const existing = await prisma.workspace.findUnique({
    where: { slug },
    select: { id: true },
  });

  return { available: !existing };
}

/**
 * Get workspace custom statuses.
 */
export async function getWorkspaceStatuses(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { customStatuses: true },
  });

  if (!workspace) {
    throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace not found");
  }

  return normalizeWorkspaceStatuses(workspace.customStatuses as any[]);
}

const STATUS_USAGE_PREVIEW_LIMIT = 25;
const STATUS_USAGE_EXPORT_LIMIT = 1000;

export async function getWorkspaceStatusUsage(workspaceId: string, statusKey: string, limit?: number) {
  const statuses = await getWorkspaceStatuses(workspaceId);
  const status = statuses.find((item) => item.key === statusKey);

  if (!status) {
    throw new AppError(404, ERROR_CODES.INVALID_WORKSPACE_STATUSES, "Workflow status not found");
  }

  const take = Math.min(limit ?? STATUS_USAGE_PREVIEW_LIMIT, STATUS_USAGE_EXPORT_LIMIT);

  const [issueCount, issues] = await Promise.all([
    prisma.issue.count({
      where: { workspaceId, status: statusKey },
    }),
    prisma.issue.findMany({
      where: { workspaceId, status: statusKey },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: take + 1,
      select: {
        id: true,
        internalId: true,
        title: true,
        project: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    }),
  ]);

  const truncated = issues.length > take;

  return {
    statusKey,
    label: status.label,
    issueCount,
    truncated,
    issues: issues.slice(0, take).map((issue) => ({
      id: issue.internalId,
      publicId: issue.id,
      title: issue.title,
      project: issue.project
        ? {
            id: issue.project.id,
            name: issue.project.name,
          }
        : null,
    })),
  };
}

/**
 * Merge one status into another: every issue currently on sourceKey moves to
 * targetKey, then sourceKey is removed from the workflow (and stripped from any
 * other status's transition list). A dedicated action instead of routing merges
 * through the generic "replace the whole status list" update — safer, since the
 * caller doesn't have to resend every other status untouched.
 */
export async function mergeWorkspaceStatus(workspaceId: string, sourceKey: string, targetKey: string) {
  if (sourceKey === targetKey) {
    throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, "Merge source and target must be different");
  }

  const statuses = await getWorkspaceStatuses(workspaceId);
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

  const currentWorkspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { workflowAutomation: true },
  });
  if (!currentWorkspace) {
    throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace not found");
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.issue.updateMany({
      where: { workspaceId, status: sourceKey },
      data: { status: targetKey, completedAt: targetStatus.isFinal ? new Date() : null },
    });
    await tx.issueApproval.deleteMany({ where: { workspaceId, statusKey: sourceKey } });

    return tx.workspace.update({
      where: { id: workspaceId },
      data: {
        customStatuses: nextStatuses as any,
        workflowAutomation: normalizeWorkflowAutomation(currentWorkspace.workflowAutomation, nextStatuses) as any,
      },
      select: { customStatuses: true },
    });
  });

  return updated.customStatuses as any[];
}

/**
 * Get workflow automation config for a workspace.
 */
export async function getWorkflowAutomation(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { customStatuses: true, workflowAutomation: true },
  });

  if (!workspace) {
    throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace not found");
  }

  return normalizeWorkflowAutomation(workspace.workflowAutomation, workspace.customStatuses as any[]);
}

/**
 * Replace the entire custom statuses array for a workspace.
 * Validates structure, uniqueness, and business rules.
 */
export async function updateWorkspaceStatuses(workspaceId: string, input: UpdateWorkspaceStatusesInput) {
  const statuses = input.statuses;
  const removalResolutions = input.removalResolutions ?? [];

  const normalizedStatuses = validateWorkflowStatusList(statuses, ERROR_CODES.INVALID_WORKSPACE_STATUSES);
  await validateWorkflowUserReferences(prisma, workspaceId, normalizedStatuses, ERROR_CODES.INVALID_WORKSPACE_STATUSES);

  const currentStatuses = await getWorkspaceStatuses(workspaceId);
  const currentKeys = new Set(currentStatuses.map((s: any) => s.key));
  const newKeys = new Set(statuses.map((s) => s.key));
  const removedKeys = [...currentKeys].filter((k) => !newKeys.has(k));
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
      ? await (prisma as any).issue.groupBy({
          by: ["status"],
          where: { workspaceId, status: { in: removedKeys } },
          _count: { _all: true },
        })
      : [];

  const removedStatusCountMap = new Map<string, number>(
    (removedStatusCounts as Array<{ status: string; _count: { _all: number } }>).map((item) => [item.status, item._count._all]),
  );

  for (const removedKey of removedKeys) {
    const affectedCount = removedStatusCountMap.get(removedKey) ?? 0;
    if (affectedCount === 0) continue;

    const resolution = resolutionMap.get(removedKey);
    if (!resolution) {
      throw new AppError(
        422,
        ERROR_CODES.INVALID_WORKSPACE_STATUSES,
        `Cannot remove ${removedKey} while ${affectedCount} issue(s) still use it. Move those issues to another workflow or delete them with the workflow.`,
      );
    }

    if (resolution.action === "move") {
      if (!resolution.targetStatusKey) {
        throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, `A destination workflow is required for ${removedKey}`);
      }
      if (!newKeys.has(resolution.targetStatusKey)) {
        throw new AppError(
          422,
          ERROR_CODES.INVALID_WORKSPACE_STATUSES,
          `Destination workflow ${resolution.targetStatusKey} must remain in the workflow list`,
        );
      }
      if (resolution.targetStatusKey === removedKey) {
        throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, `Destination workflow for ${removedKey} must be different`);
      }
    }
  }

  const currentWorkspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { workflowAutomation: true },
  });

  if (!currentWorkspace) {
    throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace not found");
  }

  const nextStatuses = normalizedStatuses.map((status, index) => ({
    ...status,
    order: index,
    showOnBoard: statusVisibleOnBoard(status),
  }));
  const nextStatusMap = new Map(nextStatuses.map((status) => [status.key, status]));

  const workspace = await prisma.$transaction(async (tx) => {
    for (const removedKey of removedKeys) {
      const affectedCount = removedStatusCountMap.get(removedKey) ?? 0;
      if (affectedCount === 0) continue;

      const resolution = resolutionMap.get(removedKey)!;

      if (resolution.action === "move") {
        const targetStatus = nextStatusMap.get(resolution.targetStatusKey!);
        if (!targetStatus) {
          throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, `Destination workflow ${resolution.targetStatusKey} was not found`);
        }

        await tx.issue.updateMany({
          where: { workspaceId, status: removedKey },
          data: {
            status: targetStatus.key,
            completedAt: targetStatus.isFinal ? new Date() : null,
          },
        });
        continue;
      }

      await tx.issue.deleteMany({
        where: { workspaceId, status: removedKey },
      });
    }

    return tx.workspace.update({
      where: { id: workspaceId },
      data: {
        customStatuses: nextStatuses as any,
        workflowAutomation: normalizeWorkflowAutomation(
          currentWorkspace.workflowAutomation,
          nextStatuses,
        ) as any,
      },
      select: { customStatuses: true },
    });
  });

  return workspace.customStatuses as any[];
}

/**
 * Replace workflow automation config for a workspace.
 */
export async function updateWorkflowAutomation(
  workspaceId: string,
  input: UpdateWorkflowAutomationInput,
) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { customStatuses: true },
  });

  if (!workspace) {
    throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace not found");
  }

  const statuses = normalizeWorkspaceStatuses(workspace.customStatuses as any[]);
  const normalized = validateWorkflowAutomationAgainstStatuses(input, statuses, ERROR_CODES.INVALID_WORKSPACE_STATUSES);

  const updated = await prisma.workspace.update({
    where: { id: workspaceId },
    data: { workflowAutomation: normalized as any },
    select: { workflowAutomation: true, customStatuses: true },
  });

  return normalizeWorkflowAutomation(updated.workflowAutomation, updated.customStatuses as any[]);
}
