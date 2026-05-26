/**
 * Sidebar Module — Service Layer
 *
 * Aggregates data needed by the authenticated app shell/sidebar.
 * Queries that touch tenant data are scoped to the active workspaceId.
 */

import type { WorkspaceRole } from "../../app/generated/prisma/client.js";
import { prisma } from "../../shared/utils/prisma.js";

function canAccessAdminArea(role: WorkspaceRole) {
  return role === "OWNER" || role === "ADMIN";
}

/**
 * GET /sidebar
 *
 * Returns workspace switcher data, active workspace details, teams,
 * sidebar badges, and permission flags for the current user.
 */
export async function getSidebarData(workspaceId: string, userId: string, role: WorkspaceRole) {
  const [
    user,
    workspaces,
    activeWorkspace,
    teams,
    unreadInboxCount,
    myIssuesCount,
    pendingInvitationsCount,
  ] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
      },
    }),
    prisma.workspaceMembership.findMany({
      where: { userId },
      orderBy: { joinedAt: "desc" },
      select: {
        role: true,
        joinedAt: true,
        workspace: {
          select: {
            id: true,
            name: true,
            slug: true,
            logo: true,
            teamSize: true,
          },
        },
      },
    }),
    prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: {
        id: true,
        name: true,
        slug: true,
        logo: true,
        teamSize: true,
      },
    }),
    prisma.team.findMany({
      where: {
        workspaceId,
        memberships: {
          some: { userId },
        },
      },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        departmentId: true,
        leadId: true,
        department: {
          select: {
            id: true,
            name: true,
            color: true,
            icon: true,
          },
        },
        _count: {
          select: {
            projects: true,
            issues: true,
            memberships: true,
          },
        },
      },
    }),
    prisma.notification.count({
      where: { workspaceId, recipientUserId: userId, readAt: null },
    }),
    prisma.issue.count({
      where: { workspaceId, assigneeId: userId, status: { not: "DONE" } },
    }),
    prisma.workspaceInvitation.count({
      where: { workspaceId, status: "PENDING" },
    }),
  ]);

  return {
    user: {
      ...user,
      role,
    },
    workspaces: workspaces.map((membership) => ({
      ...membership.workspace,
      role: membership.role,
      joinedAt: membership.joinedAt,
      active: membership.workspace.id === workspaceId,
    })),
    activeWorkspace: {
      ...activeWorkspace,
      role,
    },
    badges: {
      inbox: unreadInboxCount,
      myIssues: myIssuesCount,
      pendingInvitations: canAccessAdminArea(role) ? pendingInvitationsCount : 0,
    },
    teams: teams.map((team) => ({
      id: team.id,
      name: team.name,
      departmentId: team.departmentId,
      leadId: team.leadId,
      department: team.department,
      counts: {
        projects: team._count.projects,
        issues: team._count.issues,
        members: team._count.memberships,
      },
    })),
    permissions: {
      canCreateIssue: role !== "GUEST",
      canCreateProject: role !== "GUEST",
      canCreateTeam: role !== "GUEST",
      canInviteMembers: canAccessAdminArea(role),
      canManageSettings: canAccessAdminArea(role),
      canManageBilling: canAccessAdminArea(role),
      canManageApiKeys: canAccessAdminArea(role),
      canManageTemplates: canAccessAdminArea(role),
      canDeleteWorkspace: role === "OWNER",
    },
  };
}
