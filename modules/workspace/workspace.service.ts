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
import { createInitialWorkspaceSubscription } from "../billing/billing.service.js";
import type { CreateWorkspaceInput, UpdateWorkspaceInput, UpdateWorkspaceStatusesInput } from "./workspace.schemas.js";

function normalizeWorkspaceStatuses(statuses: any[] | null | undefined) {
  return ((statuses as any[]) ?? []).map((status: any, index: number) => ({
    ...status,
    order: typeof status?.order === "number" ? status.order : index,
    showOnBoard: status?.showOnBoard !== false,
  }));
}

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
      uploadPolicy: true,
      updatedAt: true,
    },
  });

  return {
    ...workspace,
    customStatuses: normalizeWorkspaceStatuses(workspace.customStatuses as any[]),
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

/**
 * Replace the entire custom statuses array for a workspace.
 * Validates structure, uniqueness, and business rules.
 */
export async function updateWorkspaceStatuses(workspaceId: string, statuses: UpdateWorkspaceStatusesInput) {
  const KEBAB_CASE_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  if (statuses.length === 0) {
    throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, "At least one status is required");
  }

  if (statuses.length > 20) {
    throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, "Maximum 20 statuses allowed");
  }

  const keys = new Set<string>();
  for (const s of statuses) {
    if (!KEBAB_CASE_REGEX.test(s.key)) {
      throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, `Status key "${s.key}" must be lowercase kebab-case`);
    }
    if (keys.has(s.key)) {
      throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, `Duplicate status key "${s.key}"`);
    }
    keys.add(s.key);
  }

  const hasFinal = statuses.some((s) => s.isFinal);
  if (!hasFinal) {
    throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, "At least one status must have isFinal: true");
  }

  const hasBoardStatus = statuses.some((s) => s.showOnBoard !== false);
  if (!hasBoardStatus) {
    throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, "At least one status must be visible on the board");
  }

  const currentStatuses = await getWorkspaceStatuses(workspaceId);
  const currentKeys = new Set(currentStatuses.map((s: any) => s.key));
  const newKeys = new Set(statuses.map((s) => s.key));
  const removedKeys = [...currentKeys].filter((k) => !newKeys.has(k));

  if (removedKeys.length > 0) {
    const affectedCount = await prisma.issue.count({
      where: { workspaceId, status: { in: removedKeys } },
    });
    if (affectedCount > 0) {
      throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES,
        `Cannot remove statuses that are in use. ${affectedCount} issue(s) use the statuses: ${removedKeys.join(', ')}`);
    }
  }

  const workspace = await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      customStatuses: statuses.map((status, index) => ({
        ...status,
        order: typeof status.order === "number" ? status.order : index,
        showOnBoard: status.showOnBoard !== false,
      })) as any,
    },
    select: { customStatuses: true },
  });

  return workspace.customStatuses as any[];
}
