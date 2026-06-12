import type {
  Prisma,
  WorkspaceRole,
} from "../../app/generated/prisma/client.js";

import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { logActivity } from "../../shared/utils/activity.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import { attachInitialTeamDocuments } from "../documents/documents.service.js";
import type {
  CreateTeamInput,
  ListTeamsQuery,
  UpdateTeamInput,
} from "./team.schemas.js";

const teamSummarySelect = {
  id: true,
  name: true,
  description: true,
  visibility: true,
  createdAt: true,
  updatedAt: true,
  lead: {
    select: {
      id: true,
      name: true,
      email: true,
      avatar: true,
    },
  },
  department: {
    select: {
      id: true,
      name: true,
      color: true,
    },
  },
  _count: {
    select: {
      memberships: true,
      projects: true,
      issues: true,
    },
  },
} satisfies Prisma.TeamSelect;

type TeamSummaryRecord = Prisma.TeamGetPayload<{
  select: typeof teamSummarySelect;
}>;

const teamCompactSelect = {
  id: true,
  name: true,
  departmentId: true,
} satisfies Prisma.TeamSelect;

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

function mapTeam(record: TeamSummaryRecord, includeIssueCount: boolean) {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    visibility: record.visibility,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lead: record.lead,
    department: record.department
      ? {
          id: record.department.id,
          name: record.department.name,
          color: record.department.color,
        }
      : null,
    stats: {
      memberCount: record._count.memberships,
      projectCount: record._count.projects,
      ...(includeIssueCount ? { issueCount: record._count.issues } : {}),
    },
  };
}

