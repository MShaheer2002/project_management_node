import type {
  Prisma,
  WorkspaceRole,
} from "../../app/generated/prisma/client.js";

import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import {
  buildDaySeries,
  calculateTrend,
  formatDayKey,
  resolveDateRange,
} from "../analytics/analytics.utils.js";
import type {
  CreateDepartmentInput,
  ListDepartmentsQuery,
  UpdateDepartmentInput,
} from "./department.schemas.js";
import { indexEntity } from "../ai/ai.indexer.js";

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

type DepartmentAnalyticsIssueRecord = {
  status: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  dueDate: Date | null;
  assigneeId: string | null;
  teamId: string;
};

type DepartmentAnalyticsTeamRecord = {
  id: string;
  name: string;
};

type WorkspaceStatusRecord = {
  key?: string;
  isFinal?: boolean;
};

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

function isFinalStatus(statuses: WorkspaceStatusRecord[], status: string) {
  const normalizedStatus = status.trim().toLowerCase();
  const matched = statuses.find((item) => String(item.key ?? "").trim().toLowerCase() === normalizedStatus);
  if (matched) {
    return matched.isFinal === true;
  }

  return normalizedStatus === "done";
}

function getPercent(numerator: number, denominator: number) {
  if (denominator <= 0) {
    return 0;
  }

  return Math.round((numerator / denominator) * 100);
}

function getOpenIssuesAtDate(
  issues: DepartmentAnalyticsIssueRecord[],
  statuses: WorkspaceStatusRecord[],
  at: Date,
) {
  return issues.filter((issue) => {
    if (issue.createdAt > at) {
      return false;
    }

    if (issue.completedAt && issue.completedAt <= at) {
      return false;
    }

    return !isFinalStatus(statuses, issue.status);
  });
}

function countCompletedInRange(issues: DepartmentAnalyticsIssueRecord[], from: Date, to: Date) {
  return issues.filter((issue) => issue.completedAt && issue.completedAt >= from && issue.completedAt <= to).length;
}

function countCreatedInRange(issues: DepartmentAnalyticsIssueRecord[], from: Date, to: Date) {
  return issues.filter((issue) => issue.createdAt >= from && issue.createdAt <= to).length;
}

