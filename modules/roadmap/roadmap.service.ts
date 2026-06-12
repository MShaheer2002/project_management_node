import type { WorkspaceRole } from "../../app/generated/prisma/client.js";

import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { logActivity } from "../../shared/utils/activity.js";
import { AppError } from "../../shared/utils/api-error.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import { prisma } from "../../shared/utils/prisma.js";
import { createNotification } from "../notification/notification.service.js";
import { getSocketServer } from "../../socket/index.js";
import { createRealtimeEnvelope } from "../../socket/serializers.js";
import type {
  CancelDependencyInput,
  CreateDependencyInput,
  CreateMilestoneInput,
  ListRoadmapQuery,
  ReorderMilestonesInput,
  ResolveDependencyInput,
  UpdateMilestoneInput,
  UpdateRoadmapScheduleInput,
} from "./roadmap.schemas.js";
import {
  addDaysToIsoDate,
  computeRoadmapHealth,
  detectDependencyCycle,
  getDateDiffDays,
  getExpectedProgressPercent,
  getForecastStatus,
  getHealthSeverityValue,
  getRoadmapWindow,
  getTimelineLayout,
  isDateOutsideRange,
  toIsoDate,
  toIsoDateTime,
  uniqueIds,
} from "./roadmap.utils.js";

type ProjectRow = any;
type MilestoneRow = any;
type DependencyRow = any;

const projectRoadmapSelect = {
  id: true,
  workspaceId: true,
  teamId: true,
  departmentId: true,
  name: true,
  slug: true,
  description: true,
  status: true,
  visibility: true,
  startDate: true,
  targetDate: true,
  featureRoadmap: true,
  createdAt: true,
  updatedAt: true,
  leadId: true,
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
      leadId: true,
    },
  },
  department: {
    select: {
      id: true,
      name: true,
      color: true,
    },
  },
} as const;

function isPrivileged(role: WorkspaceRole) {
  return role === "OWNER" || role === "ADMIN";
}

function isGuest(role: WorkspaceRole) {
  return role === "GUEST";
}

function toNullableText(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null || value.length === 0) return null;
  return value;
}

function toDateOrNull(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return new Date(value);
}

function buildProjectVisibilityClause(role: WorkspaceRole, userId: string) {
  if (isPrivileged(role)) {
    return {};
  }

  return {
    OR: [
      { visibility: "PUBLIC" },
      { leadId: userId },
      { memberships: { some: { userId } } },
      { team: { leadId: userId } },
    ],
  };
}

async function emitRoadmapEvent(workspaceId: string, type: string, payload: Record<string, unknown>, projectId?: string) {
  const io = getSocketServer();
  if (!io) return;

  const envelope = createRealtimeEnvelope({
    type,
    workspaceId,
    payload,
  });

  io.to(`workspace:${workspaceId}`).emit(type, envelope);
  if (projectId) {
    io.to(`project:${projectId}`).emit(type, envelope);
  }
}

async function assertWorkspaceMember(workspaceId: string, userId: string) {
  const membership = await prisma.workspaceMembership.findUnique({
    where: {
      userId_workspaceId: {
        userId,
        workspaceId,
      },
    },
    select: { userId: true },
  });

  if (!membership) {
    throw new AppError(404, ERROR_CODES.MEMBER_NOT_WORKSPACE_MEMBER, "Member not found in workspace");
  }
}

async function assertVisibleProject(workspaceId: string, role: WorkspaceRole, userId: string, projectId: string) {
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      workspaceId,
      ...buildProjectVisibilityClause(role, userId),
    } as any,
    select: projectRoadmapSelect,
  });

  if (project) {
    return project;
  }

  const existing = await prisma.project.findFirst({
    where: { id: projectId, workspaceId },
    select: { id: true, visibility: true },
  });

  if (!existing) {
    throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
  }

  throw new AppError(404, ERROR_CODES.PRIVATE_PROJECT_FORBIDDEN, "Project is not visible");
}

async function assertProjectInWorkspace(workspaceId: string, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId },
    select: projectRoadmapSelect,
  });

  if (!project) {
    throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
  }

  return project;
}

function assertRoadmapMutableProject(project: ProjectRow) {
  if (!project.featureRoadmap) {
    throw new AppError(409, ERROR_CODES.ROADMAP_DISABLED_FOR_PROJECT, "Roadmap is disabled for this project");
  }

  if (project.status === "ARCHIVED") {
    throw new AppError(409, ERROR_CODES.ROADMAP_FORBIDDEN, "Archived projects are read-only for roadmap changes");
  }
}

function validateScheduleRange(startDate: Date | null | undefined, targetDate: Date | null | undefined) {
  if (startDate && targetDate && startDate > targetDate) {
    throw new AppError(422, ERROR_CODES.ROADMAP_INVALID_DATE_RANGE, "startDate must be on or before targetDate");
  }
}

async function loadIssueCounts(workspaceId: string, projectIds: string[]) {
  if (projectIds.length === 0) return new Map<string, { total: number; completed: number; open: number }>();

  const rows = await prisma.issue.findMany({
    where: { workspaceId, projectId: { in: projectIds } },
    select: { projectId: true, status: true },
  });

  const map = new Map<string, { total: number; completed: number; open: number }>();

  for (const row of rows) {
    const current = map.get(row.projectId) ?? { total: 0, completed: 0, open: 0 };
    current.total += 1;
    if (row.status === "DONE") {
      current.completed += 1;
    } else {
      current.open += 1;
    }
    map.set(row.projectId, current);
  }

  return map;
}

