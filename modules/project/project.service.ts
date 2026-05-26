import type { WorkspaceRole } from "../../app/generated/prisma/client.js";

import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { logActivity } from "../../shared/utils/activity.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import { createNotification } from "../notification/notification.service.js";
import { createProjectMembershipNotification } from "../notification/notification.service.js";
import type {
  CreateProjectInput,
  ListProjectsQuery,
  UpdateProjectInput,
} from "./project.schemas.js";

const projectFullSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  status: true,
  visibility: true,
  startDate: true,
  targetDate: true,
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
  team: {
    select: {
      id: true,
      name: true,
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
      issues: true,
      memberships: true,
    },
  },
  featureRoadmap: true,
  featureCycles: true,
  featureIssueTracking: true,
} as const;

const projectCompactSelect = {
  id: true,
  name: true,
  teamId: true,
  departmentId: true,
  status: true,
  visibility: true,
} as const;
type ProjectFullRecord = any;

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "project";
}

async function buildUniqueSlug(
  tx: any,
  workspaceId: string,
  base: string,
  excludeProjectId?: string,
) {
  const root = slugify(base);
  let candidate = root;
  let index = 1;

  while (true) {
    const existing = await tx.project.findFirst({
      where: {
        workspaceId,
        slug: candidate,
        ...(excludeProjectId ? { NOT: { id: excludeProjectId } } : {}),
      },
      select: { id: true },
    });

    if (!existing) {
      return candidate;
    }

    index += 1;
    candidate = `${root}-${index}`;
  }
}

function toDateOrNull(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return new Date(value);
}

function toNullableText(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value.length === 0) {
    return null;
  }
  return value;
}

function mapProject(record: ProjectFullRecord) {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    description: record.description,
    status: record.status,
    visibility: record.visibility,
    progress: 0,
    startDate: record.startDate,
    targetDate: record.targetDate,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lead: record.lead,
    team: record.team,
    department: record.department
      ? {
          id: record.department.id,
          name: record.department.name,
          color: record.department.color,
        }
      : null,
    stats: {
      issueCount: record._count.issues,
      completedIssueCount: 0,
      memberCount: record._count.memberships,
    },
    features: {
      roadmap: record.featureRoadmap,
      cycles: record.featureCycles,
      issueTracking: record.featureIssueTracking,
    },
  };
}

function getProjectOrderBy(sort: ListProjectsQuery["sort"]) {
  switch (sort) {
    case "updatedAt:asc":
      return [{ updatedAt: "asc" }, { id: "asc" }] as any;
    case "name:asc":
      return [{ name: "asc" }, { id: "asc" }] as any;
    case "name:desc":
      return [{ name: "desc" }, { id: "desc" }] as any;
    case "createdAt:asc":
      return [{ createdAt: "asc" }, { id: "asc" }] as any;
    case "createdAt:desc":
      return [{ createdAt: "desc" }, { id: "desc" }] as any;
    case "targetDate:asc":
      return [{ targetDate: "asc" }, { id: "asc" }] as any;
    case "targetDate:desc":
      return [{ targetDate: "desc" }, { id: "desc" }] as any;
    case "updatedAt:desc":
    default:
      return [{ updatedAt: "desc" }, { id: "desc" }] as any;
  }
}

function buildProjectWhere(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  userId: string,
  query: ListProjectsQuery,
): any {
  const and: any[] = [];

  if (workspaceRole !== "OWNER" && workspaceRole !== "ADMIN") {
    and.push({
      OR: [
        { visibility: "PUBLIC" },
        { leadId: userId },
        { memberships: { some: { userId } } },
      ],
    });
  }

  if (query.q) {
    and.push({
      OR: [
        { name: { contains: query.q, mode: "insensitive" } },
        { description: { contains: query.q, mode: "insensitive" } },
        { slug: { contains: query.q, mode: "insensitive" } },
      ],
    });
  }

  return {
    workspaceId,
    ...(query.teamId ? { teamId: query.teamId } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.leadId ? { leadId: query.leadId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.visibility ? { visibility: query.visibility } : {}),
    ...(and.length > 0 ? { AND: and } : {}),
  };
}

async function assertTeamInWorkspace(
  tx: any,
  workspaceId: string,
  teamId: string,
) {
  const team = await tx.team.findFirst({
    where: { id: teamId, workspaceId },
    select: { id: true, name: true, departmentId: true },
  });

  if (!team) {
    throw new AppError(404, ERROR_CODES.TEAM_NOT_IN_WORKSPACE, "Team not found in workspace");
  }

  return team;
}

async function assertWorkspaceMember(
  tx: any,
  workspaceId: string,
  userId: string,
  code: string,
  message: string,
) {
  const member = await tx.workspaceMembership.findUnique({
    where: {
      userId_workspaceId: {
        userId,
        workspaceId,
      },
    },
    select: { userId: true },
  });

  if (!member) {
    throw new AppError(404, code, message);
  }
}

export async function getProjectOwnership(workspaceId: string, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId },
    select: { leadId: true },
  });

  return {
    exists: Boolean(project),
    ownerId: project?.leadId ?? null,
  };
}

