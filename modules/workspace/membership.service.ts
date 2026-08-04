/**
 * Workspace Membership — Service Layer
 *
 * Handles member management within a workspace:
 *   - Invite members by email
 *   - List workspace members
 *   - Change member roles
 *   - Remove members
 *
 * Protection rules enforced here:
 *   - OWNER cannot be demoted or removed
 *   - Cannot invite as OWNER (only 1 per workspace)
 *   - Cannot invite someone who is already a member
 */

import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { logActivity } from "../../shared/utils/activity.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import type { Prisma, WorkspaceRole } from "../../app/generated/prisma/client.js";
import type { ListWorkspaceMembersQuery } from "./workspace.schemas.js";
import { syncPaidSeatQuantityBestEffort } from "../billing/billing.service.js";

/**
 * Invite a user to a workspace by email.
 * The user must already exist in our DB (signed up via Clerk).
 * Creates a WorkspaceMembership with the specified role.
 */
export async function inviteMember(
  workspaceId: string,
  email: string,
  role: Exclude<WorkspaceRole, "OWNER">,
  designation?: string,
) {
  // Find the user by email
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (!user) {
    throw new AppError(404, ERROR_CODES.MEMBER_NOT_FOUND, "No user found with this email");
  }

  // Check if already a member
  const existingMembership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId: user.id, workspaceId } },
    select: { id: true },
  });

  if (existingMembership) {
    throw new AppError(409, ERROR_CODES.MEMBER_ALREADY_EXISTS, "User is already a member of this workspace");
  }

  // Create membership
  const membership = await prisma.workspaceMembership.create({
    data: {
      userId: user.id,
      workspaceId,
      role,
      designation: designation?.trim() || null,
    },
    include: {
      user: {
        select: { id: true, email: true, name: true, avatar: true },
      },
    },
  });

  await logActivity({
    workspaceId,
    actorId: user.id,
    type: "WORKSPACE_MEMBER_JOINED",
    targetType: "MEMBER",
    targetId: user.id,
    message: `${membership.user.name} joined workspace`,
    metadata: { member: { id: membership.user.id, name: membership.user.name, email: membership.user.email }, roleAfter: membership.role },
  });

  return {
    ...membership.user,
    role: membership.role,
    designation: membership.designation,
    joinedAt: membership.joinedAt,
  };
}

/**
 * List all members of a workspace.
 * Returns user profile, role, joined date, and workspace-scoped team/department
 * memberships for the members page table and filters.
 */
function getWorkspaceMemberOrderBy(
  sort: ListWorkspaceMembersQuery["sort"],
): Prisma.WorkspaceMembershipOrderByWithRelationInput[] {
  switch (sort) {
    case "name:desc":
      return [{ user: { name: "desc" } }, { userId: "desc" }];
    case "joinedAt:asc":
      return [{ joinedAt: "asc" }, { userId: "asc" }];
    case "joinedAt:desc":
      return [{ joinedAt: "desc" }, { userId: "desc" }];
    case "name:asc":
    default:
      return [{ user: { name: "asc" } }, { userId: "asc" }];
  }
}

export async function listMembers(workspaceId: string, query: ListWorkspaceMembersQuery) {
  const limit = clampListLimit(query.limit);
  const where: Prisma.WorkspaceMembershipWhereInput = {
    workspaceId,
    ...(query.role ? { role: query.role } : {}),
    ...(query.q
      ? {
          user: {
            OR: [
              { name: { contains: query.q, mode: "insensitive" } },
              { email: { contains: query.q, mode: "insensitive" } },
            ],
          },
        }
      : {}),
  };
  const orderBy = getWorkspaceMemberOrderBy(query.sort);

  const [total, memberships] = await Promise.all([
    prisma.workspaceMembership.count({ where }),
    prisma.workspaceMembership.findMany({
      where,
      orderBy,
      ...(query.cursor
        ? {
            cursor: {
              userId_workspaceId: {
                userId: query.cursor,
                workspaceId,
              },
            },
            skip: 1,
          }
        : {}),
      take: limit + 1,
      select: {
        userId: true,
        role: true,
        designation: true,
        invitedById: true,
        joinedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            avatar: true,
            teamMemberships: {
              where: {
                team: { workspaceId },
              },
              select: {
                joinedAt: true,
                team: {
                  select: {
                    id: true,
                    name: true,
                    leadId: true,
                    departmentId: true,
                    department: {
                      select: {
                        id: true,
                        name: true,
                        color: true,
                        icon: true,
                      },
                    },
                  },
                },
              },
              orderBy: { joinedAt: "asc" },
            },
            departmentMemberships: {
              where: {
                department: { workspaceId },
              },
              select: {
                joinedAt: true,
                department: {
                  select: {
                    id: true,
                    name: true,
                    color: true,
                    icon: true,
                  },
                },
              },
              orderBy: { joinedAt: "asc" },
            },
          },
        },
      },
    }),
  ]);

  const page = slicePage(memberships, limit);

  const items = query.view === "compact"
    ? page.items.map((membership) => ({
        id: membership.user.id,
        name: membership.user.name,
        email: membership.user.email,
        role: membership.role,
        designation: membership.designation,
      }))
    : page.items.map((membership) => {
        const teams = membership.user.teamMemberships.map((teamMembership) => ({
          ...teamMembership.team,
          joinedAt: teamMembership.joinedAt,
        }));
        const departments = membership.user.departmentMemberships.map((departmentMembership) => ({
          ...departmentMembership.department,
          joinedAt: departmentMembership.joinedAt,
        }));

        return {
          id: membership.user.id,
          email: membership.user.email,
          name: membership.user.name,
          avatar: membership.user.avatar,
          role: membership.role,
          designation: membership.designation,
          invitedById: membership.invitedById,
          joinedAt: membership.joinedAt,
          team: teams[0] ?? null,
          teams,
          department: departments[0] ?? teams[0]?.department ?? null,
          departments,
        };
      });

  return {
    items,
    meta: {
      total,
      cursor: page.hasMore ? page.items[page.items.length - 1]?.userId ?? null : null,
      hasMore: page.hasMore,
    },
  };
}