async function loadMilestoneMap(workspaceId: string, projectIds: string[]) {
  if (projectIds.length === 0) return new Map<string, MilestoneRow[]>();

  const rows = await (prisma as any).projectMilestone.findMany({
    where: { workspaceId, projectId: { in: projectIds } },
    include: {
      owner: { select: { id: true, name: true, email: true, avatar: true } },
      completedBy: { select: { id: true, name: true, email: true, avatar: true } },
      createdBy: { select: { id: true, name: true, email: true, avatar: true } },
    },
    orderBy: [{ sortOrder: "asc" }, { dueDate: "asc" }, { createdAt: "asc" }],
  });

  const map = new Map<string, MilestoneRow[]>();

  for (const row of rows) {
    const current = map.get(row.projectId) ?? [];
    current.push(row);
    map.set(row.projectId, current);
  }

  return map;
}

async function loadDependencyMaps(workspaceId: string, projectIds: string[]) {
  if (projectIds.length === 0) {
    return {
      upstream: new Map<string, DependencyRow[]>(),
      downstream: new Map<string, DependencyRow[]>(),
    };
  }

  const rows = await (prisma as any).projectDependency.findMany({
    where: {
      workspaceId,
      OR: [
        { blockingProjectId: { in: projectIds } },
        { blockedProjectId: { in: projectIds } },
      ],
    },
    include: {
      blockingProject: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          visibility: true,
          startDate: true,
          targetDate: true,
          team: { select: { id: true, name: true } },
          department: { select: { id: true, name: true, color: true } },
          lead: { select: { id: true, name: true, email: true, avatar: true } },
        },
      },
      blockedProject: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          visibility: true,
          startDate: true,
          targetDate: true,
          team: { select: { id: true, name: true } },
          department: { select: { id: true, name: true, color: true } },
          lead: { select: { id: true, name: true, email: true, avatar: true } },
        },
      },
      createdBy: { select: { id: true, name: true, email: true, avatar: true } },
      resolvedBy: { select: { id: true, name: true, email: true, avatar: true } },
      cancelledBy: { select: { id: true, name: true, email: true, avatar: true } },
    },
    orderBy: [{ createdAt: "desc" }],
  });

  const upstream = new Map<string, DependencyRow[]>();
  const downstream = new Map<string, DependencyRow[]>();

  for (const row of rows) {
    const blockedRows = upstream.get(row.blockedProjectId) ?? [];
    blockedRows.push(row);
    upstream.set(row.blockedProjectId, blockedRows);

    const blockingRows = downstream.get(row.blockingProjectId) ?? [];
    blockingRows.push(row);
    downstream.set(row.blockingProjectId, blockingRows);
  }

  return { upstream, downstream };
}

function mapMilestone(row: MilestoneRow, project?: ProjectRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    dueDate: toIsoDateTime(row.dueDate),
    owner: row.owner
      ? {
          id: row.owner.id,
          name: row.owner.name,
          email: row.owner.email,
          avatar: row.owner.avatar,
        }
      : null,
    status: row.status,
    completedAt: toIsoDateTime(row.completedAt),
    completedBy: row.completedBy
      ? {
          id: row.completedBy.id,
          name: row.completedBy.name,
          email: row.completedBy.email,
          avatar: row.completedBy.avatar,
        }
      : null,
    sortOrder: row.sortOrder,
    outOfRange: project
      ? isDateOutsideRange(row.dueDate, project.startDate, project.targetDate)
      : false,
    createdAt: toIsoDateTime(row.createdAt),
    updatedAt: toIsoDateTime(row.updatedAt),
  };
}

function mapDependency(row: DependencyRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    blockingProjectId: row.blockingProjectId,
    blockedProjectId: row.blockedProjectId,
    status: row.status,
    note: row.note,
    resolvedAt: toIsoDateTime(row.resolvedAt),
    cancelledAt: toIsoDateTime(row.cancelledAt),
    createdAt: toIsoDateTime(row.createdAt),
    updatedAt: toIsoDateTime(row.updatedAt),
    blockingProject: row.blockingProject
      ? {
          id: row.blockingProject.id,
          name: row.blockingProject.name,
          slug: row.blockingProject.slug,
          status: row.blockingProject.status,
          visibility: row.blockingProject.visibility,
          startDate: toIsoDate(row.blockingProject.startDate),
          targetDate: toIsoDate(row.blockingProject.targetDate),
          team: row.blockingProject.team,
          department: row.blockingProject.department,
          lead: row.blockingProject.lead,
        }
      : null,
    blockedProject: row.blockedProject
      ? {
          id: row.blockedProject.id,
          name: row.blockedProject.name,
          slug: row.blockedProject.slug,
          status: row.blockedProject.status,
          visibility: row.blockedProject.visibility,
          startDate: toIsoDate(row.blockedProject.startDate),
          targetDate: toIsoDate(row.blockedProject.targetDate),
          team: row.blockedProject.team,
          department: row.blockedProject.department,
          lead: row.blockedProject.lead,
        }
      : null,
  };
}

