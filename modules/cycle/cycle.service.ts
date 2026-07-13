import type { WorkspaceRole } from "../../app/generated/prisma/client.js";

import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { logActivity } from "../../shared/utils/activity.js";
import { AppError } from "../../shared/utils/api-error.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import { prisma } from "../../shared/utils/prisma.js";
import { createNotification } from "../notification/notification.service.js";
import { mapIssue, resolveIssueRouteId } from "../issue/issue.service.js";
import { dispatchIntegrationEvent } from "../integration/dispatcher.js";
import { triggerCycleBackgroundJobs } from "../ai/ai.background.js";
import { getSocketServer } from "../../socket/index.js";
import { createRealtimeEnvelope } from "../../socket/serializers.js";
import type {
  AssignIssueCycleInput,
  CarryOverInput,
  CreateCycleInput,
  ListCycleIssuesQuery,
  ListCyclesQuery,
  PlanCycleIssuesInput,
  UpdateCycleInput,
} from "./cycle.schemas.js";

const issueStatusFromDb: Record<string, "backlog" | "todo" | "in-progress" | "review" | "done"> = {
  BACKLOG: "backlog",
  TODO: "todo",
  IN_PROGRESS: "in-progress",
  REVIEW: "review",
  DONE: "done",
};

const issuePriorityFromDb: Record<string, "low" | "medium" | "high" | "urgent"> = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  URGENT: "urgent",
};

const issueTypeFromDb: Record<string, "task" | "bug" | "issue"> = {
  TASK: "task",
  BUG: "bug",
  ISSUE: "issue",
};

const issuePriorityToDb: Record<"low" | "medium" | "high" | "urgent", "LOW" | "MEDIUM" | "HIGH" | "URGENT"> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  urgent: "URGENT",
};

const issueTypeToDb: Record<"task" | "bug" | "issue", "TASK" | "BUG" | "ISSUE"> = {
  task: "TASK",
  bug: "BUG",
  issue: "ISSUE",
};

async function getWorkspaceStatusDefinitions(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { customStatuses: true },
  });

  return Array.isArray(workspace?.customStatuses) ? (workspace.customStatuses as any[]) : [];
}

function getFinalStatusKeys(statuses: any[]) {
  const configuredFinalKeys = statuses
    .filter((status) => status && status.isFinal === true && typeof status.key === "string")
    .map((status) => String(status.key));

  return new Set(configuredFinalKeys.length > 0 ? configuredFinalKeys : ["done"]);
}

function getStatusLabel(statusKey: string) {
  if (statusKey === "in-progress") return "In Progress";

  return statusKey
    .split("-")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

async function assertTeamInWorkspace(workspaceId: string, teamId: string) {
  const team = await prisma.team.findFirst({ where: { id: teamId, workspaceId }, select: { id: true, name: true } });
  if (!team) throw new AppError(404, ERROR_CODES.TEAM_NOT_FOUND, "Team not found");
  return team;
}

async function assertCycleInWorkspace(workspaceId: string, cycleId: string) {
  const cycle = await (prisma as any).cycle.findFirst({ where: { id: cycleId, workspaceId } });
  if (!cycle) throw new AppError(404, ERROR_CODES.CYCLE_NOT_FOUND, "Cycle not found");
  return cycle;
}

async function assertCycleManageAccess(workspaceId: string, userId: string, role: WorkspaceRole, teamId: string) {
  if (role === "OWNER" || role === "ADMIN") return;
  const teamMembership = await prisma.teamMembership.findUnique({ where: { userId_teamId: { userId, teamId } }, select: { userId: true } });
  if (!teamMembership) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, "You can manage cycles only for teams you belong to");
  }
  const workspaceMembership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true },
  });
  if (!workspaceMembership || workspaceMembership.role === "GUEST") {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, "Insufficient role");
  }
}

function validateCycleDates(startsAt: Date, endsAt: Date) {
  if (startsAt >= endsAt) {
    throw new AppError(422, ERROR_CODES.CYCLE_DATE_INVALID, "startsAt must be before endsAt");
  }
}

