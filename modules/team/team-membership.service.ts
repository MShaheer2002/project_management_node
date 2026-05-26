import type {
  Prisma,
  WorkspaceRole,
} from "../../app/generated/prisma/client.js";

import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { logActivity } from "../../shared/utils/activity.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import { createNotification } from "../notification/notification.service.js";
import type {
  AddTeamMembersInput,
  ListTeamMembersQuery,
} from "./team.schemas.js";

function getMemberOrderBy(
  sort: ListTeamMembersQuery["sort"],
): Prisma.TeamMembershipOrderByWithRelationInput[] {
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

async function assertTeamAccess(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  teamId: string,
) {
  const team = await prisma.team.findFirst({
    where: {
      id: teamId,
      workspaceId,
      ...(workspaceRole === "GUEST" ? { visibility: "PUBLIC" } : {}),
    },
    select: {
      id: true,
      name: true,
      department: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (team) {
    return team;
  }

  const existing = await prisma.team.findFirst({
    where: { id: teamId, workspaceId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError(404, ERROR_CODES.TEAM_NOT_FOUND, "Team not found");
  }

  throw new AppError(404, ERROR_CODES.PRIVATE_TEAM_FORBIDDEN, "Team is not visible");
}

function buildTeamMemberWhere(
  workspaceId: string,
  teamId: string,
  query: ListTeamMembersQuery,
): Prisma.TeamMembershipWhereInput {
  const userFilter: Prisma.UserWhereInput = {
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: "insensitive" } },
            { email: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(query.role
      ? {
          workspaceMemberships: {
            some: {
              workspaceId,
              role: query.role,
            },
          },
        }
      : {}),
  };

  return {
    teamId,
    ...(Object.keys(userFilter).length > 0 ? { user: userFilter } : {}),
  };
}

export async function listTeamMembers(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  teamId: string,
  query: ListTeamMembersQuery,
) {
  const team = await assertTeamAccess(workspaceId, workspaceRole, teamId);

  const limit = clampListLimit(query.limit);
  const where = buildTeamMemberWhere(workspaceId, teamId, query);
  const orderBy = getMemberOrderBy(query.sort);

  const [total, memberships] = await Promise.all([
    prisma.teamMembership.count({ where }),
    prisma.teamMembership.findMany({
      where,
      orderBy,
      ...(query.cursor
        ? {
            cursor: {
              userId_teamId: {
                userId: query.cursor,
                teamId,
              },
            },
            skip: 1,
          }
        : {}),
      take: limit + 1,
      select: {
        userId: true,
        joinedAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
            workspaceMemberships: {
              where: { workspaceId },
              select: { role: true },
              take: 1,
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
        role: membership.user.workspaceMemberships[0]?.role ?? "MEMBER",
      }))
    : page.items.map((membership) => ({
        id: membership.user.id,
        name: membership.user.name,
        email: membership.user.email,
        avatar: membership.user.avatar,
        role: membership.user.workspaceMemberships[0]?.role ?? "MEMBER",
        joinedAt: membership.joinedAt,
        department: team.department,
        team: {
          id: team.id,
          name: team.name,
        },
      }));

  return {
    items,
    meta: {
      total,
      cursor: page.hasMore ? page.items[page.items.length - 1]?.userId ?? null : null,
      hasMore: page.hasMore,
    },
  };
}

export async function addTeamMembers(workspaceId: string, teamId: string, actorUserId: string, input: AddTeamMembersInput) {
  const userIds = [...new Set(input.userIds)];

  const added = await prisma.$transaction(async (tx) => {
    const team = await tx.team.findFirst({
      where: { id: teamId, workspaceId },
      select: { id: true, name: true },
    });

    if (!team) {
      throw new AppError(404, ERROR_CODES.TEAM_NOT_FOUND, "Team not found");
    }

    const workspaceMembers = await tx.workspaceMembership.findMany({
      where: {
        workspaceId,
        userId: { in: userIds },
      },
      select: { userId: true },
    });

    if (workspaceMembers.length !== userIds.length) {
      throw new AppError(
        404,
        ERROR_CODES.MEMBER_NOT_WORKSPACE_MEMBER,
        "One or more users are not members of this workspace",
      );
    }

    const existingMemberships = await tx.teamMembership.findMany({
      where: {
        teamId,
        userId: { in: userIds },
      },
      select: { userId: true },
    });

    if (existingMemberships.length > 0) {
      throw new AppError(
        409,
        ERROR_CODES.MEMBER_ALREADY_IN_TEAM,
        "One or more users are already in this team",
      );
    }

    await tx.teamMembership.createMany({
      data: userIds.map((userId) => ({
        userId,
        teamId,
      })),
    });

    return { userIds, teamId, teamName: team.name };
  });

  await Promise.all(added.userIds.map((memberId) => logActivity({
    workspaceId,
    actorId: memberId,
    type: "TEAM_MEMBER_JOINED",
    targetType: "TEAM",
    targetId: added.teamId,
    message: "Team member joined",
    metadata: { teamId: added.teamId, memberId },
  })));
  await Promise.all(added.userIds.map((memberId) => createNotification({
    workspaceId,
    recipientUserId: memberId,
    actorUserId,
    type: "TEAM_MEMBER",
    category: "membership",
    title: "Added to team",
    message: `You were added to team ${added.teamName}`,
    target: { type: "team", id: added.teamId, url: `/teams/${added.teamId}` },
    metadata: {
      teamId: added.teamId,
      memberId,
      action: "added",
      workspaceId,
      entityId: added.teamId,
      entityTitle: added.teamName,
      url: `/teams/${added.teamId}`,
    },
    eventId: `team-member:${added.teamId}:added:${memberId}`,
  })));

  return { added: added.userIds };
}

export async function removeTeamMember(workspaceId: string, teamId: string, actorUserId: string, userId: string) {
  const removed = await prisma.$transaction(async (tx) => {
    const team = await tx.team.findFirst({
      where: { id: teamId, workspaceId },
      select: { leadId: true, name: true },
    });

    if (!team) {
      throw new AppError(404, ERROR_CODES.TEAM_NOT_FOUND, "Team not found");
    }

    if (team.leadId === userId) {
      throw new AppError(409, ERROR_CODES.FORBIDDEN, "Reassign the team lead before removing them from the team");
    }

    const membership = await tx.teamMembership.findUnique({
      where: {
        userId_teamId: {
          userId,
          teamId,
        },
      },
      select: { userId: true },
    });

    if (!membership) {
      throw new AppError(404, ERROR_CODES.MEMBER_NOT_IN_TEAM, "Member is not in this team");
    }

    await tx.teamMembership.delete({
      where: {
        userId_teamId: {
          userId,
          teamId,
        },
      },
    });
    return { teamName: team.name };
  });

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "TEAM_MEMBER_REMOVED",
    targetType: "TEAM",
    targetId: teamId,
    message: "Team member removed",
    metadata: { teamId, memberId: userId },
  });
  await createNotification({
    workspaceId,
    recipientUserId: userId,
    actorUserId,
    type: "TEAM_MEMBER",
    category: "membership",
    title: "Removed from team",
    message: `You were removed from team ${removed.teamName}`,
    target: { type: "team", id: teamId, url: `/teams/${teamId}` },
    metadata: {
      teamId,
      memberId: userId,
      action: "removed",
      workspaceId,
      entityId: teamId,
      entityTitle: removed.teamName,
      url: `/teams/${teamId}`,
    },
    eventId: `team-member:${teamId}:removed:${userId}`,
  });
}