function buildRoadmapItem(
  project: ProjectRow,
  windowFrom: string,
  windowTo: string,
  issueCounts: Map<string, { total: number; completed: number; open: number }>,
  milestoneMap: Map<string, MilestoneRow[]>,
  upstreamDependencyMap: Map<string, DependencyRow[]>,
  downstreamDependencyMap: Map<string, DependencyRow[]>,
) {
  const now = new Date();
  const counts = issueCounts.get(project.id) ?? { total: 0, completed: 0, open: 0 };
  const progress = counts.total === 0
    ? project.status === "COMPLETED" ? 100 : 0
    : Math.round((counts.completed / counts.total) * 100);
  const milestones = milestoneMap.get(project.id) ?? [];
  const upstreamDependencies = upstreamDependencyMap.get(project.id) ?? [];
  const downstreamDependencies = downstreamDependencyMap.get(project.id) ?? [];
  const activeUpstream = upstreamDependencies.filter((row) => row.status === "ACTIVE");
  const activeDownstream = downstreamDependencies.filter((row) => row.status === "ACTIVE");
  const overdueMilestones = milestones.filter((row) => row.status !== "COMPLETED" && new Date(row.dueDate) < now);
  const nextMilestone = milestones.find((row) => row.status !== "COMPLETED");
  const health = computeRoadmapHealth({
    startDate: project.startDate,
    targetDate: project.targetDate,
    progress,
    blocked: activeUpstream.length > 0,
    overdueMilestoneCount: overdueMilestones.length,
    projectStatus: project.status,
    now,
  });
  const expectedProgress = getExpectedProgressPercent(project.startDate, project.targetDate, now);
  const forecast = getForecastStatus(progress, expectedProgress);

  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    status: project.status,
    visibility: project.visibility,
    description: project.description,
    startDate: toIsoDate(project.startDate),
    targetDate: toIsoDate(project.targetDate),
    updatedAt: toIsoDateTime(project.updatedAt),
    createdAt: toIsoDateTime(project.createdAt),
    progress,
    team: project.team ? { id: project.team.id, name: project.team.name } : null,
    department: project.department
      ? { id: project.department.id, name: project.department.name, color: project.department.color }
      : null,
    lead: project.lead
      ? {
          id: project.lead.id,
          name: project.lead.name,
          email: project.lead.email,
          avatar: project.lead.avatar,
        }
      : null,
    features: {
      roadmap: project.featureRoadmap,
    },
    schedule: {
      startDate: toIsoDate(project.startDate),
      targetDate: toIsoDate(project.targetDate),
      layout: getTimelineLayout(project.startDate, project.targetDate, windowFrom, windowTo),
      durationDays: project.startDate && project.targetDate ? getDateDiffDays(project.startDate, project.targetDate) + 1 : null,
    },
    stats: {
      totalIssues: counts.total,
      completedIssues: counts.completed,
      openIssues: counts.open,
    },
    health: {
      status: health.status,
      reasonCodes: health.reasons,
      severity: getHealthSeverityValue(health.status),
    },
    milestoneSummary: {
      total: milestones.length,
      completed: milestones.filter((row) => row.status === "COMPLETED").length,
      overdue: overdueMilestones.length,
      next: nextMilestone ? mapMilestone(nextMilestone, project) : null,
    },
    dependencySummary: {
      blocked: activeUpstream.length > 0,
      blockedByCount: activeUpstream.length,
      blockingCount: activeDownstream.length,
    },
    forecast: {
      expectedProgress,
      variance: forecast.variance,
      status: forecast.status,
      projectedTargetDate: forecast.variance !== null && forecast.variance < -20 && project.targetDate
        ? addDaysToIsoDate(project.targetDate, Math.ceil(Math.abs(forecast.variance) / 5))
        : toIsoDate(project.targetDate),
    },
  };
}

function sortRoadmapItems(items: any[], sort: ListRoadmapQuery["sort"] | undefined) {
  const clone = [...items];

  clone.sort((left, right) => {
    switch (sort) {
      case "targetDate:asc":
        return (left.targetDate ?? "9999-12-31").localeCompare(right.targetDate ?? "9999-12-31") || left.id.localeCompare(right.id);
      case "targetDate:desc":
        return (right.targetDate ?? "").localeCompare(left.targetDate ?? "") || right.id.localeCompare(left.id);
      case "startDate:asc":
        return (left.startDate ?? "9999-12-31").localeCompare(right.startDate ?? "9999-12-31") || left.id.localeCompare(right.id);
      case "startDate:desc":
        return (right.startDate ?? "").localeCompare(left.startDate ?? "") || right.id.localeCompare(left.id);
      case "progress:asc":
        return left.progress - right.progress || left.id.localeCompare(right.id);
      case "progress:desc":
        return right.progress - left.progress || left.id.localeCompare(right.id);
      case "health:asc":
        return left.health.severity - right.health.severity || left.id.localeCompare(right.id);
      case "health:desc":
        return right.health.severity - left.health.severity || left.id.localeCompare(right.id);
      case "name:asc":
        return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
      case "updatedAt:desc":
      default:
        return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || right.id.localeCompare(left.id);
    }
  });

  return clone;
}

function applyCursorPage<T extends { id: string }>(items: T[], cursor: string | undefined, limit: number) {
  let filtered = items;

  if (cursor) {
    const index = items.findIndex((item) => item.id === cursor);
    filtered = index >= 0 ? items.slice(index + 1) : items;
  }

  const page = slicePage(filtered, limit);
  return {
    items: page.items,
    meta: {
      total: items.length,
      hasMore: page.hasMore,
      nextCursor: page.hasMore ? page.items[page.items.length - 1]?.id ?? null : null,
    },
  };
}