function buildTeamWhere(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  query: ListTeamsQuery,
): Prisma.TeamWhereInput {
  return {
    workspaceId,
    ...(workspaceRole === "GUEST" ? { visibility: "PUBLIC" } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.leadId ? { leadId: query.leadId } : {}),
    ...(query.visibility ? { visibility: query.visibility } : {}),
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

function getTeamOrderBy(sort: ListTeamsQuery["sort"]): Prisma.TeamOrderByWithRelationInput[] {
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

async function assertTeamAccessible(workspaceId: string, workspaceRole: WorkspaceRole, teamId: string) {
  const team = await prisma.team.findFirst({
    where: {
      id: teamId,
      workspaceId,
      ...(workspaceRole === "GUEST" ? { visibility: "PUBLIC" } : {}),
    },
    select: teamSummarySelect,
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

async function assertDepartmentExists(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  departmentId: string,
) {
  const department = await tx.department.findFirst({
    where: { id: departmentId, workspaceId },
    select: { id: true },
  });

  if (!department) {
    throw new AppError(404, ERROR_CODES.DEPARTMENT_NOT_FOUND, "Department not found");
  }
}

export async function createTeam(workspaceId: string, actorUserId: string, input: CreateTeamInput) {
  const existing = await prisma.team.findFirst({
    where: {
      workspaceId,
      name: { equals: input.name, mode: "insensitive" },
    },
    select: { id: true },
  });

  if (existing) {
    throw new AppError(409, ERROR_CODES.TEAM_NAME_TAKEN, "A team with this name already exists");
  }

  const memberIds = [...new Set([...(input.memberIds ?? []), input.leadId])];

  const team = await prisma.$transaction(async (tx) => {
    await assertWorkspaceMember(
      tx,
      workspaceId,
      input.leadId,
      ERROR_CODES.LEAD_NOT_WORKSPACE_MEMBER,
      "Team lead must be a workspace member",
    );

    await assertWorkspaceMembers(tx, workspaceId, memberIds);

    if (input.departmentId) {
      await assertDepartmentExists(tx, workspaceId, input.departmentId);
    }

    const description = input.description === undefined
      ? undefined
      : normalizeNullableText(input.description);
    const createData: Prisma.TeamUncheckedCreateInput = {
      workspaceId,
      name: input.name,
      leadId: input.leadId,
      departmentId: input.departmentId ?? null,
      visibility: input.visibility ?? "PUBLIC",
      ...(description !== undefined ? { description } : {}),
    };

    const created = await tx.team.create({
      data: createData,
      select: { id: true },
    });

    await tx.teamMembership.createMany({
      data: memberIds.map((userId) => ({
        userId,
        teamId: created.id,
      })),
      skipDuplicates: true,
    });

    if ((input.docs?.length ?? 0) > 0) {
      await attachInitialTeamDocuments(tx, workspaceId, created.id, actorUserId, input.docs ?? []);
    }

    return created;
  });

  return getTeamById(workspaceId, "MEMBER", team.id);
}

export async function listTeams(workspaceId: string, workspaceRole: WorkspaceRole, query: ListTeamsQuery) {
  const limit = clampListLimit(query.limit);
  const where = buildTeamWhere(workspaceId, workspaceRole, query);
  const orderBy = getTeamOrderBy(query.sort);

  const [total, records] = await Promise.all([
    prisma.team.count({ where }),
    prisma.team.findMany({
      where,
      orderBy,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: limit + 1,
      select: query.view === "compact" ? teamCompactSelect : teamSummarySelect,
    }),
  ]);

  const page = slicePage(records, limit);

  return {
    items: query.view === "compact"
      ? page.items
      : page.items.map((record) => mapTeam(record as TeamSummaryRecord, false)),
    meta: {
      total,
      cursor: page.hasMore ? page.items[page.items.length - 1]?.id ?? null : null,
      hasMore: page.hasMore,
    },
  };
}

export async function getTeamById(workspaceId: string, workspaceRole: WorkspaceRole, teamId: string) {
  const team = await assertTeamAccessible(workspaceId, workspaceRole, teamId);
  return mapTeam(team, true);
}

export async function updateTeam(workspaceId: string, teamId: string, input: UpdateTeamInput) {
  const current = await prisma.team.findFirst({
    where: { id: teamId, workspaceId },
    select: { id: true, leadId: true, name: true },
  });

  if (!current) {
    throw new AppError(404, ERROR_CODES.TEAM_NOT_FOUND, "Team not found");
  }

  if (input.name) {
    const nameConflict = await prisma.team.findFirst({
      where: {
        workspaceId,
        id: { not: teamId },
        name: { equals: input.name, mode: "insensitive" },
      },
      select: { id: true },
    });

    if (nameConflict) {
      throw new AppError(409, ERROR_CODES.TEAM_NAME_TAKEN, "A team with this name already exists");
    }
  }

  await prisma.$transaction(async (tx) => {
    if (input.leadId) {
      await assertWorkspaceMember(
        tx,
        workspaceId,
        input.leadId,
        ERROR_CODES.LEAD_NOT_WORKSPACE_MEMBER,
        "Team lead must be a workspace member",
      );
    }

    if (input.departmentId) {
      await assertDepartmentExists(tx, workspaceId, input.departmentId);
    }

    const updateData: Prisma.TeamUncheckedUpdateInput = {};

    if (input.name !== undefined) {
      updateData.name = input.name;
    }

    if (input.description !== undefined) {
      updateData.description = normalizeNullableText(input.description);
    }

    if (input.leadId !== undefined) {
      updateData.leadId = input.leadId;
    }

    if (input.departmentId !== undefined) {
      updateData.departmentId = input.departmentId;
    }

    if (input.visibility !== undefined) {
      updateData.visibility = input.visibility;
    }

    await tx.team.update({
      where: { id: teamId },
      data: updateData,
    });

    if (input.leadId) {
      await tx.teamMembership.createMany({
        data: [{ userId: input.leadId, teamId }],
        skipDuplicates: true,
      });
    }

    if (input.departmentId !== undefined) {
      await tx.project.updateMany({
        where: { workspaceId, teamId },
        data: { departmentId: input.departmentId },
      });

      await tx.issue.updateMany({
        where: { workspaceId, teamId },
        data: { departmentId: input.departmentId },
      });
    }
  });

  if (input.leadId !== undefined && input.leadId !== current.leadId) {
    await logActivity({
      workspaceId,
      actorId: input.leadId ?? current.leadId ?? "system",
      type: "TEAM_MEMBER_ROLE_CHANGED",
      targetType: "TEAM",
      targetId: teamId,
      message: `Team lead changed for ${current.name}`,
      metadata: { teamId, roleBefore: current.leadId, roleAfter: input.leadId ?? null },
    });
  }

  return getTeamById(workspaceId, "MEMBER", teamId);
}

export async function deleteTeam(workspaceId: string, teamId: string) {
  const team = await prisma.team.findFirst({
    where: { id: teamId, workspaceId },
    select: { id: true },
  });

  if (!team) {
    throw new AppError(404, ERROR_CODES.TEAM_NOT_FOUND, "Team not found");
  }

  await prisma.team.delete({
    where: { id: teamId },
  });
}

export async function getTeamOwnership(workspaceId: string, teamId: string) {
  const team = await prisma.team.findFirst({
    where: { id: teamId, workspaceId },
    select: { leadId: true },
  });

  return {
    exists: Boolean(team),
    ownerId: team?.leadId ?? null,
  };
}