/**
 * Change a member's role.
 * OWNER cannot be demoted — this is enforced here, not in middleware.
 */
export async function changeMemberRole(
  workspaceId: string,
  targetUserId: string,
  newRole: Exclude<WorkspaceRole, "OWNER">,
) {
  // Runtime backstop — the `Exclude<WorkspaceRole, "OWNER">` param type is compile-time only,
  // and this service has no way to know every caller (route, AI tool, future consumer) actually
  // validated the value first. Reject OWNER explicitly rather than trusting the type system.
  if ((newRole as WorkspaceRole) === "OWNER") {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, "Cannot assign the OWNER role — workspaces have exactly one owner");
  }

  // Find the membership
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId: targetUserId, workspaceId } },
    select: { id: true, role: true },
  });

  if (!membership) {
    throw new AppError(404, ERROR_CODES.MEMBER_NOT_FOUND, "Member not found in this workspace");
  }

  // OWNER cannot be demoted
  if (membership.role === "OWNER") {
    throw new AppError(403, ERROR_CODES.CANNOT_DEMOTE_OWNER, "Workspace owner cannot be demoted");
  }

  // Update the role
  const updated = await prisma.workspaceMembership.update({
    where: { userId_workspaceId: { userId: targetUserId, workspaceId } },
    data: { role: newRole },
    include: {
      user: {
        select: { id: true, email: true, name: true, avatar: true },
      },
    },
  });

  return {
    ...updated.user,
    role: updated.role,
    designation: updated.designation,
    joinedAt: updated.joinedAt,
  };
}

/**
 * Remove a member from a workspace.
 * OWNER cannot be removed — they must delete the workspace instead.
 */
export async function removeMember(workspaceId: string, targetUserId: string) {
  const removedUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, name: true, email: true },
  });
  await prisma.$transaction(async (tx) => {
    const membership = await tx.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: targetUserId, workspaceId } },
      select: { id: true, role: true },
    });

    if (!membership) {
      throw new AppError(404, ERROR_CODES.MEMBER_NOT_FOUND, "Member not found in this workspace");
    }

    if (membership.role === "OWNER") {
      throw new AppError(403, ERROR_CODES.CANNOT_REMOVE_OWNER, "Workspace owner cannot be removed");
    }

    const ledTeam = await tx.team.findFirst({
      where: { workspaceId, leadId: targetUserId },
      select: { id: true },
    });

    if (ledTeam) {
      throw new AppError(
        409,
        ERROR_CODES.FORBIDDEN,
        "Reassign this member from their team lead role before removing them from the workspace",
      );
    }

    await tx.department.updateMany({
      where: { workspaceId, headId: targetUserId },
      data: { headId: null },
    });

    await tx.project.updateMany({
      where: { workspaceId, leadId: targetUserId },
      data: { leadId: null },
    });

    await tx.teamMembership.deleteMany({
      where: {
        userId: targetUserId,
        team: { workspaceId },
      },
    });

    await tx.departmentMembership.deleteMany({
      where: {
        userId: targetUserId,
        department: { workspaceId },
      },
    });

    // Delete API keys created by this member (prevents orphaned key access)
    await tx.apiKey.deleteMany({
      where: { workspaceId, createdById: targetUserId },
    });

    await tx.workspaceMembership.delete({
      where: { userId_workspaceId: { userId: targetUserId, workspaceId } },
    });
  });

  await syncPaidSeatQuantityBestEffort(workspaceId);

  await logActivity({
    workspaceId,
    actorId: targetUserId,
    type: "WORKSPACE_MEMBER_REMOVED",
    targetType: "MEMBER",
    targetId: targetUserId,
    message: "Workspace member removed",
    metadata: { member: removedUser ?? { id: targetUserId } },
  });
}