async function notifyProjectLead(params: {
  workspaceId: string;
  actorUserId: string;
  recipientUserId: string | null | undefined;
  title: string;
  message: string;
  projectId: string;
  projectName: string;
  metadata?: Record<string, unknown>;
}) {
  if (!params.recipientUserId) return;

  await createNotification({
    workspaceId: params.workspaceId,
    recipientUserId: params.recipientUserId,
    actorUserId: params.actorUserId,
    type: "UPDATE",
    category: "update",
    title: params.title,
    message: params.message,
    target: {
      type: "project",
      id: params.projectId,
      url: `/projects/${params.projectId}`,
    },
    metadata: {
      projectId: params.projectId,
      entityId: params.projectId,
      entityTitle: params.projectName,
      url: `/projects/${params.projectId}`,
      ...(params.metadata ?? {}),
    },
  });
}

async function assertDependencyInWorkspace(workspaceId: string, dependencyId: string) {
  const dependency = await (prisma as any).projectDependency.findFirst({
    where: { id: dependencyId, workspaceId },
    include: {
      blockingProject: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          visibility: true,
          startDate: true,
          targetDate: true,
          teamId: true,
          leadId: true,
          team: { select: { id: true, name: true, leadId: true } },
          department: { select: { id: true, name: true, color: true } },
          lead: { select: { id: true, name: true, email: true, avatar: true } },
          featureRoadmap: true,
          updatedAt: true,
          createdAt: true,
        },
      },
      blockedProject: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          visibility: true,
          startDate: true,
          targetDate: true,
          teamId: true,
          leadId: true,
          team: { select: { id: true, name: true, leadId: true } },
          department: { select: { id: true, name: true, color: true } },
          lead: { select: { id: true, name: true, email: true, avatar: true } },
          featureRoadmap: true,
          updatedAt: true,
          createdAt: true,
        },
      },
      createdBy: { select: { id: true, name: true, email: true, avatar: true } },
      resolvedBy: { select: { id: true, name: true, email: true, avatar: true } },
      cancelledBy: { select: { id: true, name: true, email: true, avatar: true } },
    },
  });

  if (!dependency) {
    throw new AppError(404, ERROR_CODES.DEPENDENCY_NOT_FOUND, "Roadmap dependency not found");
  }

  return dependency;
}

export async function hasRoadmapManageAccess(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
  projectId: string,
) {
  if (isPrivileged(role)) return true;
  if (isGuest(role)) return false;

  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId },
    select: {
      id: true,
      leadId: true,
      team: { select: { leadId: true } },
    },
  });

  if (!project) {
    throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
  }

  return project.leadId === userId || project.team?.leadId === userId;
}

export async function hasAnyRoadmapManageAccess(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
  projectIds: string[],
) {
  for (const projectId of uniqueIds(projectIds)) {
    if (await hasRoadmapManageAccess(workspaceId, userId, role, projectId)) {
      return true;
    }
  }

  return false;
}

export async function hasDependencyManageAccess(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
  dependencyId: string,
) {
  if (isPrivileged(role)) return true;
  if (isGuest(role)) return false;

  const dependency = await assertDependencyInWorkspace(workspaceId, dependencyId);

  return [
    dependency.blockingProject?.leadId,
    dependency.blockingProject?.team?.leadId,
    dependency.blockedProject?.leadId,
    dependency.blockedProject?.team?.leadId,
  ].some((value) => value === userId);
}

export async function listRoadmap(
  workspaceId: string,
  role: WorkspaceRole,
  userId: string,
  query: ListRoadmapQuery,
) {
  const limit = clampListLimit(query.limit, 50);
  const window = getRoadmapWindow(query.view ?? "QUARTER", query.from, query.to);
  const projectWhere: any = {
    workspaceId,
    ...buildProjectVisibilityClause(role, userId),
    ...(query.teamId ? { teamId: query.teamId } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.leadId ? { leadId: query.leadId } : {}),
    ...(query.projectId ? { id: query.projectId } : {}),
    ...(query.status ? { status: query.status } : { status: { not: "ARCHIVED" } }),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: "insensitive" } },
            { slug: { contains: query.q, mode: "insensitive" } },
            { description: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {}),
    featureRoadmap: true,
  };

  const allProjects = await prisma.project.findMany({
    where: projectWhere,
    select: projectRoadmapSelect,
  });

  const scheduledProjects = allProjects.filter((project) => project.startDate && project.targetDate);
  const unscheduledProjects = allProjects.filter((project) => !project.startDate || !project.targetDate);
  const allProjectIds = allProjects.map((project) => project.id);
  const issueCounts = await loadIssueCounts(workspaceId, allProjectIds);
  const milestoneMap = await loadMilestoneMap(workspaceId, allProjectIds);
  const dependencyMaps = await loadDependencyMaps(workspaceId, allProjectIds);

  let scheduledItems = scheduledProjects.map((project) =>
    buildRoadmapItem(
      project,
      window.from,
      window.to,
      issueCounts,
      milestoneMap,
      dependencyMaps.upstream,
      dependencyMaps.downstream,
    ),
  );

  let unscheduledItems = unscheduledProjects.map((project) =>
    buildRoadmapItem(
      project,
      window.from,
      window.to,
      issueCounts,
      milestoneMap,
      dependencyMaps.upstream,
      dependencyMaps.downstream,
    ),
  );

  if (query.health) {
    scheduledItems = scheduledItems.filter((item) => item.health.status === query.health);
    unscheduledItems = unscheduledItems.filter((item) => item.health.status === query.health);
  }

  scheduledItems = sortRoadmapItems(scheduledItems, query.sort);
  unscheduledItems = sortRoadmapItems(unscheduledItems, query.sort);

  const page = applyCursorPage(scheduledItems, query.cursor, limit);

  return {
    window,
    filters: {
      teamId: query.teamId ?? null,
      departmentId: query.departmentId ?? null,
      leadId: query.leadId ?? null,
      projectId: query.projectId ?? null,
      status: query.status ?? null,
      health: query.health ?? null,
      includeUnscheduled: Boolean(query.includeUnscheduled),
      q: query.q ?? null,
    },
    items: page.items,
    unscheduled: {
      count: unscheduledItems.length,
      items: query.includeUnscheduled ? unscheduledItems : [],
    },
    meta: page.meta,
  };
}