async function ensureNoOverlap(workspaceId: string, teamId: string, startsAt: Date, endsAt: Date, excludeCycleId?: string) {
  const overlap = await (prisma as any).cycle.findFirst({
    where: {
      workspaceId,
      teamId,
      ...(excludeCycleId ? { NOT: { id: excludeCycleId } } : {}),
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
    select: { id: true },
  });
  if (overlap) {
    throw new AppError(409, ERROR_CODES.CYCLE_OVERLAP_NOT_ALLOWED, "Cycle dates overlap with an existing cycle");
  }
}

async function ensureSingleCurrent(workspaceId: string, teamId: string, excludeCycleId?: string) {
  const existing = await (prisma as any).cycle.findFirst({
    where: {
      workspaceId,
      teamId,
      status: "CURRENT",
      ...(excludeCycleId ? { NOT: { id: excludeCycleId } } : {}),
    },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(409, ERROR_CODES.CYCLE_CURRENT_ALREADY_EXISTS, "A current cycle already exists for this team");
  }
}

async function emitCycleEvent(workspaceId: string, type: string, payload: Record<string, unknown>, dedupeKey?: string) {
  const io = getSocketServer();
  if (!io) return;
  const envelope = createRealtimeEnvelope({
    type,
    workspaceId,
    payload,
    ...(dedupeKey ? { dedupeKey } : {}),
  });
  io.to(`workspace:${workspaceId}`).emit(type, envelope);
}

function mapIssueSummary(item: any) {
  return {
    id: item.id,
    publicId: item.internalId,
    title: item.title,
    status: issueStatusFromDb[item.status] ?? "backlog",
    priority: issuePriorityFromDb[item.priority] ?? "medium",
    type: issueTypeFromDb[item.type] ?? "task",
    assignee: item.assignee ? { id: item.assignee.id, name: item.assignee.name, email: item.assignee.email, avatar: item.assignee.avatar } : null,
    project: item.project ? { id: item.project.id, name: item.project.name } : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

async function computeCycleStats(workspaceId: string, cycleId: string, startsAt: Date, endsAt: Date) {
  const [issues, workspaceStatuses] = await Promise.all([
    prisma.issue.findMany({
      where: { workspaceId, cycleId },
      select: {
        id: true,
        status: true,
        priority: true,
        type: true,
        projectId: true,
        project: { select: { name: true } },
      },
    }),
    getWorkspaceStatusDefinitions(workspaceId),
  ]);

  const finalStatusKeys = getFinalStatusKeys(workspaceStatuses);
  const countByStatus = new Map<string, number>();

  for (const issue of issues) {
    countByStatus.set(issue.status, (countByStatus.get(issue.status) ?? 0) + 1);
  }

  const totalIssues = issues.length;
  const completedIssues = issues.filter((issue) => finalStatusKeys.has(issue.status)).length;
  const inProgressIssues = countByStatus.get("in-progress") ?? 0;
  const todoIssues = countByStatus.get("todo") ?? 0;
  const backlogIssues = countByStatus.get("backlog") ?? 0;
  const reviewIssues = countByStatus.get("review") ?? 0;
  const unfinishedIssues = totalIssues - completedIssues;
  const progress = totalIssues === 0 ? 0 : Math.round((completedIssues / totalIssues) * 100);

  const now = new Date();
  const oneDay = 1000 * 60 * 60 * 24;
  const daysTotal = Math.max(1, Math.ceil((endsAt.getTime() - startsAt.getTime()) / oneDay));
  const daysElapsed = Math.max(0, Math.min(daysTotal, Math.ceil((now.getTime() - startsAt.getTime()) / oneDay)));
  const daysRemaining = Math.max(0, daysTotal - daysElapsed);
  const timeElapsedPercent = Math.round((daysElapsed / daysTotal) * 100);

  const byStatus = (workspaceStatuses.length > 0
    ? workspaceStatuses.map((status) => ({
        status: String(status.key),
        label: typeof status.label === "string" ? status.label : getStatusLabel(String(status.key)),
        count: countByStatus.get(String(status.key)) ?? 0,
      }))
    : [
        { status: "backlog", label: "Backlog", count: backlogIssues },
        { status: "todo", label: "Todo", count: todoIssues },
        { status: "in-progress", label: "In Progress", count: inProgressIssues },
        { status: "review", label: "Review", count: reviewIssues },
        { status: "done", label: "Done", count: completedIssues },
      ]);

  const byPriority = ["low", "medium", "high", "urgent"].map((priority) => ({
    priority,
    count: issues.filter((i) => issuePriorityFromDb[i.priority] === priority).length,
  }));

  const byType = ["task", "bug", "issue"].map((type) => ({
    type,
    count: issues.filter((i) => issueTypeFromDb[i.type] === type).length,
  }));

  const projectAgg = new Map<string, { projectId: string; projectName: string; count: number; completedCount: number }>();
  for (const issue of issues) {
    const key = issue.projectId;
    const current = projectAgg.get(key) ?? {
      projectId: issue.projectId,
      projectName: issue.project?.name ?? "Unknown",
      count: 0,
      completedCount: 0,
    };
    current.count += 1;
    if (finalStatusKeys.has(issue.status)) current.completedCount += 1;
    projectAgg.set(key, current);
  }

  return {
    stats: {
      totalIssues,
      completedIssues,
      inProgressIssues,
      todoIssues,
      backlogIssues,
      reviewIssues,
      unfinishedIssues,
      progress,
      daysTotal,
      daysElapsed,
      daysRemaining,
      timeElapsedPercent,
    },
    issueBreakdown: {
      byStatus,
      byPriority,
      byType,
      byProject: [...projectAgg.values()],
    },
  };
}

function mapCycleSummary(cycle: any, stats: any) {
  return {
    id: cycle.id,
    workspaceId: cycle.workspaceId,
    teamId: cycle.teamId,
    name: cycle.name,
    number: cycle.number,
    description: cycle.description,
    goal: cycle.goal,
    startsAt: cycle.startsAt,
    endsAt: cycle.endsAt,
    status: cycle.status,
    completedAt: cycle.completedAt,
    completedById: cycle.completedById,
    createdById: cycle.createdById,
    createdAt: cycle.createdAt,
    updatedAt: cycle.updatedAt,
    team: {
      id: cycle.team.id,
      name: cycle.team.name,
    },
    stats,
  };
}

function formatCycleDateRange(startsAt: Date, endsAt: Date) {
  const formatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  return `${formatter.format(startsAt)} - ${formatter.format(endsAt)}`;
}

export async function createCycle(workspaceId: string, userId: string, role: WorkspaceRole, input: CreateCycleInput) {
  await assertTeamInWorkspace(workspaceId, input.teamId);
  await assertCycleManageAccess(workspaceId, userId, role, input.teamId);

  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  validateCycleDates(startsAt, endsAt);
  await ensureNoOverlap(workspaceId, input.teamId, startsAt, endsAt);

  if ((input.status ?? "UPCOMING") === "CURRENT") {
    await ensureSingleCurrent(workspaceId, input.teamId);
  }

  const cycle = await prisma.$transaction(async (tx) => {
    const latest = await (tx as any).cycle.findFirst({
      where: { workspaceId, teamId: input.teamId },
      orderBy: { number: "desc" },
      select: { number: true },
    });

    return (tx as any).cycle.create({
      data: {
        workspaceId,
        teamId: input.teamId,
        number: (latest?.number ?? 0) + 1,
        name: input.name,
        description: input.description ?? null,
        goal: input.goal ?? null,
        startsAt,
        endsAt,
        status: input.status ?? "UPCOMING",
        createdById: userId,
      },
      include: {
        team: { select: { id: true, name: true } },
      },
    });
  });

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "CYCLE_CREATED",
    targetType: "CYCLE",
    targetId: cycle.id,
    message: `Cycle ${cycle.name} created`,
    metadata: { cycleId: cycle.id, teamId: cycle.teamId, cycleName: cycle.name },
  });

  await emitCycleEvent(workspaceId, "cycle:created", { cycleId: cycle.id, full: cycle }, `cycle-created:${cycle.id}`);

  const computed = await computeCycleStats(workspaceId, cycle.id, cycle.startsAt, cycle.endsAt);
  if (cycle.status === "CURRENT") {
    dispatchIntegrationEvent(workspaceId, {
      type: "cycle.started",
      payload: {
        cycleName: cycle.name,
        teamId: cycle.teamId,
        teamName: cycle.team.name,
        dateRange: formatCycleDateRange(cycle.startsAt, cycle.endsAt),
        totalIssues: computed.stats.totalIssues,
      },
    }).catch(() => {});
  }

  await triggerCycleBackgroundJobs({
    workspaceId,
    cycleId: cycle.id,
    triggeredByUserId: userId,
    reason: "created",
  });

  return mapCycleSummary(cycle, computed.stats);
}

export async function listCycles(workspaceId: string, query: ListCyclesQuery) {
  const limit = clampListLimit(query.limit, 30);
  const where: any = {
    workspaceId,
    ...(query.teamId ? { teamId: query.teamId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.from || query.to
      ? {
          startsAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    (prisma as any).cycle.count({ where }),
    (prisma as any).cycle.findMany({
      where,
      include: { team: { select: { id: true, name: true } } },
      orderBy: [{ startsAt: "desc" }, { createdAt: "desc" }],
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: limit + 1,
    }),
  ]);

  const page = slicePage(rows, limit);
  const summaries = await Promise.all(page.items.map(async (cycle: any) => {
    const computed = await computeCycleStats(workspaceId, cycle.id, cycle.startsAt, cycle.endsAt);
    return mapCycleSummary(cycle, computed.stats);
  }));

  return {
    items: summaries,
    meta: {
      total,
      cursor: page.hasMore ? (page.items[page.items.length - 1] as any)?.id ?? null : null,
      hasMore: page.hasMore,
    },
  };
}

export async function getCurrentCycle(workspaceId: string, teamId?: string) {
  const cycle = await (prisma as any).cycle.findFirst({
    where: { workspaceId, status: "CURRENT", ...(teamId ? { teamId } : {}) },
    include: { team: { select: { id: true, name: true } } },
    orderBy: { startsAt: "desc" },
  });
  if (!cycle) return null;

  const computed = await computeCycleStats(workspaceId, cycle.id, cycle.startsAt, cycle.endsAt);
  return mapCycleSummary(cycle, computed.stats);
}

export async function getCycleById(workspaceId: string, cycleId: string, userId: string, role: WorkspaceRole) {
  const cycle = await (prisma as any).cycle.findFirst({
    where: { id: cycleId, workspaceId },
    include: { team: { select: { id: true, name: true } } },
  });
  if (!cycle) throw new AppError(404, ERROR_CODES.CYCLE_NOT_FOUND, "Cycle not found");

  const [createdBy, completedBy, computed, issues] = await Promise.all([
    prisma.user.findUnique({ where: { id: cycle.createdById }, select: { id: true, name: true, email: true, avatar: true } }),
    cycle.completedById
      ? prisma.user.findUnique({ where: { id: cycle.completedById }, select: { id: true, name: true, email: true, avatar: true } })
      : Promise.resolve(null),
    computeCycleStats(workspaceId, cycle.id, cycle.startsAt, cycle.endsAt),
    prisma.issue.findMany({
      where: { workspaceId, cycleId: cycle.id },
      orderBy: [{ updatedAt: "desc" }],
      include: {
        assignee: { select: { id: true, name: true, email: true, avatar: true } },
        project: { select: { id: true, name: true } },
      },
    }),
  ]);

  const canManage = role === "OWNER" || role === "ADMIN" || (await prisma.teamMembership.findUnique({ where: { userId_teamId: { userId, teamId: cycle.teamId } }, select: { userId: true } }));

  return {
    ...mapCycleSummary(cycle, computed.stats),
    createdBy,
    completedBy,
    issueBreakdown: computed.issueBreakdown,
    rules: {
      carryOverRequired: computed.stats.unfinishedIssues > 0,
      unfinishedIssueCount: computed.stats.unfinishedIssues,
      canComplete: Boolean(canManage) && cycle.status !== "COMPLETED",
      canEditDates: Boolean(canManage) && cycle.status !== "COMPLETED",
      canCarryOver: Boolean(canManage) && cycle.status === "COMPLETED" && computed.stats.unfinishedIssues > 0,
    },
    issues: issues.map(mapIssueSummary),
  };
}

export async function updateCycle(workspaceId: string, cycleId: string, userId: string, role: WorkspaceRole, input: UpdateCycleInput) {
  const cycle = await assertCycleInWorkspace(workspaceId, cycleId);
  await assertCycleManageAccess(workspaceId, userId, role, cycle.teamId);

  if (cycle.status === "COMPLETED") {
    throw new AppError(409, ERROR_CODES.CYCLE_COMPLETED_IMMUTABLE, "Completed cycles are immutable");
  }

  const startsAt = input.startsAt ? new Date(input.startsAt) : cycle.startsAt;
  const endsAt = input.endsAt ? new Date(input.endsAt) : cycle.endsAt;
  validateCycleDates(startsAt, endsAt);
  await ensureNoOverlap(workspaceId, cycle.teamId, startsAt, endsAt, cycleId);

  if (input.status === "CURRENT") {
    await ensureSingleCurrent(workspaceId, cycle.teamId, cycleId);
  }

  const updated = await (prisma as any).cycle.update({
    where: { id: cycleId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
      ...(input.startsAt !== undefined ? { startsAt } : {}),
      ...(input.endsAt !== undefined ? { endsAt } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
    include: { team: { select: { id: true, name: true } } },
  });

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "CYCLE_UPDATED",
    targetType: "CYCLE",
    targetId: cycleId,
    message: `Cycle ${updated.name} updated`,
    metadata: { cycleId, teamId: updated.teamId, cycleName: updated.name },
  });

  if (input.startsAt !== undefined || input.endsAt !== undefined) {
    await logActivity({
      workspaceId,
      actorId: userId,
      type: "CYCLE_DATES_CHANGED",
      targetType: "CYCLE",
      targetId: cycleId,
      message: `Cycle ${updated.name} dates changed`,
      metadata: {
        cycleId,
        fromStartsAt: cycle.startsAt,
        toStartsAt: updated.startsAt,
        fromEndsAt: cycle.endsAt,
        toEndsAt: updated.endsAt,
      },
    });
  }

  if (input.goal !== undefined && input.goal !== cycle.goal) {
    await logActivity({
      workspaceId,
      actorId: userId,
      type: "CYCLE_GOAL_CHANGED",
      targetType: "CYCLE",
      targetId: cycleId,
      message: `Cycle ${updated.name} goal changed`,
      metadata: {
        cycleId,
        fromGoal: cycle.goal,
        toGoal: input.goal,
      },
    });
  }

  await emitCycleEvent(workspaceId, "cycle:updated", { cycleId, full: updated }, `cycle-updated:${cycleId}:${updated.updatedAt.toISOString()}`);
  const computed = await computeCycleStats(workspaceId, updated.id, updated.startsAt, updated.endsAt);
  if (cycle.status !== "CURRENT" && updated.status === "CURRENT") {
    dispatchIntegrationEvent(workspaceId, {
      type: "cycle.started",
      payload: {
        cycleName: updated.name,
        teamId: updated.teamId,
        teamName: updated.team.name,
        dateRange: formatCycleDateRange(updated.startsAt, updated.endsAt),
        totalIssues: computed.stats.totalIssues,
      },
    }).catch(() => {});
  }
  return mapCycleSummary(updated, computed.stats);
}

export async function deleteCycle(workspaceId: string, cycleId: string, userId: string, role: WorkspaceRole) {
  const cycle = await assertCycleInWorkspace(workspaceId, cycleId);
  await assertCycleManageAccess(workspaceId, userId, role, cycle.teamId);

  await prisma.$transaction(async (tx) => {
    await tx.issue.updateMany({ where: { workspaceId, cycleId }, data: { cycleId: null } });
    await (tx as any).cycle.delete({ where: { id: cycleId } });
  });

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "CYCLE_DELETED",
    targetType: "CYCLE",
    targetId: cycleId,
    message: `Cycle ${cycle.name} deleted`,
    metadata: { cycleId, teamId: cycle.teamId, cycleName: cycle.name },
  });

  await emitCycleEvent(workspaceId, "cycle:deleted", { cycleId }, `cycle-deleted:${cycleId}`);
}

export async function completeCycle(workspaceId: string, cycleId: string, userId: string, role: WorkspaceRole) {
  const cycle = await assertCycleInWorkspace(workspaceId, cycleId);
  await assertCycleManageAccess(workspaceId, userId, role, cycle.teamId);

  const updated = await (prisma as any).cycle.update({
    where: { id: cycleId },
    data: {
      status: "COMPLETED",
      completedAt: new Date(),
      completedById: userId,
    },
    include: { team: { select: { id: true, name: true } } },
  });

  const [cycleIssues, workspaceStatuses] = await Promise.all([
    prisma.issue.findMany({
      where: { workspaceId, cycleId },
      select: { status: true },
    }),
    getWorkspaceStatusDefinitions(workspaceId),
  ]);
  const finalStatusKeys = getFinalStatusKeys(workspaceStatuses);
  const unfinishedCount = cycleIssues.filter((issue) => !finalStatusKeys.has(issue.status)).length;

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "CYCLE_COMPLETED",
    targetType: "CYCLE",
    targetId: cycleId,
    message: `Cycle ${updated.name} completed`,
    metadata: { cycleId, teamId: updated.teamId, cycleName: updated.name, unfinishedIssueCount: unfinishedCount },
  });

  await emitCycleEvent(workspaceId, "cycle:completed", { cycleId, unfinishedIssueCount: unfinishedCount }, `cycle-completed:${cycleId}`);

  const computed = await computeCycleStats(workspaceId, updated.id, updated.startsAt, updated.endsAt);
  dispatchIntegrationEvent(workspaceId, {
    type: "cycle.completed",
    payload: {
      cycleName: updated.name,
      teamId: updated.teamId,
      teamName: updated.team.name,
      dateRange: formatCycleDateRange(updated.startsAt, updated.endsAt),
      totalIssues: computed.stats.totalIssues,
      completedIssues: computed.stats.completedIssues,
      carriedOver: unfinishedCount,
    },
  }).catch(() => {});
  return {
    ...mapCycleSummary(updated, computed.stats),
    rules: {
      carryOverRequired: unfinishedCount > 0,
      unfinishedIssueCount: unfinishedCount,
    },
  };
}