export async function createProject(workspaceId: string, actorUserId: string, input: CreateProjectInput) {
  const existingByName = await prisma.project.findFirst({
    where: {
      workspaceId,
      name: { equals: input.name, mode: "insensitive" },
    },
    select: { id: true },
  });

  if (existingByName) {
    throw new AppError(409, ERROR_CODES.PROJECT_NAME_TAKEN, "A project with this name already exists");
  }

  const createdPayload = await prisma.$transaction(async (tx) => {
    const team = await assertTeamInWorkspace(tx, workspaceId, input.teamId);
    const resolvedDepartmentId = team.departmentId ?? null;

    if (input.leadId) {
      await assertWorkspaceMember(
        tx,
        workspaceId,
        input.leadId,
        ERROR_CODES.LEAD_NOT_WORKSPACE_MEMBER,
        "Project lead must be a workspace member",
      );
    }

    const slug = await buildUniqueSlug(tx, workspaceId, input.slug ?? input.name);

    const createdProject = await tx.project.create({
      data: {
        workspaceId,
        teamId: team.id,
        departmentId: resolvedDepartmentId,
        name: input.name,
        slug,
        description: toNullableText(input.description),
        leadId: input.leadId ?? null,
        visibility: input.visibility ?? "PUBLIC",
        startDate: toDateOrNull(input.startDate),
        targetDate: toDateOrNull(input.targetDate),
        featureRoadmap: input.features?.roadmap ?? true,
        featureCycles: input.features?.cycles ?? true,
        featureIssueTracking: input.features?.issueTracking ?? true,
      } as any,
      select: { id: true, leadId: true },
    });

    const memberSet = new Set(input.memberIds ?? []);
    if (createdProject.leadId) {
      memberSet.add(createdProject.leadId);
    }

    const memberIds = [...memberSet];
    if (memberIds.length > 0) {
      const workspaceMembers = await tx.workspaceMembership.findMany({
        where: {
          workspaceId,
          userId: { in: memberIds },
        },
        select: { userId: true },
      });

      if (workspaceMembers.length !== memberIds.length) {
        throw new AppError(
          404,
          ERROR_CODES.MEMBER_NOT_WORKSPACE_MEMBER,
          "One or more users are not members of this workspace",
        );
      }

      await (tx as any).projectMembership.createMany({
        data: memberIds.map((userId) => ({
          projectId: createdProject.id,
          userId,
          membershipRole: userId === createdProject.leadId ? "LEAD" : "MEMBER",
        })),
        skipDuplicates: true,
      });
    }

    return {
      projectId: createdProject.id,
      memberIds,
    };
  });

  const created = await prisma.project.findFirst({
    where: { id: createdPayload.projectId, workspaceId },
    select: projectFullSelect,
  });

  if (!created) {
    throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
  }

  await logActivity({
    workspaceId,
    actorId: actorUserId,
    type: "PROJECT_CREATED",
    targetType: "PROJECT",
    targetId: created.id,
    message: `Project ${created.name} created`,
    metadata: { projectId: created.id, projectName: created.name },
  });

  await Promise.all((createdPayload.memberIds ?? []).map((memberId) => createProjectMembershipNotification({
    workspaceId,
    recipientUserId: memberId,
    actorUserId,
    projectId: created.id,
    projectName: created.name,
    action: "added",
  })));

  return mapProject(created);
}

export async function listProjects(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  userId: string,
  query: ListProjectsQuery,
) {
  const limit = clampListLimit(query.limit);
  const where = buildProjectWhere(workspaceId, workspaceRole, userId, query);
  const orderBy = getProjectOrderBy(query.sort);

  const [total, records] = await Promise.all([
    prisma.project.count({ where }),
    prisma.project.findMany({
      where,
      orderBy: orderBy as any,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: limit + 1,
      select: query.view === "compact" ? projectCompactSelect : projectFullSelect,
    }),
  ]);

  const page = slicePage(records, limit);

  return {
    items: query.view === "compact"
      ? page.items
      : page.items.map((record) => mapProject(record as ProjectFullRecord)),
    meta: {
      total,
      cursor: page.hasMore ? page.items[page.items.length - 1]?.id ?? null : null,
      hasMore: page.hasMore,
    },
  };
}