export async function getProjectRoadmapDetail(
  workspaceId: string,
  role: WorkspaceRole,
  userId: string,
  projectId: string,
) {
  const project = await assertVisibleProject(workspaceId, role, userId, projectId);
  const window = getRoadmapWindow("QUARTER");
  const issueCounts = await loadIssueCounts(workspaceId, [projectId]);
  const milestoneMap = await loadMilestoneMap(workspaceId, [projectId]);
  const dependencyMaps = await loadDependencyMaps(workspaceId, [projectId]);
  const item = buildRoadmapItem(
    project,
    window.from,
    window.to,
    issueCounts,
    milestoneMap,
    dependencyMaps.upstream,
    dependencyMaps.downstream,
  );
  const milestones = milestoneMap.get(projectId) ?? [];
  const upstreamDependencies = dependencyMaps.upstream.get(projectId) ?? [];
  const downstreamDependencies = dependencyMaps.downstream.get(projectId) ?? [];

  return {
    project: item,
    milestones: milestones.map((row) => mapMilestone(row, project)),
    dependencies: {
      upstream: upstreamDependencies.map(mapDependency),
      downstream: downstreamDependencies.map(mapDependency),
    },
    summary: {
      blocked: item.dependencySummary.blocked,
      overdueMilestones: item.milestoneSummary.overdue,
      nextMilestone: item.milestoneSummary.next,
      health: item.health,
      forecast: item.forecast,
    },
  };
}

export async function updateProjectSchedule(
  workspaceId: string,
  role: WorkspaceRole,
  actorUserId: string,
  projectId: string,
  input: UpdateRoadmapScheduleInput,
) {
  const project = await assertProjectInWorkspace(workspaceId, projectId);
  assertRoadmapMutableProject(project);

  const nextStartDate = input.startDate !== undefined ? toDateOrNull(input.startDate) : project.startDate;
  const nextTargetDate = input.targetDate !== undefined ? toDateOrNull(input.targetDate) : project.targetDate;

  validateScheduleRange(nextStartDate ?? null, nextTargetDate ?? null);

  const activeDownstream = await (prisma as any).projectDependency.findMany({
    where: {
      workspaceId,
      blockingProjectId: projectId,
      status: "ACTIVE",
    },
    include: {
      blockedProject: {
        select: {
          id: true,
          name: true,
          startDate: true,
        },
      },
    },
  });

  const affectedDependencies = activeDownstream
    .filter((row: any) => nextTargetDate && row.blockedProject?.startDate && row.blockedProject.startDate < nextTargetDate)
    .map((row: any) => ({
      dependencyId: row.id,
      blockedProject: {
        id: row.blockedProject.id,
        name: row.blockedProject.name,
      },
    }));

  if (affectedDependencies.length > 0 && !input.force) {
    throw new AppError(409, ERROR_CODES.ROADMAP_SCHEDULE_CONFLICT, "Schedule change affects downstream dependencies", {
      projectId,
      affectedDependencies,
      requiresConfirmation: true,
      allowedForceOverride: isPrivileged(role),
    });
  }

  if (input.force && !isPrivileged(role)) {
    throw new AppError(403, ERROR_CODES.ROADMAP_FORBIDDEN, "Only owner or admin can force a conflicting schedule update");
  }

  const projectUpdateData: Record<string, Date | null> = {};
  if (input.startDate !== undefined) {
    projectUpdateData.startDate = nextStartDate ?? null;
  }
  if (input.targetDate !== undefined) {
    projectUpdateData.targetDate = nextTargetDate ?? null;
  }

  await prisma.project.update({
    where: { id: projectId },
    data: projectUpdateData,
  });

  await logActivity({
    workspaceId,
    actorId: actorUserId,
    type: "ROADMAP_SCHEDULE_UPDATED",
    targetType: "PROJECT",
    targetId: projectId,
    message: `Roadmap schedule updated for ${project.name}`,
    metadata: {
      projectId,
      projectName: project.name,
      oldStartDate: toIsoDate(project.startDate),
      newStartDate: toIsoDate(nextStartDate),
      oldTargetDate: toIsoDate(project.targetDate),
      newTargetDate: toIsoDate(nextTargetDate),
      reason: input.reason ?? null,
      force: input.force ?? false,
    },
  });

  if (project.leadId && project.leadId !== actorUserId) {
    await notifyProjectLead({
      workspaceId,
      actorUserId,
      recipientUserId: project.leadId,
      title: "Project target dates changed",
      message: `${project.name} schedule was updated`,
      projectId,
      projectName: project.name,
      metadata: {
        oldStartDate: toIsoDate(project.startDate),
        newStartDate: toIsoDate(nextStartDate),
        oldTargetDate: toIsoDate(project.targetDate),
        newTargetDate: toIsoDate(nextTargetDate),
      },
    });
  }

  const detail = await getProjectRoadmapDetail(workspaceId, role, actorUserId, projectId);
  await emitRoadmapEvent(workspaceId, "roadmap:project-updated", { project: detail.project }, projectId);
  return detail;
}

