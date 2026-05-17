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
import type { WorkspaceRole } from "../../app/generated/prisma/client.js";

/**
 * Invite a user to a workspace by email.
 * The user must already exist in our DB (signed up via Clerk).
 * Creates a WorkspaceMembership with the specified role.
 */
export async function inviteMember(
  workspaceId: string,
  email: string,
  role: Exclude<WorkspaceRole, "OWNER">,
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
    },
    include: {
      user: {
        select: { id: true, email: true, name: true, avatar: true },
      },
    },
  });

  return {
    ...membership.user,
    role: membership.role,
    joinedAt: membership.joinedAt,
  };
}

/**
 * List all members of a workspace.
 * Returns user profile + their role in this workspace.
 */
export async function listMembers(workspaceId: string) {
  const memberships = await prisma.workspaceMembership.findMany({
    where: { workspaceId },
    include: {
      user: {
        select: { id: true, email: true, name: true, avatar: true },
      },
    },
    orderBy: [
      // OWNER first, then ADMIN, then MEMBER, then GUEST
      { role: "asc" },
      { joinedAt: "asc" },
    ],
  });

  return memberships.map((m) => ({
    ...m.user,
    role: m.role,
    joinedAt: m.joinedAt,
  }));
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
    joinedAt: updated.joinedAt,
  };
}

/**
 * Remove a member from a workspace.
 * OWNER cannot be removed — they must delete the workspace instead.
 */
export async function removeMember(workspaceId: string, targetUserId: string) {
  // Find the membership
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId: targetUserId, workspaceId } },
    select: { id: true, role: true },
  });

  if (!membership) {
    throw new AppError(404, ERROR_CODES.MEMBER_NOT_FOUND, "Member not found in this workspace");
  }

  // OWNER cannot be removed
  if (membership.role === "OWNER") {
    throw new AppError(403, ERROR_CODES.CANNOT_REMOVE_OWNER, "Workspace owner cannot be removed");
  }

  await prisma.workspaceMembership.delete({
    where: { userId_workspaceId: { userId: targetUserId, workspaceId } },
  });
}
