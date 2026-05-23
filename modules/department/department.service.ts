import type {
  Prisma,
  WorkspaceRole,
} from "../../app/generated/prisma/client.js";

import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import type {
  CreateDepartmentInput,
  ListDepartmentsQuery,
  UpdateDepartmentInput,
} from "./department.schemas.js";

const departmentSummarySelect = {
  id: true,
  name: true,
  description: true,
  color: true,
  visibility: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
  head: {
    select: {
      id: true,
      name: true,
      email: true,
      avatar: true,
    },
  },
  _count: {
    select: {
      memberships: true,
      teams: true,
      projects: true,
      issues: true,
    },
  },
} satisfies Prisma.DepartmentSelect;

type DepartmentSummaryRecord = Prisma.DepartmentGetPayload<{
  select: typeof departmentSummarySelect;
}>;

const departmentCompactSelect = {
  id: true,
  name: true,
} satisfies Prisma.DepartmentSelect;

function normalizeText(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  return normalizeNullableText(value);
}

function normalizeNullableText(value: string | null) {
  if (value === null || value.length === 0) {
    return null;
  }

  return value;
}

function mapDepartment(record: DepartmentSummaryRecord, includeIssueCount: boolean) {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    color: record.color,
    visibility: record.visibility,
    isDefault: record.isDefault,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    head: record.head,
    stats: {
      memberCount: record._count.memberships,
      teamCount: record._count.teams,
      projectCount: record._count.projects,
      ...(includeIssueCount ? { issueCount: record._count.issues } : {}),
    },
  };
}

function buildDepartmentWhere(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  query: ListDepartmentsQuery,
): Prisma.DepartmentWhereInput {
  return {
    workspaceId,
    ...(workspaceRole === "GUEST" ? { visibility: "PUBLIC" } : {}),
    ...(query.visibility ? { visibility: query.visibility } : {}),
    ...(query.headId ? { headId: query.headId } : {}),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: "insensitive" } },
            { description: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
}

function getDepartmentOrderBy(sort: ListDepartmentsQuery["sort"]): Prisma.DepartmentOrderByWithRelationInput[] {
  switch (sort) {
    case "name:desc":
      return [{ name: "desc" }, { id: "desc" }];
    case "createdAt:asc":
      return [{ createdAt: "asc" }, { id: "asc" }];
    case "createdAt:desc":
      return [{ createdAt: "desc" }, { id: "desc" }];
    case "name:asc":
    default:
      return [{ name: "asc" }, { id: "asc" }];
  }
}

async function assertDepartmentAccessible(
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
    select: departmentSummarySelect,
  });

  if (department) {
    return department;
  }

  const existing = await prisma.department.findFirst({
    where: { id: departmentId, workspaceId },
    select: { id: true, visibility: true },
  });

  if (!existing) {
    throw new AppError(404, ERROR_CODES.DEPARTMENT_NOT_FOUND, "Department not found");
  }

  throw new AppError(404, ERROR_CODES.PRIVATE_DEPARTMENT_FORBIDDEN, "Department is not visible");
}

async function assertWorkspaceMember(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
  code: string,
  message: string,
) {
  const membership = await tx.workspaceMembership.findUnique({
    where: {
      userId_workspaceId: {
        userId,
        workspaceId,
      },
    },
    select: { userId: true },
  });

  if (!membership) {
    throw new AppError(404, code, message);
  }
}

async function assertWorkspaceMembers(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userIds: string[],
) {
  if (userIds.length === 0) {
    return;
  }

  const memberships = await tx.workspaceMembership.findMany({
    where: {
      workspaceId,
      userId: { in: userIds },
    },
    select: { userId: true },
  });

  if (memberships.length !== userIds.length) {
    throw new AppError(
      404,
      ERROR_CODES.MEMBER_NOT_WORKSPACE_MEMBER,
      "One or more users are not members of this workspace",
    );
  }
}