export async function reopenCycle(workspaceId: string, cycleId: string, userId: string, role: WorkspaceRole) {
  if (role !== "OWNER" && role !== "ADMIN") {
    throw new AppError(403, ERROR_CODES.CYCLE_REOPEN_FORBIDDEN, "Only owner/admin can reopen cycle");
  }

  const cycle = await assertCycleInWorkspace(workspaceId, cycleId);
  await ensureSingleCurrent(workspaceId, cycle.teamId, cycleId);

  const reopened = await (prisma as any).cycle.update({
    where: { id: cycleId },
    data: { status: "CURRENT", completedAt: null, completedById: null },
    include: { team: { select: { id: true, name: true } } },
  });

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "CYCLE_REOPENED",
    targetType: "CYCLE",
    targetId: cycleId,
    message: `Cycle ${reopened.name} reopened`,
    metadata: { cycleId, teamId: reopened.teamId, cycleName: reopened.name },
  });

  await emitCycleEvent(workspaceId, "cycle:reopened", { cycleId }, `cycle-reopened:${cycleId}`);

  const computed = await computeCycleStats(workspaceId, reopened.id, reopened.startsAt, reopened.endsAt);
  dispatchIntegrationEvent(workspaceId, {
    type: "cycle.started",
    payload: {
      cycleName: reopened.name,
      teamId: reopened.teamId,
      teamName: reopened.team.name,
      dateRange: formatCycleDateRange(reopened.startsAt, reopened.endsAt),
      totalIssues: computed.stats.totalIssues,
    },
  }).catch(() => {});
  return mapCycleSummary(reopened, computed.stats);
}

