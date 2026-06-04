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
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from "./workspace.schemas.js";

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
export async function createWorkspace(userId: string, input: CreateWorkspaceInput) {
  // Check if slug is already taken
  const existing = await prisma.workspace.findUnique({
    where: { slug: input.slug },
    select: { id: true },
  });

  if (existing) {
    throw new AppError(409, ERROR_CODES.WORKSPACE_SLUG_TAKEN, "This workspace URL is already taken");
  }

  // Create workspace + OWNER membership + default team atomically
  const result = await prisma.$transaction(async (tx) => {
    // 1. Create the workspace
    const ws = await tx.workspace.create({
      data: {
        name: input.name,
        slug: input.slug,
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
    role: "OWNER" as const,
    defaultTeamId: result.defaultTeam.id,
    createdAt: result.workspace.createdAt,
  };
}

/**
 * List all workspaces the user belongs to.
 * Returns workspace details + the user's role in each.
 * Used by frontend to determine if onboarding is needed (empty list = new user).
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
          createdAt: true,
        },
      },
    },
    orderBy: { joinedAt: "desc" },
  });

  return memberships.map((m) => ({
    ...m.workspace,
    role: m.role,
    joinedAt: m.joinedAt,
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
      issueCounter: true,
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

  return workspace;
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
    },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      teamSize: true,
      updatedAt: true,
    },
  });

  return workspace;
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