function buildDepartmentAnalytics(
  department: DepartmentSummaryRecord,
  statuses: WorkspaceStatusRecord[],
  issues: DepartmentAnalyticsIssueRecord[],
  teams: DepartmentAnalyticsTeamRecord[],
) {
  const range = resolveDateRange("7d");
  const now = range.to;

  const totalIssues = issues.length;
  const totalCompleted = issues.filter((issue) => isFinalStatus(statuses, issue.status)).length;
  const currentCompleted = countCompletedInRange(issues, range.from, range.to);
  const previousCompleted = countCompletedInRange(issues, range.previousFrom, range.previousTo);
  const currentCreated = countCreatedInRange(issues, range.from, range.to);
  const previousCreated = countCreatedInRange(issues, range.previousFrom, range.previousTo);

  const currentEfficiency = currentCreated + currentCompleted > 0
    ? getPercent(currentCompleted, currentCreated + currentCompleted)
    : getPercent(totalCompleted, totalIssues);
  const previousEfficiency = previousCreated + previousCompleted > 0
    ? getPercent(previousCompleted, previousCreated + previousCompleted)
    : 0;

  const openIssuesNow = getOpenIssuesAtDate(issues, statuses, now);
  const openIssuesPrevious = getOpenIssuesAtDate(issues, statuses, range.previousTo);
  const membersWithAssignmentsNow = new Set(
    openIssuesNow.filter((issue) => issue.assigneeId).map((issue) => issue.assigneeId as string),
  ).size;
  const membersWithAssignmentsPrevious = new Set(
    openIssuesPrevious.filter((issue) => issue.assigneeId).map((issue) => issue.assigneeId as string),
  ).size;
  const memberCount = department._count.memberships;
  const resourceLoadCurrent = getPercent(membersWithAssignmentsNow, memberCount);
  const resourceLoadPrevious = getPercent(membersWithAssignmentsPrevious, memberCount);

  const overdueNow = openIssuesNow.filter((issue) => issue.dueDate && issue.dueDate < now).length;
  const overduePrevious = openIssuesPrevious.filter((issue) => issue.dueDate && issue.dueDate < range.previousTo).length;
  const stressCurrent = getPercent(overdueNow, openIssuesNow.length);
  const stressPrevious = getPercent(overduePrevious, openIssuesPrevious.length);

  const velocity = buildDaySeries(range.from, range.to).map((day) => {
    const key = formatDayKey(day);
    const completed = issues.filter((issue) => issue.completedAt && formatDayKey(issue.completedAt) === key).length;
    const created = issues.filter((issue) => formatDayKey(issue.createdAt) === key).length;

    return {
      date: key,
      label: day.toLocaleDateString("en-US", { weekday: "short" }),
      completed,
      created,
      velocity: completed,
    };
  });

  const workload = teams.map((team) => {
    const teamIssues = issues.filter((issue) => issue.teamId === team.id);
    const completed = teamIssues.filter((issue) => isFinalStatus(statuses, issue.status)).length;
    const open = teamIssues.length - completed;

    return {
      teamId: team.id,
      name: team.name,
      issues: teamIssues.length,
      completed,
      open,
      completionRate: getPercent(completed, teamIssues.length),
    };
  }).sort((left, right) => right.issues - left.issues || left.name.localeCompare(right.name));

  return {
    period: {
      from: range.from,
      to: range.to,
      previousFrom: range.previousFrom,
      previousTo: range.previousTo,
    },
    summary: {
      efficiencyPercent: {
        value: currentEfficiency,
        trend: calculateTrend(currentEfficiency, previousEfficiency),
      },
      resourceLoadPercent: {
        value: resourceLoadCurrent,
        trend: calculateTrend(resourceLoadCurrent, resourceLoadPrevious),
      },
      stressIndex: {
        value: stressCurrent,
        trend: calculateTrend(stressCurrent, stressPrevious),
      },
      overdueIssues: overdueNow,
    },
    charts: {
      velocity,
      workload,
    },
  };
}

function buildDepartmentWhere(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  query: ListDepartmentsFilters,
): Prisma.DepartmentWhereInput {
  return {
    workspaceId,
    ...(workspaceRole === "GUEST" ? { visibility: "PUBLIC" } : {}),
    ...(query.ids ? { id: { in: [...query.ids] } } : {}),
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

  // Index after commit, never before: a job queued inside the transaction could
  // outlive a rollback and point at a row that never existed.
  await indexEntity({
    workspaceId,
    entityType: "DEPARTMENT",
    entityId: department.id,
    reason: "created",
    triggeredByUserId: undefined,
  });

  return getDepartmentById(workspaceId, "MEMBER", department.id);
}

/**
 * `ids` is an internal narrowing used by AI semantic search — see the note on
 * `listTeams`. Not part of the HTTP query schema.
 */
type ListDepartmentsFilters = ListDepartmentsQuery & { ids?: readonly string[] };

export async function listDepartments(workspaceId: string, workspaceRole: WorkspaceRole, query: ListDepartmentsFilters) {
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
  const [workspace, issues, teams] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { customStatuses: true },
    }),
    prisma.issue.findMany({
      where: { workspaceId, departmentId },
      select: {
        status: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
        dueDate: true,
        assigneeId: true,
        teamId: true,
      },
    }),
    prisma.team.findMany({
      where: { workspaceId, departmentId },
      select: {
        id: true,
        name: true,
      },
    }),
  ]);

  const analytics = buildDepartmentAnalytics(
    department,
    ((workspace?.customStatuses as WorkspaceStatusRecord[] | null) ?? []),
    issues,
    teams,
  );

  return {
    ...mapDepartment(department, true),
    analytics,
  };
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

  // Index after commit, never before: a job queued inside the transaction could
  // outlive a rollback and point at a row that never existed.
  await indexEntity({
    workspaceId,
    entityType: "DEPARTMENT",
    entityId: departmentId,
    reason: "updated",
    triggeredByUserId: undefined,
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