export async function createMilestone(
  workspaceId: string,
  actorUserId: string,
  projectId: string,
  input: CreateMilestoneInput,
) {
  const project = await assertProjectInWorkspace(workspaceId, projectId);
  assertRoadmapMutableProject(project);

  if (input.ownerId) {
    await assertWorkspaceMember(workspaceId, input.ownerId);
  }

  const created = await prisma.$transaction(async (tx) => {
    const maxSort = await (tx as any).projectMilestone.findFirst({
      where: { workspaceId, projectId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });

    return (tx as any).projectMilestone.create({
      data: {
        workspaceId,
        projectId,
        name: input.name,
        description: toNullableText(input.description),
        dueDate: new Date(input.dueDate),
        ownerId: input.ownerId ?? null,
        status: input.status ?? "PLANNED",
        sortOrder: (maxSort?.sortOrder ?? -1) + 1,
        createdById: actorUserId,
        ...(input.status === "COMPLETED"
          ? {
              completedAt: new Date(),
              completedById: actorUserId,
            }
          : {}),
      },
      include: {
        owner: { select: { id: true, name: true, email: true, avatar: true } },
        completedBy: { select: { id: true, name: true, email: true, avatar: true } },
        createdBy: { select: { id: true, name: true, email: true, avatar: true } },
      },
    });
  });

  await logActivity({
    workspaceId,
    actorId: actorUserId,
    type: "ROADMAP_MILESTONE_CREATED",
    targetType: "PROJECT",
    targetId: projectId,
    message: `Milestone ${created.name} created on ${project.name}`,
    metadata: {
      projectId,
      projectName: project.name,
      milestoneId: created.id,
      dueDate: toIsoDateTime(created.dueDate),
    },
  });

  const mapped = mapMilestone(created, project);
  await emitRoadmapEvent(workspaceId, "roadmap:milestone-created", { projectId, milestone: mapped }, projectId);
  return mapped;
}

export async function updateMilestone(
  workspaceId: string,
  actorUserId: string,
  projectId: string,
  milestoneId: string,
  input: UpdateMilestoneInput,
) {
  const project = await assertProjectInWorkspace(workspaceId, projectId);
  assertRoadmapMutableProject(project);

  const existing = await (prisma as any).projectMilestone.findFirst({
    where: { id: milestoneId, workspaceId, projectId },
    include: {
      owner: { select: { id: true, name: true, email: true, avatar: true } },
      completedBy: { select: { id: true, name: true, email: true, avatar: true } },
      createdBy: { select: { id: true, name: true, email: true, avatar: true } },
    },
  });

  if (!existing) {
    throw new AppError(404, ERROR_CODES.ROADMAP_MILESTONE_NOT_FOUND, "Roadmap milestone not found");
  }

  if (input.ownerId) {
    await assertWorkspaceMember(workspaceId, input.ownerId);
  }

  const completedTransition = input.status === "COMPLETED" && existing.status !== "COMPLETED";
  const reopenTransition = input.status !== undefined && input.status !== "COMPLETED" && existing.status === "COMPLETED";

  const updated = await (prisma as any).projectMilestone.update({
    where: { id: milestoneId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: toNullableText(input.description) } : {}),
      ...(input.dueDate !== undefined ? { dueDate: new Date(input.dueDate) } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(completedTransition
        ? { completedAt: new Date(), completedById: actorUserId }
        : reopenTransition
          ? { completedAt: null, completedById: null }
          : {}),
    },
    include: {
      owner: { select: { id: true, name: true, email: true, avatar: true } },
      completedBy: { select: { id: true, name: true, email: true, avatar: true } },
      createdBy: { select: { id: true, name: true, email: true, avatar: true } },
    },
  });

  await logActivity({
    workspaceId,
    actorId: actorUserId,
    type: completedTransition ? "ROADMAP_MILESTONE_COMPLETED" : "ROADMAP_MILESTONE_UPDATED",
    targetType: "PROJECT",
    targetId: projectId,
    message: completedTransition
      ? `Milestone ${updated.name} completed on ${project.name}`
      : `Milestone ${updated.name} updated on ${project.name}`,
    metadata: {
      projectId,
      projectName: project.name,
      milestoneId,
      dueDate: toIsoDateTime(updated.dueDate),
      status: updated.status,
    },
  });

  const mapped = mapMilestone(updated, project);
  await emitRoadmapEvent(workspaceId, "roadmap:milestone-updated", { projectId, milestone: mapped }, projectId);
  return mapped;
}

export async function reorderMilestones(
  workspaceId: string,
  actorUserId: string,
  projectId: string,
  input: ReorderMilestonesInput,
) {
  const project = await assertProjectInWorkspace(workspaceId, projectId);
  assertRoadmapMutableProject(project);

  const existing = await (prisma as any).projectMilestone.findMany({
    where: { workspaceId, projectId },
    select: { id: true },
  });

  if (existing.length !== input.orderedIds.length) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "orderedIds must include every milestone for the project");
  }

  const existingIds = new Set(existing.map((row: any) => row.id));
  for (const id of input.orderedIds) {
    if (!existingIds.has(id)) {
      throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "orderedIds contains milestone(s) outside the project");
    }
  }

  await prisma.$transaction(
    input.orderedIds.map((id, index) =>
      (prisma as any).projectMilestone.update({
        where: { id },
        data: { sortOrder: index },
      }),
    ),
  );

  await logActivity({
    workspaceId,
    actorId: actorUserId,
    type: "ROADMAP_MILESTONES_REORDERED",
    targetType: "PROJECT",
    targetId: projectId,
    message: `Milestones reordered on ${project.name}`,
    metadata: {
      projectId,
      projectName: project.name,
      orderedIds: input.orderedIds,
    },
  });

  const milestones = await (prisma as any).projectMilestone.findMany({
    where: { workspaceId, projectId },
    include: {
      owner: { select: { id: true, name: true, email: true, avatar: true } },
      completedBy: { select: { id: true, name: true, email: true, avatar: true } },
      createdBy: { select: { id: true, name: true, email: true, avatar: true } },
    },
    orderBy: [{ sortOrder: "asc" }, { dueDate: "asc" }],
  });

  const mapped = milestones.map((row: any) => mapMilestone(row, project));
  await emitRoadmapEvent(workspaceId, "roadmap:project-updated", { projectId, milestones: mapped }, projectId);
  return { items: mapped };
}