export async function carryOverCycle(workspaceId: string, cycleId: string, userId: string, role: WorkspaceRole, input: CarryOverInput) {
  const source = await assertCycleInWorkspace(workspaceId, cycleId);
  await assertCycleManageAccess(workspaceId, userId, role, source.teamId);

  if (source.status !== "COMPLETED") {
    throw new AppError(409, ERROR_CODES.CONFLICT, "Only completed cycles can be carried over");
  }

  const workspaceStatuses = await getWorkspaceStatusDefinitions(workspaceId);
  const finalStatusKeys = getFinalStatusKeys(workspaceStatuses);
  const cycleIssues = await prisma.issue.findMany({
    where: { workspaceId, cycleId },
    select: { id: true, assigneeId: true, title: true, internalId: true, status: true },
  });
  const unfinished = cycleIssues.filter((issue) => !finalStatusKeys.has(issue.status));

  let targetCycleId: string | null = null;
  if (input.mode === "nextCycle") {
    if (!input.targetCycleId) {
      throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "targetCycleId is required for nextCycle mode");
    }
    const target = await assertCycleInWorkspace(workspaceId, input.targetCycleId);
    if (target.teamId !== source.teamId) {
      throw new AppError(409, ERROR_CODES.CYCLE_TEAM_MISMATCH, "Target cycle team mismatch");
    }
    if (target.status === "COMPLETED") {
      throw new AppError(409, ERROR_CODES.CYCLE_ASSIGN_COMPLETED_FORBIDDEN, "Cannot move issues to completed cycle");
    }
    targetCycleId = target.id;
  }

  await prisma.issue.updateMany({
    where: { workspaceId, id: { in: unfinished.map((u) => u.id) } },
    data: { cycleId: targetCycleId },
  });

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "CYCLE_CARRY_OVER",
    targetType: "CYCLE",
    targetId: cycleId,
    message: `Cycle carry-over completed for ${source.name}`,
    metadata: {
      cycleId,
      targetCycleId,
      movedIssueCount: unfinished.length,
      mode: input.mode,
      teamId: source.teamId,
    },
  });

  await Promise.all(unfinished.filter((i) => i.assigneeId).map((issue) => createNotification({
    workspaceId,
    recipientUserId: issue.assigneeId!,
    actorUserId: userId,
    type: "UPDATE",
    category: "update",
    title: "Issue moved between cycles",
    message: `Issue ${issue.id} was moved during cycle carry-over`,
    target: { type: "issue", id: issue.id, publicId: issue.id, url: `/issues/${issue.id}` },
    metadata: {
      issueId: issue.id,
      field: "cycleId",
      from: cycleId,
      to: targetCycleId,
      workspaceId,
      entityId: issue.id,
      entityTitle: issue.title,
      url: `/issues/${issue.id}`,
    },
    eventId: `cycle-carry-over:${cycleId}:${issue.id}`,
  })));

  await emitCycleEvent(workspaceId, "cycle:issues-carried-over", {
    cycleId,
    targetCycleId,
    movedIssueCount: unfinished.length,
    mode: input.mode,
  }, `cycle-carry-over:${cycleId}:${targetCycleId ?? "backlog"}`);

  return {
    movedIssueCount: unfinished.length,
    targetCycleId,
    mode: input.mode,
  };
}