async function assertProjectAccessible(
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
    select: projectFullSelect,
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

export async function getProjectById(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  userId: string,
  projectId: string,
) {
  const project = await assertProjectAccessible(workspaceId, workspaceRole, userId, projectId);
  return mapProject(project);
}

export async function updateProject(workspaceId: string, projectId: string, actorUserId: string, input: UpdateProjectInput) {
  let previousLeadId: string | null = null;
  let resolvedLeadId: string | null = null;

  const updatedId = await prisma.$transaction(async (tx) => {
    const current = await tx.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { id: true, leadId: true, teamId: true, name: true },
    });

    if (!current) {
      throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
    }
    previousLeadId = current.leadId;

    if (input.name && input.name !== current.name) {
      const nameConflict = await tx.project.findFirst({
        where: {
          workspaceId,
          name: { equals: input.name, mode: "insensitive" },
          NOT: { id: projectId },
        },
        select: { id: true },
      });
      if (nameConflict) {
        throw new AppError(409, ERROR_CODES.PROJECT_NAME_TAKEN, "A project with this name already exists");
      }
    }

    let teamId = current.teamId;
    let departmentId: string | null | undefined = undefined;
    if (input.teamId) {
      const team = await assertTeamInWorkspace(tx, workspaceId, input.teamId);
      teamId = team.id;
      departmentId = team.departmentId ?? null;
    } else if (input.departmentId !== undefined) {
      departmentId = input.departmentId;
    }

    let leadId: string | null | undefined = undefined;
    if (input.leadId !== undefined) {
      if (input.leadId === null) {
        leadId = null;
      } else {
        await assertWorkspaceMember(
          tx,
          workspaceId,
          input.leadId,
          ERROR_CODES.LEAD_NOT_WORKSPACE_MEMBER,
          "Project lead must be a workspace member",
        );
        leadId = input.leadId;
      }
    }
    resolvedLeadId = leadId !== undefined ? leadId : current.leadId;

    let slug: string | undefined = undefined;
    if (input.slug) {
      slug = await buildUniqueSlug(tx, workspaceId, input.slug, projectId);
    } else if (input.name) {
      slug = await buildUniqueSlug(tx, workspaceId, input.name, projectId);
    }

    await tx.project.update({
      where: { id: projectId },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(slug ? { slug } : {}),
        ...(input.description !== undefined ? { description: toNullableText(input.description) } : {}),
        ...(teamId !== current.teamId ? { teamId } : {}),
        ...(departmentId !== undefined ? { departmentId } : {}),
        ...(leadId !== undefined ? { leadId } : {}),
        ...(input.visibility ? { visibility: input.visibility } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.startDate !== undefined ? { startDate: toDateOrNull(input.startDate) } : {}),
        ...(input.targetDate !== undefined ? { targetDate: toDateOrNull(input.targetDate) } : {}),
        ...(input.features
          ? {
              ...(input.features.roadmap !== undefined
                ? { featureRoadmap: input.features.roadmap }
                : {}),
              ...(input.features.cycles !== undefined
                ? { featureCycles: input.features.cycles }
                : {}),
              ...(input.features.issueTracking !== undefined
                ? { featureIssueTracking: input.features.issueTracking }
                : {}),
            }
          : {}),
      } as any,
    });

    if (leadId) {
      await (tx as any).projectMembership.upsert({
        where: {
          projectId_userId: {
            projectId,
            userId: leadId,
          },
        },
        update: { membershipRole: "LEAD" },
        create: { projectId, userId: leadId, membershipRole: "LEAD" },
      });
    }

    return projectId;
  });

  const updated = await prisma.project.findFirst({
    where: { id: updatedId, workspaceId },
    select: projectFullSelect,
  });

  if (!updated) {
    throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
  }

  await logActivity({
    workspaceId,
    actorId: actorUserId,
    type: "PROJECT_UPDATED",
    targetType: "PROJECT",
    targetId: updated.id,
    message: `Project ${updated.name} updated`,
    metadata: { projectId: updated.id, projectName: updated.name },
  });

  if (resolvedLeadId && resolvedLeadId !== previousLeadId) {
    await createNotification({
      workspaceId,
      recipientUserId: resolvedLeadId,
      actorUserId,
      type: "PROJECT_MEMBER",
      category: "membership",
      title: "You are now project lead",
      message: `You were assigned as lead for project ${updated.name}`,
      target: {
        type: "project",
        id: updated.id,
        url: `/projects/${updated.id}`,
      },
      metadata: {
        projectId: updated.id,
        action: "lead_assigned",
        previousLeadId,
        newLeadId: resolvedLeadId,
        workspaceId,
        entityId: updated.id,
        entityTitle: updated.name,
        url: `/projects/${updated.id}`,
      },
      eventId: `project-lead:${updated.id}:${resolvedLeadId}`,
    });
  }

  return mapProject(updated);
}

export async function deleteProject(workspaceId: string, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId },
    select: { id: true },
  });

  if (!project) {
    throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
  }

  await prisma.project.delete({
    where: { id: projectId },
  });
}