export async function deleteMilestone(
  workspaceId: string,
  actorUserId: string,
  projectId: string,
  milestoneId: string,
) {
  const project = await assertProjectInWorkspace(workspaceId, projectId);
  assertRoadmapMutableProject(project);

  const existing = await (prisma as any).projectMilestone.findFirst({
    where: { id: milestoneId, workspaceId, projectId },
    select: { id: true, name: true },
  });

  if (!existing) {
    throw new AppError(404, ERROR_CODES.ROADMAP_MILESTONE_NOT_FOUND, "Roadmap milestone not found");
  }

  await (prisma as any).projectMilestone.delete({ where: { id: milestoneId } });

  await logActivity({
    workspaceId,
    actorId: actorUserId,
    type: "ROADMAP_MILESTONE_DELETED",
    targetType: "PROJECT",
    targetId: projectId,
    message: `Milestone ${existing.name} deleted from ${project.name}`,
    metadata: {
      projectId,
      projectName: project.name,
      milestoneId,
    },
  });

  await emitRoadmapEvent(workspaceId, "roadmap:milestone-deleted", { projectId, milestoneId }, projectId);
}

export async function createDependency(
  workspaceId: string,
  actorUserId: string,
  input: CreateDependencyInput,
) {
  const blockingProject = await assertProjectInWorkspace(workspaceId, input.blockingProjectId);
  const blockedProject = await assertProjectInWorkspace(workspaceId, input.blockedProjectId);
  assertRoadmapMutableProject(blockingProject);
  assertRoadmapMutableProject(blockedProject);

  if (input.blockingProjectId === input.blockedProjectId) {
    throw new AppError(422, ERROR_CODES.ROADMAP_DEPENDENCY_INVALID_SCOPE, "A project cannot depend on itself");
  }

  const existing = await (prisma as any).projectDependency.findFirst({
    where: {
      workspaceId,
      blockingProjectId: input.blockingProjectId,
      blockedProjectId: input.blockedProjectId,
    },
    select: { id: true, status: true },
  });

  if (existing) {
    throw new AppError(409, ERROR_CODES.ROADMAP_DEPENDENCY_DUPLICATE, "Dependency already exists");
  }

  const activeDependencies = await (prisma as any).projectDependency.findMany({
    where: { workspaceId, status: "ACTIVE" },
    select: { blockingProjectId: true, blockedProjectId: true },
  });

  if (detectDependencyCycle(activeDependencies, input.blockingProjectId, input.blockedProjectId)) {
    throw new AppError(409, ERROR_CODES.ROADMAP_DEPENDENCY_CYCLE, "Dependency would create a cycle", {
      blockingProjectId: input.blockingProjectId,
      blockedProjectId: input.blockedProjectId,
      cycleProjectIds: [input.blockingProjectId, input.blockedProjectId],
    });
  }

  const created = await (prisma as any).projectDependency.create({
    data: {
      workspaceId,
      blockingProjectId: input.blockingProjectId,
      blockedProjectId: input.blockedProjectId,
      note: toNullableText(input.note),
      createdById: actorUserId,
    },
    include: {
      blockingProject: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          visibility: true,
          startDate: true,
          targetDate: true,
          team: { select: { id: true, name: true } },
          department: { select: { id: true, name: true, color: true } },
          lead: { select: { id: true, name: true, email: true, avatar: true } },
        },
      },
      blockedProject: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          visibility: true,
          startDate: true,
          targetDate: true,
          team: { select: { id: true, name: true } },
          department: { select: { id: true, name: true, color: true } },
          lead: { select: { id: true, name: true, email: true, avatar: true } },
        },
      },
      createdBy: { select: { id: true, name: true, email: true, avatar: true } },
      resolvedBy: { select: { id: true, name: true, email: true, avatar: true } },
      cancelledBy: { select: { id: true, name: true, email: true, avatar: true } },
    },
  });

  await logActivity({
    workspaceId,
    actorId: actorUserId,
    type: "ROADMAP_DEPENDENCY_CREATED",
    targetType: "PROJECT",
    targetId: blockedProject.id,
    message: `${blockingProject.name} now blocks ${blockedProject.name}`,
    metadata: {
      projectId: blockedProject.id,
      dependencyId: created.id,
      blockingProjectId: blockingProject.id,
      blockedProjectId: blockedProject.id,
    },
  });

  await notifyProjectLead({
    workspaceId,
    actorUserId,
    recipientUserId: blockedProject.leadId,
    title: "Project is now blocked",
    message: `${blockingProject.name} now blocks ${blockedProject.name}`,
    projectId: blockedProject.id,
    projectName: blockedProject.name,
    metadata: {
      dependencyId: created.id,
      blockingProjectId: blockingProject.id,
      blockedProjectId: blockedProject.id,
    },
  });

  const mapped = mapDependency(created);
  await emitRoadmapEvent(workspaceId, "roadmap:dependency-created", { dependency: mapped, projectId: blockedProject.id }, blockedProject.id);
  return mapped;
}