export async function createDepartment(workspaceId: string, input: CreateDepartmentInput) {
  const existing = await prisma.department.findFirst({
    where: {
      workspaceId,
      name: { equals: input.name, mode: "insensitive" },
    },
    select: { id: true },
  });

  if (existing) {
    throw new AppError(409, ERROR_CODES.DEPARTMENT_NAME_TAKEN, "A department with this name already exists");
  }

  const memberIds = [...new Set([...(input.memberIds ?? []), ...(input.headId ? [input.headId] : [])])];

  const department = await prisma.$transaction(async (tx) => {
    if (input.headId) {
      await assertWorkspaceMember(
        tx,
        workspaceId,
        input.headId,
        ERROR_CODES.HEAD_NOT_WORKSPACE_MEMBER,
        "Department head must be a workspace member",
      );
    }

    await assertWorkspaceMembers(tx, workspaceId, memberIds);

    if (input.isDefault) {
      await tx.department.updateMany({
        where: { workspaceId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const description = input.description === undefined
      ? undefined
      : normalizeNullableText(input.description);
    const createData: Prisma.DepartmentUncheckedCreateInput = {
      workspaceId,
      name: input.name,
      headId: input.headId ?? null,
      color: input.color ?? null,
      visibility: input.visibility ?? "PUBLIC",
      isDefault: input.isDefault ?? false,
      ...(description !== undefined ? { description } : {}),
    };

    const created = await tx.department.create({
      data: createData,
      select: { id: true },
    });

    if (memberIds.length > 0) {
      await tx.departmentMembership.createMany({
        data: memberIds.map((userId) => ({
          userId,
          departmentId: created.id,
        })),
        skipDuplicates: true,
      });
    }

    return created;
  });

  return getDepartmentById(workspaceId, "MEMBER", department.id);
}

export async function listDepartments(workspaceId: string, workspaceRole: WorkspaceRole, query: ListDepartmentsQuery) {
  const limit = clampListLimit(query.limit);
  const where = buildDepartmentWhere(workspaceId, workspaceRole, query);
  const orderBy = getDepartmentOrderBy(query.sort);

  const [total, records] = await Promise.all([
    prisma.department.count({ where }),
    prisma.department.findMany({
      where,
      orderBy,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: limit + 1,
      select: query.view === "compact" ? departmentCompactSelect : departmentSummarySelect,
    }),
  ]);

  const page = slicePage(records, limit);

  return {
    items: query.view === "compact"
      ? page.items
      : page.items.map((record) => mapDepartment(record as DepartmentSummaryRecord, false)),
    meta: {
      total,
      cursor: page.hasMore ? page.items[page.items.length - 1]?.id ?? null : null,
      hasMore: page.hasMore,
    },
  };
}

export async function getDepartmentById(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  departmentId: string,
) {
  const department = await assertDepartmentAccessible(workspaceId, workspaceRole, departmentId);
  return mapDepartment(department, true);
}

export async function updateDepartment(
  workspaceId: string,
  departmentId: string,
  input: UpdateDepartmentInput,
) {
  const current = await prisma.department.findFirst({
    where: { id: departmentId, workspaceId },
    select: { id: true },
  });

  if (!current) {
    throw new AppError(404, ERROR_CODES.DEPARTMENT_NOT_FOUND, "Department not found");
  }

  if (input.name) {
    const nameConflict = await prisma.department.findFirst({
      where: {
        workspaceId,
        id: { not: departmentId },
        name: { equals: input.name, mode: "insensitive" },
      },
      select: { id: true },
    });

    if (nameConflict) {
      throw new AppError(409, ERROR_CODES.DEPARTMENT_NAME_TAKEN, "A department with this name already exists");
    }
  }

  await prisma.$transaction(async (tx) => {
    if (input.headId) {
      await assertWorkspaceMember(
        tx,
        workspaceId,
        input.headId,
        ERROR_CODES.HEAD_NOT_WORKSPACE_MEMBER,
        "Department head must be a workspace member",
      );
    }

    if (input.isDefault === true) {
      await tx.department.updateMany({
        where: { workspaceId, id: { not: departmentId }, isDefault: true },
        data: { isDefault: false },
      });
    }

    const updateData: Prisma.DepartmentUncheckedUpdateInput = {};

    if (input.name !== undefined) {
      updateData.name = input.name;
    }

    if (input.description !== undefined) {
      updateData.description = normalizeNullableText(input.description);
    }

    if (input.headId !== undefined) {
      updateData.headId = input.headId;
    }

    if (input.color !== undefined) {
      updateData.color = input.color;
    }

    if (input.visibility !== undefined) {
      updateData.visibility = input.visibility;
    }

    if (input.isDefault !== undefined) {
      updateData.isDefault = input.isDefault;
    }

    await tx.department.update({
      where: { id: departmentId },
      data: updateData,
    });

    if (input.headId) {
      await tx.departmentMembership.createMany({
        data: [{ userId: input.headId, departmentId }],
        skipDuplicates: true,
      });
    }
  });

  return getDepartmentById(workspaceId, "MEMBER", departmentId);
}

export async function deleteDepartment(workspaceId: string, departmentId: string) {
  await prisma.$transaction(async (tx) => {
    const department = await tx.department.findFirst({
      where: { id: departmentId, workspaceId },
      select: { id: true },
    });

    if (!department) {
      throw new AppError(404, ERROR_CODES.DEPARTMENT_NOT_FOUND, "Department not found");
    }

    const affectedTeamIds = await tx.team.findMany({
      where: { workspaceId, departmentId },
      select: { id: true },
    });

    await tx.team.updateMany({
      where: { workspaceId, departmentId },
      data: { departmentId: null },
    });

    if (affectedTeamIds.length > 0) {
      const teamIds = affectedTeamIds.map((team) => team.id);

      await tx.project.updateMany({
        where: { workspaceId, teamId: { in: teamIds } },
        data: { departmentId: null },
      });

      await tx.issue.updateMany({
        where: { workspaceId, teamId: { in: teamIds } },
        data: { departmentId: null },
      });
    }

    await tx.departmentMembership.deleteMany({
      where: { departmentId },
    });

    await tx.department.delete({
      where: { id: departmentId },
    });
  });
}

export async function getDepartmentOwnership(workspaceId: string, departmentId: string) {
  const department = await prisma.department.findFirst({
    where: { id: departmentId, workspaceId },
    select: { headId: true },
  });

  return {
    exists: Boolean(department),
    ownerId: department?.headId ?? null,
  };
}