function getCycleIssueOrderBy(sort: ListCycleIssuesQuery["sort"]) {
  switch (sort) {
    case "priority:desc":
      return [{ priority: "desc" }, { updatedAt: "desc" }, { id: "desc" }] as any;
    case "dueDate:asc":
      return [{ dueDate: "asc" }, { id: "asc" }] as any;
    case "status:asc":
      return [{ status: "asc" }, { updatedAt: "desc" }, { id: "desc" }] as any;
    case "updatedAt:desc":
    default:
      return [{ updatedAt: "desc" }, { id: "desc" }] as any;
  }
}

export async function listCycleIssues(
  workspaceId: string,
  cycleId: string,
  _userId: string,
  _role: WorkspaceRole,
  query: ListCycleIssuesQuery,
) {
  await assertCycleInWorkspace(workspaceId, cycleId);

  const limit = clampListLimit(query.limit);
  const where: any = {
    workspaceId,
    cycleId,
    ...(query.q
      ? {
          OR: [
            { title: { contains: query.q, mode: "insensitive" } },
            { internalId: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.priority ? { priority: issuePriorityToDb[query.priority] } : {}),
    ...(query.type ? { type: issueTypeToDb[query.type] } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
  };

  const [total, records] = await Promise.all([
    prisma.issue.count({ where }),
    prisma.issue.findMany({
      where,
      orderBy: getCycleIssueOrderBy(query.sort),
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: limit + 1,
      include: {
        creator: { select: { id: true, name: true, email: true, avatar: true } },
        assignee: { select: { id: true, name: true, email: true, avatar: true } },
        project: { select: { id: true, name: true } },
        team: { select: { id: true, name: true } },
        department: { select: { id: true, name: true, color: true } },
        labels: { include: { label: { select: { id: true, name: true, color: true } } } },
        subtasks: { select: { id: true, completed: true, order: true, title: true } },
        attachments: { select: { id: true, key: true, fileName: true, contentType: true, size: true, kind: true, assetUrl: true, createdAt: true } },
      },
    } as any),
  ]);

  const page = slicePage(records as any[], limit);

  return {
    items: page.items.map((record: any) => mapIssue(record, true)),
    meta: {
      total,
      cursor: page.hasMore ? page.items[page.items.length - 1]?.id ?? null : null,
      hasMore: page.hasMore,
    },
  };
}

export async function planIssuesIntoCycle(
  workspaceId: string,
  cycleId: string,
  userId: string,
  role: WorkspaceRole,
  input: PlanCycleIssuesInput,
) {
  const uniqueIssueIds = [...new Set(input.issueIds)];
  const added: any[] = [];
  const skipped: Array<{ issueId: string; reason: string }> = [];

  for (const issueRouteId of uniqueIssueIds) {
    try {
      const resolvedId = await resolveIssueRouteId(workspaceId, issueRouteId);
      const existing = await prisma.issue.findFirst({
        where: { id: resolvedId, workspaceId },
        select: { id: true, cycleId: true },
      });

      if (!existing) {
        skipped.push({ issueId: issueRouteId, reason: "Issue not found" });
        continue;
      }

      if (existing.cycleId === cycleId) {
        skipped.push({ issueId: issueRouteId, reason: "Issue is already in this cycle" });
        continue;
      }

      const planned = await assignIssueToCycle(workspaceId, issueRouteId, userId, role, { cycleId });
      added.push(mapIssue(planned, true));
    } catch (error) {
      skipped.push({
        issueId: issueRouteId,
        reason: error instanceof AppError ? error.message : "Failed to plan issue",
      });
    }
  }

  return {
    added,
    skipped,
  };
}

export async function assignIssueToCycle(workspaceId: string, issueRouteId: string, userId: string, role: WorkspaceRole, input: AssignIssueCycleInput) {
  const issueId = await resolveIssueRouteId(workspaceId, issueRouteId);
  const [issue, cycle] = await Promise.all([
    prisma.issue.findFirst({ where: { id: issueId, workspaceId }, select: { id: true, teamId: true, assigneeId: true, title: true, internalId: true, creatorId: true } }),
    assertCycleInWorkspace(workspaceId, input.cycleId),
  ]);

  if (!issue) throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  await assertCycleManageAccess(workspaceId, userId, role, cycle.teamId);

  if (issue.teamId !== cycle.teamId) {
    throw new AppError(409, ERROR_CODES.CYCLE_TEAM_MISMATCH, "Issue team must match cycle team");
  }
  if (cycle.status === "COMPLETED") {
    throw new AppError(409, ERROR_CODES.CYCLE_ASSIGN_COMPLETED_FORBIDDEN, "Cannot assign issue to completed cycle");
  }

  await prisma.issue.update({ where: { id: issue.id }, data: { cycleId: cycle.id } });

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "ISSUE_ADDED_TO_CYCLE",
    targetType: "ISSUE",
    targetId: issue.id,
    message: `Issue ${issue.internalId ?? issue.id} assigned to cycle ${cycle.name}`,
    metadata: { issueId: issue.id, cycleId: cycle.id, teamId: cycle.teamId, entityId: issue.id },
  });

  const recipients = new Set<string>();
  if (issue.assigneeId) recipients.add(issue.assigneeId);
  recipients.add(issue.creatorId);

  await Promise.all([...recipients].map((recipientUserId) => createNotification({
    workspaceId,
    recipientUserId,
    actorUserId: userId,
    type: "UPDATE",
    category: "update",
    title: "Issue planned into cycle",
    message: `Issue ${issue.id} was planned into cycle ${cycle.name}`,
    target: { type: "issue", id: issue.id, publicId: issue.id, url: `/issues/${issue.id}` },
    metadata: {
      issueId: issue.id,
      field: "cycleId",
      from: null,
      to: cycle.id,
      workspaceId,
      entityId: issue.id,
      entityTitle: issue.title,
      url: `/issues/${issue.id}`,
    },
    eventId: `issue-cycle-assigned:${issue.id}:${cycle.id}:${recipientUserId}`,
  })));

  await emitCycleEvent(workspaceId, "cycle:issues-added", { cycleId: cycle.id, issueIds: [issue.id] }, `issue-cycle-assigned:${issue.id}:${cycle.id}`);

  const updatedIssue = await prisma.issue.findFirst({
    where: { id: issue.id, workspaceId },
    include: {
      creator: { select: { id: true, name: true, email: true, avatar: true } },
      assignee: { select: { id: true, name: true, email: true, avatar: true } },
      project: { select: { id: true, name: true } },
      team: { select: { id: true, name: true } },
      department: { select: { id: true, name: true, color: true } },
      subtasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] },
      labels: { include: { label: { select: { id: true, name: true, color: true } } } },
      attachments: { orderBy: [{ createdAt: "desc" }] },
      parent: { select: { id: true, title: true, status: true } },
      relationsFrom: { include: { related: { select: { id: true, title: true, status: true } } } },
      watchers: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              avatar: true,
              workspaceMemberships: { where: { workspaceId }, select: { role: true }, take: 1 },
            },
          },
        },
      },
    },
  });

  return updatedIssue;
}

