import type {
  Prisma,
  WorkspaceRole,
} from "../../app/generated/prisma/client.js";

import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import type {
  AddDepartmentMembersInput,
  ListDepartmentMembersQuery,
} from "./department.schemas.js";

function getMemberOrderBy(
  sort: ListDepartmentMembersQuery["sort"],
): Prisma.DepartmentMembershipOrderByWithRelationInput[] {
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

async function assertDepartmentAccess(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  departmentId: string,
) {
  const department = await prisma.department.findFirst({
    where: {
      id: departmentId,
      workspaceId,
      ...(workspaceRole === "GUEST" ? { visibility: "PUBLIC" } : {}),
    },
    select: { id: true, name: true },
  });

  if (department) {
    return department;
  }

  const existing = await prisma.department.findFirst({
    where: { id: departmentId, workspaceId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError(404, ERROR_CODES.DEPARTMENT_NOT_FOUND, "Department not found");
  }

  throw new AppError(404, ERROR_CODES.PRIVATE_DEPARTMENT_FORBIDDEN, "Department is not visible");
}

function buildDepartmentMemberWhere(
  workspaceId: string,
  departmentId: string,
  query: ListDepartmentMembersQuery,
): Prisma.DepartmentMembershipWhereInput {
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
    departmentId,
    ...(Object.keys(userFilter).length > 0 ? { user: userFilter } : {}),
  };
}

export async function listDepartmentMembers(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  departmentId: string,
  query: ListDepartmentMembersQuery,
) {
  const department = await assertDepartmentAccess(workspaceId, workspaceRole, departmentId);

  const limit = clampListLimit(query.limit);
  const where = buildDepartmentMemberWhere(workspaceId, departmentId, query);
  const orderBy = getMemberOrderBy(query.sort);

  const [total, memberships] = await Promise.all([
    prisma.departmentMembership.count({ where }),
    prisma.departmentMembership.findMany({
      where,
      orderBy,
      ...(query.cursor
        ? {
            cursor: {
              userId_departmentId: {
                userId: query.cursor,
                departmentId,
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
            teamMemberships: {
              where: {
                team: {
                  workspaceId,
                  departmentId,
                },
              },
              orderBy: { joinedAt: "asc" },
              take: 1,
              select: {
                team: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
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
        department: {
          id: department.id,
          name: department.name,
        },
        team: membership.user.teamMemberships[0]?.team ?? null,
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

export async function addDepartmentMembers(
  workspaceId: string,
  departmentId: string,
  input: AddDepartmentMembersInput,
) {
  const userIds = [...new Set(input.userIds)];

  const added = await prisma.$transaction(async (tx) => {
    const department = await tx.department.findFirst({
      where: { id: departmentId, workspaceId },
      select: { id: true },
    });

    if (!department) {
      throw new AppError(404, ERROR_CODES.DEPARTMENT_NOT_FOUND, "Department not found");
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

    const existingMemberships = await tx.departmentMembership.findMany({
      where: {
        departmentId,
        userId: { in: userIds },
      },
      select: { userId: true },
    });

    if (existingMemberships.length > 0) {
      throw new AppError(
        409,
        ERROR_CODES.MEMBER_ALREADY_IN_DEPARTMENT,
        "One or more users are already in this department",
      );
    }

    await tx.departmentMembership.createMany({
      data: userIds.map((userId) => ({
        userId,
        departmentId,
      })),
    });

    return userIds;
  });

  return { added };
}

export async function removeDepartmentMember(workspaceId: string, departmentId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    const department = await tx.department.findFirst({
      where: { id: departmentId, workspaceId },
      select: { headId: true },
    });

    if (!department) {
      throw new AppError(404, ERROR_CODES.DEPARTMENT_NOT_FOUND, "Department not found");
    }

    const membership = await tx.departmentMembership.findUnique({
      where: {
        userId_departmentId: {
          userId,
          departmentId,
        },
      },
      select: { userId: true },
    });

    if (!membership) {
      throw new AppError(404, ERROR_CODES.MEMBER_NOT_IN_DEPARTMENT, "Member is not in this department");
    }

    if (department.headId === userId) {
      await tx.department.update({
        where: { id: departmentId },
        data: { headId: null },
      });
    }

    await tx.departmentMembership.delete({
      where: {
        userId_departmentId: {
          userId,
          departmentId,
        },
      },
    });
  });
}
