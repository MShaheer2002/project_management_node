import type { WorkspaceRole } from "../../app/generated/prisma/client.js";

import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { logActivity } from "../../shared/utils/activity.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import type {
  AddProjectMembersInput,
  ListProjectMembersQuery,
} from "./project.schemas.js";

function getMemberOrderBy(
  sort: ListProjectMembersQuery["sort"],
) {
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

async function assertProjectMemberVisibility(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  userId: string,
  projectId: string,
) {
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      workspaceId,
      ...(workspaceRole === "OWNER" || workspaceRole === "ADMIN"
        ? {}
        : {
            OR: [
              { visibility: "PUBLIC" },
              { leadId: userId },
              { memberships: { some: { userId } } },
            ],
          }),
    },
    select: {
      id: true,
      name: true,
      team: { select: { id: true, name: true } },
      department: { select: { id: true, name: true } },
    },
  });

  if (project) {
    return project;
  }

  const existing = await prisma.project.findFirst({
    where: { id: projectId, workspaceId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
  }

  throw new AppError(404, ERROR_CODES.PRIVATE_PROJECT_FORBIDDEN, "Project is not visible");
}

function buildProjectMemberWhere(
  workspaceId: string,
  projectId: string,
  query: ListProjectMembersQuery,
): any {
  const userFilter: any = {
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
    projectId,
    ...(Object.keys(userFilter).length > 0 ? { user: userFilter } : {}),
  };
}

export async function listProjectMembers(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  userId: string,
  projectId: string,
  query: ListProjectMembersQuery,
) {
  const project = await assertProjectMemberVisibility(workspaceId, workspaceRole, userId, projectId);
  const limit = clampListLimit(query.limit);
  const where = buildProjectMemberWhere(workspaceId, projectId, query);
  const orderBy = getMemberOrderBy(query.sort);
  const projectMembership = (prisma as any).projectMembership;

  const [total, membershipsRaw] = await Promise.all([
    projectMembership.count({ where }),
    projectMembership.findMany({
      where,
      orderBy,
      ...(query.cursor
        ? {
            cursor: {
              projectId_userId: {
                projectId,
                userId: query.cursor,
              },
            },
            skip: 1,
          }
        : {}),
      take: limit + 1,
      select: {
        userId: true,
        membershipRole: true,
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

  const memberships = membershipsRaw as any[];
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
        membershipRole: membership.membershipRole,
        department: project.department,
        team: project.team,
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

export async function addProjectMembers(
  workspaceId: string,
  projectId: string,
  input: AddProjectMembersInput,
) {
  const userIds = [...new Set(input.userIds)];

  const added = await prisma.$transaction(async (tx) => {
    const project = await tx.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { id: true },
    });

    if (!project) {
      throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
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

    const existing = await (tx as any).projectMembership.findMany({
      where: {
        projectId,
        userId: { in: userIds },
      },
      select: { userId: true },
    });

    if (existing.length > 0) {
      throw new AppError(
        409,
        ERROR_CODES.MEMBER_ALREADY_IN_PROJECT,
        "One or more users are already in this project",
      );
    }

    await (tx as any).projectMembership.createMany({
      data: userIds.map((id) => ({
        projectId,
        userId: id,
        membershipRole: "MEMBER",
      })),
    });

    return { userIds, projectId };
  });

  await Promise.all(added.userIds.map((memberId) => logActivity({
    workspaceId,
    actorId: memberId,
    type: "PROJECT_MEMBER_ADDED",
    targetType: "PROJECT",
    targetId: added.projectId,
    message: "Project member added",
    metadata: { projectId: added.projectId, memberId },
  })));

  return { added: added.userIds };
}

export async function removeProjectMember(workspaceId: string, projectId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    const project = await tx.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { id: true, leadId: true },
    });

    if (!project) {
      throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
    }

    if (project.leadId === userId) {
      throw new AppError(409, ERROR_CODES.FORBIDDEN, "Reassign project lead before removing this member");
    }

    const membership = await (tx as any).projectMembership.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
      select: { userId: true },
    });

    if (!membership) {
      throw new AppError(404, ERROR_CODES.MEMBER_NOT_IN_PROJECT, "Member is not in this project");
    }

    await (tx as any).projectMembership.delete({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
    });
  });

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "PROJECT_MEMBER_REMOVED",
    targetType: "PROJECT",
    targetId: projectId,
    message: "Project member removed",
    metadata: { projectId, memberId: userId },
  });
}