export async function removeIssueFromSpecificCycle(
  workspaceId: string,
  cycleId: string,
  issueRouteId: string,
  userId: string,
  role: WorkspaceRole,
) {
  const issueId = await resolveIssueRouteId(workspaceId, issueRouteId);
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: { id: true, cycleId: true },
  });

  if (!issue) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }

  if (issue.cycleId !== cycleId) {
    throw new AppError(409, ERROR_CODES.CONFLICT, "Issue does not belong to this cycle");
  }

  await removeIssueFromCycle(workspaceId, issueRouteId, userId, role);

  return {
    issueId,
    cycleId,
    removed: true,
  };
}

export async function removeIssueFromCycle(workspaceId: string, issueRouteId: string, userId: string, role: WorkspaceRole) {
  const issueId = await resolveIssueRouteId(workspaceId, issueRouteId);
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: { id: true, cycleId: true, assigneeId: true, creatorId: true, title: true, internalId: true },
  });
  if (!issue) throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  if (!issue.cycleId) return;

  const cycle = await assertCycleInWorkspace(workspaceId, issue.cycleId);
  await assertCycleManageAccess(workspaceId, userId, role, cycle.teamId);

  await prisma.issue.update({ where: { id: issue.id }, data: { cycleId: null } });

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "ISSUE_REMOVED_FROM_CYCLE",
    targetType: "ISSUE",
    targetId: issue.id,
    message: `Issue ${issue.internalId ?? issue.id} removed from cycle ${cycle.name}`,
    metadata: { issueId: issue.id, cycleId: cycle.id, teamId: cycle.teamId, entityId: issue.id },
  });

  const recipients = new Set<string>();
  if (issue.assigneeId) recipients.add(issue.assigneeId);
  recipients.add(issue.creatorId);
  await Promise.all([...recipients].map((recipientUserId) => createNotification({
    workspaceId,
    recipientUserId,
    actorUserId: userId,
    type: "UPDATE",
    category: "update",
    title: "Issue removed from cycle",
    message: `Issue ${issue.id} was removed from cycle ${cycle.name}`,
    target: { type: "issue", id: issue.id, publicId: issue.id, url: `/issues/${issue.id}` },
    metadata: {
      issueId: issue.id,
      field: "cycleId",
      from: cycle.id,
      to: null,
      workspaceId,
      entityId: issue.id,
      entityTitle: issue.title,
      url: `/issues/${issue.id}`,
    },
    eventId: `issue-cycle-removed:${issue.id}:${recipientUserId}`,
  })));

  await emitCycleEvent(workspaceId, "cycle:issue-removed", { cycleId: cycle.id, issueId: issue.id }, `issue-cycle-removed:${issue.id}`);
}