async function updateDependencyStatus(
  workspaceId: string,
  actorUserId: string,
  dependencyId: string,
  nextStatus: "RESOLVED" | "CANCELLED",
  input: ResolveDependencyInput | CancelDependencyInput,
) {
  const dependency = await assertDependencyInWorkspace(workspaceId, dependencyId);

  if (dependency.status === nextStatus) {
    return mapDependency(dependency);
  }

  if (dependency.status === "CANCELLED" && nextStatus === "RESOLVED") {
    throw new AppError(409, ERROR_CODES.ROADMAP_DEPENDENCY_CANCELLED, "Cancelled dependency cannot be resolved");
  }

  const updated = await (prisma as any).projectDependency.update({
    where: { id: dependencyId },
    data: {
      status: nextStatus,
      note: input.note !== undefined ? toNullableText(input.note) : dependency.note,
      ...(nextStatus === "RESOLVED"
        ? { resolvedAt: new Date(), resolvedById: actorUserId }
        : { cancelledAt: new Date(), cancelledById: actorUserId }),
    },
    include: {
      blockingProject: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          visibility: true,
          startDate: true,
          targetDate: true,
          team: { select: { id: true, name: true } },
          department: { select: { id: true, name: true, color: true } },
          lead: { select: { id: true, name: true, email: true, avatar: true } },
        },
      },
      blockedProject: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          visibility: true,
          startDate: true,
          targetDate: true,
          team: { select: { id: true, name: true } },
          department: { select: { id: true, name: true, color: true } },
          lead: { select: { id: true, name: true, email: true, avatar: true } },
        },
      },
      createdBy: { select: { id: true, name: true, email: true, avatar: true } },
      resolvedBy: { select: { id: true, name: true, email: true, avatar: true } },
      cancelledBy: { select: { id: true, name: true, email: true, avatar: true } },
    },
  });

  await logActivity({
    workspaceId,
    actorId: actorUserId,
    type: nextStatus === "RESOLVED" ? "ROADMAP_DEPENDENCY_RESOLVED" : "ROADMAP_DEPENDENCY_CANCELLED",
    targetType: "PROJECT",
    targetId: dependency.blockedProjectId,
    message: nextStatus === "RESOLVED"
      ? `Dependency resolved for ${dependency.blockedProject.name}`
      : `Dependency cancelled for ${dependency.blockedProject.name}`,
    metadata: {
      projectId: dependency.blockedProjectId,
      dependencyId,
      blockingProjectId: dependency.blockingProjectId,
      blockedProjectId: dependency.blockedProjectId,
      note: input.note ?? null,
    },
  });

  await notifyProjectLead({
    workspaceId,
    actorUserId,
    recipientUserId: dependency.blockedProject?.leadId,
    title: nextStatus === "RESOLVED" ? "Blocking dependency resolved" : "Blocking dependency cancelled",
    message: nextStatus === "RESOLVED"
      ? `${dependency.blockingProject.name} no longer blocks ${dependency.blockedProject.name}`
      : `${dependency.blockingProject.name} dependency was cancelled for ${dependency.blockedProject.name}`,
    projectId: dependency.blockedProject.id,
    projectName: dependency.blockedProject.name,
    metadata: {
      dependencyId,
      blockingProjectId: dependency.blockingProjectId,
      blockedProjectId: dependency.blockedProjectId,
      status: nextStatus,
    },
  });

  const mapped = mapDependency(updated);
  await emitRoadmapEvent(
    workspaceId,
    nextStatus === "RESOLVED" ? "roadmap:dependency-resolved" : "roadmap:dependency-cancelled",
    { dependency: mapped, projectId: dependency.blockedProjectId },
    dependency.blockedProjectId,
  );
  return mapped;
}

export async function resolveDependency(
  workspaceId: string,
  actorUserId: string,
  dependencyId: string,
  input: ResolveDependencyInput,
) {
  return updateDependencyStatus(workspaceId, actorUserId, dependencyId, "RESOLVED", input);
}

export async function cancelDependency(
  workspaceId: string,
  actorUserId: string,
  dependencyId: string,
  input: CancelDependencyInput,
) {
  return updateDependencyStatus(workspaceId, actorUserId, dependencyId, "CANCELLED", input);
}

export async function deleteDependency(
  workspaceId: string,
  actorUserId: string,
  dependencyId: string,
) {
  const dependency = await assertDependencyInWorkspace(workspaceId, dependencyId);

  await (prisma as any).projectDependency.delete({
    where: { id: dependencyId },
  });

  await logActivity({
    workspaceId,
    actorId: actorUserId,
    type: "ROADMAP_DEPENDENCY_DELETED",
    targetType: "PROJECT",
    targetId: dependency.blockedProjectId,
    message: `Dependency deleted between ${dependency.blockingProject.name} and ${dependency.blockedProject.name}`,
    metadata: {
      projectId: dependency.blockedProjectId,
      dependencyId,
      blockingProjectId: dependency.blockingProjectId,
      blockedProjectId: dependency.blockedProjectId,
    },
  });

  await emitRoadmapEvent(
    workspaceId,
    "roadmap:dependency-deleted",
    {
      dependencyId,
      projectId: dependency.blockedProjectId,
      blockingProjectId: dependency.blockingProjectId,
      blockedProjectId: dependency.blockedProjectId,
    },
    dependency.blockedProjectId,
  );
}
