import type { WorkspaceRole } from "../../app/generated/prisma/client.js";

import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import type { AnalyticsQuery, ExportQuery } from "./analytics.schemas.js";
import {
  avgResolutionTime,
  buildAnalyticsCsv,
  buildAnalyticsPdf,
  buildDaySeries,
  calculateTrend,
  formatDayKey,
  msToReadableUnit,
  resolveDateRange,
  resolveFixedDateRange,
} from "./analytics.utils.js";
import { getStatusRecord, normalizeWorkspaceStatuses } from "../../shared/workflow/workflow-automation.js";

const ISSUE_SELECT = {
  id: true,
  internalId: true,
  title: true,
  status: true,
  priority: true,
  type: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  dueDate: true,
  assigneeId: true,
  creatorId: true,
  projectId: true,
  teamId: true,
  cycleId: true,
  assignee: { select: { id: true, name: true, avatar: true } },
  project: { select: { id: true, name: true, startDate: true, targetDate: true, leadId: true, visibility: true } },
  team: { select: { id: true, name: true, leadId: true } },
} as const;

type IssueRecord = any;

function isPrivileged(role: WorkspaceRole) {
  return role === "OWNER" || role === "ADMIN";
}

// Whether an issue counts as "done" is workspace/project-specific — workflows use custom status
// keys (e.g. "done", "shipped", "closed"), not a fixed "DONE" enum. `completedAt` is already
// maintained everywhere else in the app (see isStatusFinal / issue.service.ts) as the single
// source of truth for "this issue is currently sitting in a final/isFinal status" — set the
// moment an issue transitions into a final status, cleared the moment it transitions out — so
// analytics uses it directly instead of re-deriving completion from a hardcoded status string.
function isDone(issue: IssueRecord) {
  return issue.completedAt != null;
}

function isOverdue(issue: IssueRecord, now: Date) {
  return !!issue.dueDate && !isDone(issue) && issue.dueDate < now;
}

function getCompletionRate(done: number, total: number) {
  if (total === 0) return 0;
  return Math.round((done / total) * 100);
}

function getEfficiency(done: number, open: number) {
  if (done + open === 0) return 0;
  return Math.round((done / (done + open)) * 100);
}

function metricWithTrend(value: number, previous: number) {
  const trend = calculateTrend(value, previous);
  return {
    value,
    trend: trend.value,
    direction: trend.direction,
  };
}

type AnalyticsScope = "workspace" | "project" | "team" | "member" | "cycle";

function buildAnalyticsProvenance(
  scope: AnalyticsScope,
  query: AnalyticsQuery,
  range: { from: Date; to: Date; previousFrom: Date; previousTo: Date },
  input?: { scopeId?: string; partialDataNotes?: string[] },
) {
  const partialDataNotes = [...new Set((input?.partialDataNotes ?? []).filter(Boolean))];
  return {
    scope,
    ...(input?.scopeId ? { scopeId: input.scopeId } : {}),
    range: {
      period: query.period,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      previousFrom: range.previousFrom.toISOString(),
      previousTo: range.previousTo.toISOString(),
    },
    asOf: new Date().toISOString(),
    partialDataNotes,
  };
}

function withAnalyticsProvenance<T extends Record<string, unknown>>(
  payload: T,
  scope: AnalyticsScope,
  query: AnalyticsQuery,
  range: { from: Date; to: Date; previousFrom: Date; previousTo: Date },
  input?: { scopeId?: string; partialDataNotes?: string[] },
) {
  return {
    ...payload,
    provenance: buildAnalyticsProvenance(scope, query, range, input),
  };
}

export function formatAnalyticsReport(scope: AnalyticsScope, payload: Record<string, any>) {
  const provenance = payload.provenance as
    | {
        range?: { from?: string; to?: string };
        partialDataNotes?: string[];
      }
    | undefined;
  const rangeText = provenance?.range?.from && provenance?.range?.to
    ? `${provenance.range.from.slice(0, 10)} to ${provenance.range.to.slice(0, 10)}`
    : "current range";
  const notes = provenance?.partialDataNotes?.length
    ? ` Notes: ${provenance.partialDataNotes.join(" ")}`
    : "";

  if (scope === "workspace") {
    const summary = payload.summary ?? {};
    return [
      `Workspace report for ${rangeText}.`,
      `Completed ${summary.tasksCompleted?.value ?? 0} issues.`,
      `Open vs closed: ${summary.openVsClosed?.open ?? 0} open, ${summary.openVsClosed?.closed ?? 0} closed.`,
      `Overdue issues: ${summary.overdueIssues?.value ?? 0}.`,
      notes,
    ].filter(Boolean).join(" ");
  }

  if (scope === "project") {
    const project = payload.project ?? {};
    const summary = payload.summary ?? {};
    return [
      `Project report for ${project.name ?? "project"} over ${rangeText}.`,
      `Progress is ${summary.progress ?? 0}% with ${summary.completedIssues ?? 0} completed and ${summary.openIssues ?? 0} open issues.`,
      `Timeline health is ${summary.timelineHealth ?? "unknown"}.`,
      notes,
    ].filter(Boolean).join(" ");
  }

  if (scope === "team") {
    const team = payload.team ?? {};
    const summary = payload.summary ?? {};
    return [
      `Team report for ${team.name ?? "team"} over ${rangeText}.`,
      `Velocity is ${summary.velocity?.value ?? 0} completed issues with trend ${summary.velocity?.direction ?? "flat"}.`,
      `Average resolution time is ${summary.avgResolutionTime?.value ?? 0} ${summary.avgResolutionTime?.unit ?? "hours"}.`,
      notes,
    ].filter(Boolean).join(" ");
  }

  if (scope === "member") {
    const member = payload.member ?? {};
    const summary = payload.summary ?? {};
    return [
      `Member report for ${member.name ?? "member"} over ${rangeText}.`,
      `Assigned ${summary.assigned ?? 0}, completed ${summary.completed ?? 0}, overdue ${summary.overdue ?? 0}.`,
      `Completion rate is ${summary.completionRate?.value ?? 0}% with trend ${summary.completionRate?.direction ?? "flat"}.`,
      notes,
    ].filter(Boolean).join(" ");
  }

  const cycle = payload.cycle ?? {};
  const summary = payload.summary ?? {};
  return [
    `Cycle report for ${cycle.name ?? "cycle"} over ${rangeText}.`,
    `Progress is ${summary.progress ?? 0}% with ${summary.completedIssues ?? 0} completed and ${summary.openIssues ?? 0} open issues.`,
    `Average resolution time is ${summary.avgResolutionTime?.value ?? 0} ${summary.avgResolutionTime?.unit ?? "hours"}.`,
    notes,
  ].filter(Boolean).join(" ");
}

async function assertProjectAnalyticsAccess(workspaceId: string, role: WorkspaceRole, userId: string, projectId: string) {
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      workspaceId,
      ...(isPrivileged(role) ? {} : { leadId: userId }),
    },
    select: { id: true, name: true, startDate: true, targetDate: true, leadId: true, teamId: true },
  });

  if (project) return project;

  const existing = await prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { id: true } });
  if (!existing) {
    throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
  }

  throw new AppError(403, ERROR_CODES.FORBIDDEN, "You can view analytics only for projects you lead");
}

async function assertTeamAnalyticsAccess(workspaceId: string, role: WorkspaceRole, userId: string, teamId: string) {
  const team = await prisma.team.findFirst({
    where: { id: teamId, workspaceId },
    select: { id: true, name: true, leadId: true },
  });

  if (!team) {
    throw new AppError(404, ERROR_CODES.TEAM_NOT_FOUND, "Team not found");
  }

  if (isPrivileged(role)) return team;

  if (team.leadId !== userId) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, "You can view analytics only for teams you lead");
  }

  return team;
}

async function assertCycleAnalyticsAccess(workspaceId: string, role: WorkspaceRole, userId: string, cycleId: string) {
  const cycle = await (prisma as any).cycle.findFirst({
    where: { id: cycleId, workspaceId },
    select: {
      id: true,
      name: true,
      teamId: true,
      startsAt: true,
      endsAt: true,
      status: true,
      completedAt: true,
      team: { select: { leadId: true } },
    },
  });

  if (!cycle) {
    throw new AppError(404, ERROR_CODES.CYCLE_NOT_FOUND, "Cycle not found");
  }

  if (isPrivileged(role)) return cycle;

  if (cycle.team?.leadId !== userId) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, "You can view analytics only for cycles of teams you lead");
  }

  return cycle;
}

async function assertMemberAnalyticsAccess(workspaceId: string, role: WorkspaceRole, userId: string, memberId: string) {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId: memberId, workspaceId } },
    select: {
      userId: true,
      role: true,
      user: { select: { id: true, name: true, email: true, avatar: true } },
    },
  });

  if (!membership) {
    throw new AppError(404, ERROR_CODES.MEMBER_NOT_FOUND, "Member not found");
  }

  if (!isPrivileged(role) && userId !== memberId) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, "Members can view only their own analytics");
  }

  return membership.user;
}

async function loadWorkspaceIssues(workspaceId: string) {
  return prisma.issue.findMany({
    where: { workspaceId },
    select: ISSUE_SELECT,
  });
}

function filterByDate<T extends { createdAt: Date }>(items: T[], from: Date, to: Date) {
  return items.filter((item) => item.createdAt >= from && item.createdAt <= to);
}

function filterCompletedByDate(issues: IssueRecord[], from: Date, to: Date) {
  return issues.filter((issue) => issue.completedAt && issue.completedAt >= from && issue.completedAt <= to);
}

function buildVelocitySeries(issues: IssueRecord[], from: Date, to: Date) {
  const createdMap = new Map<string, number>();
  const completedMap = new Map<string, number>();

  for (const issue of issues) {
    const createdKey = formatDayKey(issue.createdAt);
    createdMap.set(createdKey, (createdMap.get(createdKey) ?? 0) + 1);

    if (issue.completedAt) {
      const completedKey = formatDayKey(issue.completedAt);
      completedMap.set(completedKey, (completedMap.get(completedKey) ?? 0) + 1);
    }
  }

  return buildDaySeries(from, to).map((day) => {
    const key = formatDayKey(day);
    return {
      date: key,
      created: createdMap.get(key) ?? 0,
      completed: completedMap.get(key) ?? 0,
    };
  });
}

function groupCount<T>(items: T[], keyFn: (item: T) => string, label: string) {
  const map = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  return [...map.entries()].map(([key, count]) => ({ [label]: key, count }));
}

function getCurrentAndPreviousMetrics(issues: IssueRecord[], from: Date, to: Date, previousFrom: Date, previousTo: Date) {
  const currentCreated = filterByDate(issues, from, to);
  const previousCreated = filterByDate(issues, previousFrom, previousTo);
  const currentCompleted = filterCompletedByDate(issues, from, to);
  const previousCompleted = filterCompletedByDate(issues, previousFrom, previousTo);
  return { currentCreated, previousCreated, currentCompleted, previousCompleted };
}

function memberWorkloadRows(issues: IssueRecord[], users: Array<{ id: string; name: string; avatar: string | null }>) {
  return users.map((user) => {
    const assigned = issues.filter((issue) => issue.assigneeId === user.id);
    const completed = assigned.filter(isDone).length;
    const open = assigned.filter((issue) => !isDone(issue)).length;
    const overdue = assigned.filter((issue) => isOverdue(issue, new Date())).length;
    return {
      userId: user.id,
      name: user.name,
      avatar: user.avatar,
      assigned: assigned.length,
      completed,
      open,
      overdue,
      completionRate: getCompletionRate(completed, assigned.length),
      avgResolutionHours: Number((avgResolutionTime(assigned) / (60 * 60 * 1000)).toFixed(1)),
    };
  });
}

function workloadPressureScore(row: { assigned: number; open: number; overdue: number }) {
  return (row.overdue * 6) + (row.open * 2) + row.assigned;
}

export async function getWorkspaceAnalytics(workspaceId: string, query: AnalyticsQuery) {
  const range = resolveDateRange(query.period, query.from, query.to);
  const now = new Date();
  const [issues, teams, memberships, workspace] = await Promise.all([
    loadWorkspaceIssues(workspaceId),
    prisma.team.findMany({
      where: { workspaceId },
      select: { id: true, name: true, leadId: true, _count: { select: { memberships: true } } },
    }),
    prisma.workspaceMembership.findMany({
      where: { workspaceId, role: { not: "GUEST" } },
      select: { userId: true, user: { select: { id: true, name: true, avatar: true } } },
    }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { customStatuses: true } }),
  ]);
  const workspaceStatuses = normalizeWorkspaceStatuses(workspace?.customStatuses as any[] | null);
  const isBottleneckStatus = (statusKey: string) => {
    const category = getStatusRecord(workspaceStatuses, statusKey)?.category;
    return category === "active" || category === "review";
  };

  const { currentCreated, currentCompleted, previousCompleted } = getCurrentAndPreviousMetrics(
    issues,
    range.from,
    range.to,
    range.previousFrom,
    range.previousTo,
  );

  const currentCompletedAvg = avgResolutionTime(currentCompleted);
  const previousCompletedAvg = avgResolutionTime(previousCompleted);
  const activeProjectsCurrent = new Set(currentCreated.map((issue) => issue.projectId)).size;
  const activeProjectsPrevious = new Set(filterByDate(issues, range.previousFrom, range.previousTo).map((issue) => issue.projectId)).size;
  const overdueCurrent = issues.filter((issue) => isOverdue(issue, now)).length;
  const overduePrevious = issues.filter((issue) => issue.dueDate && issue.dueDate < range.previousTo && !isDone(issue)).length;
  const membersWithAssignments = new Set(issues.filter((issue) => issue.assigneeId && !isDone(issue)).map((issue) => issue.assigneeId));
  const workloadPercent = memberships.length === 0 ? 0 : Math.round((membersWithAssignments.size / memberships.length) * 100);

  const openCount = issues.filter((issue) => !isDone(issue)).length;
  const closedCount = issues.filter(isDone).length;

  const teamPerformance = teams.map((team) => {
    const teamIssues = issues.filter((issue) => issue.teamId === team.id);
    const completed = teamIssues.filter(isDone).length;
    const open = teamIssues.filter((issue) => !isDone(issue)).length;
    return {
      teamId: team.id,
      teamName: team.name,
      memberCount: team._count.memberships,
      completed,
      efficiency: getEfficiency(completed, open),
    };
  }).sort((a, b) => b.completed - a.completed);

  const workspaceMemberWorkload = memberWorkloadRows(
    issues,
    memberships.map((membership) => membership.user),
  );
  const topContributors = [...workspaceMemberWorkload].sort((a, b) => b.completed - a.completed).slice(0, 10);
  const memberWorkload = [...workspaceMemberWorkload]
    .sort((a, b) => workloadPressureScore(b) - workloadPressureScore(a))
    .slice(0, 10);

  const bottlenecks = issues
    .filter((issue) => isBottleneckStatus(issue.status))
    .map((issue) => ({
      issueId: issue.id,
      publicId: issue.internalId,
      title: issue.title,
      status: issue.status,
      stuckDays: Math.max(0, Math.floor((now.getTime() - issue.updatedAt.getTime()) / (24 * 60 * 60 * 1000))),
      assignee: issue.assignee ? { id: issue.assignee.id, name: issue.assignee.name } : null,
    }))
    .sort((a, b) => b.stuckDays - a.stuckDays)
    .slice(0, 10);

  const resolutionCurrent = msToReadableUnit(currentCompletedAvg);
  const resolutionTrend = calculateTrend(currentCompletedAvg, previousCompletedAvg);

  return withAnalyticsProvenance({
    period: {
      period: query.period,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      previousFrom: range.previousFrom.toISOString(),
      previousTo: range.previousTo.toISOString(),
    },
    summary: {
      tasksCompleted: metricWithTrend(currentCompleted.length, previousCompleted.length),
      avgResolutionTime: {
        ...resolutionCurrent,
        trend: resolutionTrend.value,
        direction: resolutionTrend.direction,
      },
      activeProjects: metricWithTrend(activeProjectsCurrent, activeProjectsPrevious),
      teamWorkload: metricWithTrend(workloadPercent, workloadPercent),
      overdueIssues: metricWithTrend(overdueCurrent, overduePrevious),
      progress: getCompletionRate(closedCount, closedCount + openCount),
      totalIssues: closedCount + openCount,
      openVsClosed: {
        open: openCount,
        closed: closedCount,
      },
    },
    charts: {
      completionVelocity: buildVelocitySeries(currentCreated, range.from, range.to),
      issuesByStatus: groupCount(issues, (issue) => issue.status, "status"),
      issuesByPriority: groupCount(issues, (issue) => issue.priority, "priority"),
      issuesByType: groupCount(issues, (issue) => issue.type, "type"),
    },
    tables: {
      memberWorkload,
      teamPerformance,
      topContributors,
      bottlenecks,
    },
  }, "workspace", query, range, {
    partialDataNotes: [
      "Workspace analytics exclude guest memberships from workload percentages.",
      "Contributor and bottleneck tables are capped to the top 10 rows.",
    ],
  });
}

export async function getProjectAnalytics(workspaceId: string, role: WorkspaceRole, userId: string, projectId: string, query: AnalyticsQuery) {
  const range = resolveDateRange(query.period, query.from, query.to);
  const project = await assertProjectAnalyticsAccess(workspaceId, role, userId, projectId);
  const [issues, members] = await Promise.all([
    prisma.issue.findMany({ where: { workspaceId, projectId }, select: ISSUE_SELECT }),
    prisma.projectMembership.findMany({
      where: { projectId },
      select: { user: { select: { id: true, name: true, avatar: true } } },
    }),
  ]);

  const total = issues.length;
  const done = issues.filter(isDone).length;
  const firstIssueDate = issues.length > 0
    ? issues.reduce((min: Date, issue: IssueRecord) => (issue.createdAt < min ? issue.createdAt : min), issues[0]!.createdAt)
    : null;
  const fromDate = project.startDate ?? firstIssueDate ?? range.from;
  const scopeChanges = issues.filter((issue) => issue.createdAt.getTime() > fromDate.getTime()).length;
  const burndown = buildDaySeries(range.from, range.to).map((day) => {
    const remaining = issues.filter((issue) => issue.createdAt <= day && (!(issue.completedAt as Date | null) || (issue.completedAt as Date).getTime() > day.getTime())).length;
    return { date: formatDayKey(day), remaining };
  });

  const memberRows = memberWorkloadRows(issues, members.map((row) => row.user));
  const completedPerDay = buildVelocitySeries(issues, range.from, range.to);
  const completedInRange = filterCompletedByDate(issues, range.from, range.to).length;
  const periodDays = Math.max(1, buildDaySeries(range.from, range.to).length);
  const dailyCompletion = completedInRange / periodDays;
  const remainingIssues = total - done;
  const daysToFinish = dailyCompletion > 0 ? remainingIssues / dailyCompletion : Number.POSITIVE_INFINITY;
  const timelineHealth = !project.targetDate
    ? "unknown"
    : range.to.getTime() + (daysToFinish * 24 * 60 * 60 * 1000) <= project.targetDate.getTime()
      ? "on-track"
      : dailyCompletion > 0
        ? "at-risk"
        : "behind";

  return withAnalyticsProvenance({
    project: {
      id: project.id,
      name: project.name,
      startDate: project.startDate,
      targetDate: project.targetDate,
      teamId: project.teamId,
    },
    summary: {
      progress: getCompletionRate(done, total),
      totalIssues: total,
      completedIssues: done,
      openIssues: total - done,
      scopeChanges,
      timelineHealth,
    },
    charts: {
      burndown,
      completionVelocity: completedPerDay,
      statusBreakdown: groupCount(issues, (issue) => issue.status, "status"),
      priorityBreakdown: groupCount(issues, (issue) => issue.priority, "priority"),
    },
    tables: {
      memberWorkload: memberRows,
    },
  }, "project", query, range, {
    scopeId: projectId,
    partialDataNotes: [
      "Burndown and scope-change calculations use issues currently attached to this project.",
    ],
  });
}

export async function getTeamAnalytics(workspaceId: string, role: WorkspaceRole, userId: string, teamId: string, query: AnalyticsQuery) {
  const range = resolveDateRange(query.period, query.from, query.to);
  const team = await assertTeamAnalyticsAccess(workspaceId, role, userId, teamId);
  const [issues, memberships, cycles] = await Promise.all([
    prisma.issue.findMany({ where: { workspaceId, teamId }, select: ISSUE_SELECT }),
    prisma.teamMembership.findMany({ where: { teamId }, select: { user: { select: { id: true, name: true, avatar: true } } } }),
    (prisma as any).cycle.findMany({ where: { workspaceId, teamId }, select: { id: true, name: true, number: true, startsAt: true, endsAt: true } }),
  ]);

  const currentCompleted = filterCompletedByDate(issues, range.from, range.to).length;
  const previousCompleted = filterCompletedByDate(issues, range.previousFrom, range.previousTo).length;
  const memberPerformance = memberWorkloadRows(issues, memberships.map((membership: any) => membership.user));
  const overdueByMember = memberPerformance.map((row) => ({ userId: row.userId, name: row.name, overdue: row.overdue }));
  const cycleComparison = cycles.map((cycle: any) => {
    const cycleIssues = issues.filter((issue) => issue.cycleId === cycle.id);
    const completed = cycleIssues.filter(isDone).length;
    return {
      cycleId: cycle.id,
      cycleName: cycle.name,
      cycleNumber: cycle.number,
      completed,
      total: cycleIssues.length,
      completionRate: getCompletionRate(completed, cycleIssues.length),
    };
  }).sort((a: { cycleNumber: number }, b: { cycleNumber: number }) => b.cycleNumber - a.cycleNumber).slice(0, 6);

  return withAnalyticsProvenance({
    team: {
      id: team.id,
      name: team.name,
    },
    summary: {
      velocity: metricWithTrend(currentCompleted, previousCompleted),
      avgResolutionTime: msToReadableUnit(avgResolutionTime(issues.filter((issue) => issue.assigneeId !== null))),
      progress: getCompletionRate(issues.filter(isDone).length, issues.length),
      totalIssues: issues.length,
      completedIssues: issues.filter(isDone).length,
    },
    charts: {
      completionVelocity: buildVelocitySeries(issues.filter((issue) => issue.createdAt >= range.from && issue.createdAt <= range.to), range.from, range.to),
      workloadDistribution: memberPerformance.map((row) => ({ userId: row.userId, name: row.name, assigned: row.assigned, open: row.open })),
      completionRatePerMember: memberPerformance.map((row) => ({ userId: row.userId, name: row.name, completionRate: row.completionRate })),
      overduePerMember: overdueByMember,
      cycleComparison,
    },
    tables: {
      memberPerformance,
    },
  }, "team", query, range, {
    scopeId: teamId,
    partialDataNotes: [
      "Cycle comparison is limited to the 6 most recent cycles.",
    ],
  });
}

export async function getMemberAnalytics(workspaceId: string, role: WorkspaceRole, userId: string, memberId: string, query: AnalyticsQuery) {
  const range = resolveDateRange(query.period, query.from, query.to);
  const member = await assertMemberAnalyticsAccess(workspaceId, role, userId, memberId);
  const [assignedIssues, teamMemberships, activities, workspace] = await Promise.all([
    prisma.issue.findMany({ where: { workspaceId, assigneeId: memberId }, select: ISSUE_SELECT }),
    prisma.teamMembership.findMany({ where: { userId: memberId, team: { workspaceId } }, select: { team: { select: { id: true, name: true } } } }),
    prisma.activity.findMany({
      where: { workspaceId, actorId: memberId, createdAt: { gte: range.from, lte: range.to } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        type: true,
        targetId: true,
        targetType: true,
        description: true,
        metadata: true,
        createdAt: true,
      },
    }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { customStatuses: true } }),
  ]);

  // "In progress" is a workflow category ("active"), not a fixed status key — workspaces define
  // their own status keys (e.g. "in-progress", "building"), so this resolves the category from
  // the workspace's actual workflow config instead of guessing a hardcoded key.
  const workspaceStatuses = normalizeWorkspaceStatuses(workspace?.customStatuses as any[] | null);
  const isActiveStatus = (statusKey: string) => getStatusRecord(workspaceStatuses, statusKey)?.category === "active";

  const completedCurrent = filterCompletedByDate(assignedIssues, range.from, range.to).length;
  const completedPrevious = filterCompletedByDate(assignedIssues, range.previousFrom, range.previousTo).length;
  const heatmapMap = new Map<string, number>();
  for (const activity of activities) {
    const key = formatDayKey(activity.createdAt);
    heatmapMap.set(key, (heatmapMap.get(key) ?? 0) + 1);
  }

  const byProject = new Map<string, { projectId: string; projectName: string; assigned: number; completed: number }>();
  for (const issue of assignedIssues) {
    const current = byProject.get(issue.projectId) ?? {
      projectId: issue.projectId,
      projectName: issue.project?.name ?? "Unknown",
      assigned: 0,
      completed: 0,
    };
    current.assigned += 1;
    if (isDone(issue)) current.completed += 1;
    byProject.set(issue.projectId, current);
  }

  const byTeam = new Map<string, { teamId: string; teamName: string; assigned: number; completed: number }>();
  for (const issue of assignedIssues) {
    const current = byTeam.get(issue.teamId) ?? {
      teamId: issue.teamId,
      teamName: issue.team?.name ?? "Unknown",
      assigned: 0,
      completed: 0,
    };
    current.assigned += 1;
    if (isDone(issue)) current.completed += 1;
    byTeam.set(issue.teamId, current);
  }

  const completionTrend = calculateTrend(completedCurrent, completedPrevious);

  return withAnalyticsProvenance({
    member,
    summary: {
      assigned: assignedIssues.length,
      completed: assignedIssues.filter(isDone).length,
      inProgress: assignedIssues.filter((issue) => isActiveStatus(issue.status)).length,
      overdue: assignedIssues.filter((issue) => isOverdue(issue, new Date())).length,
      completionRate: {
        value: getCompletionRate(assignedIssues.filter(isDone).length, assignedIssues.length),
        trend: completionTrend.value,
        direction: completionTrend.direction,
      },
      avgResolutionTime: msToReadableUnit(avgResolutionTime(assignedIssues)),
    },
    charts: {
      activityHeatmap: buildDaySeries(range.from, range.to).map((day) => ({
        date: formatDayKey(day),
        count: heatmapMap.get(formatDayKey(day)) ?? 0,
      })),
      breakdownByProject: [...byProject.values()],
      breakdownByTeam: [...byTeam.values()],
    },
    tables: {
      teams: teamMemberships.map((membership: any) => membership.team),
      recentActivity: activities,
    },
  }, "member", query, range, {
    scopeId: memberId,
    partialDataNotes: [
      "Recent activity is capped to the latest 20 records in the selected range.",
    ],
  });
}

export async function getCycleAnalytics(workspaceId: string, role: WorkspaceRole, userId: string, cycleId: string, query: AnalyticsQuery) {
  const cycle = await assertCycleAnalyticsAccess(workspaceId, role, userId, cycleId);
  // Burndown/velocity must span the cycle's own scheduled window, not a rolling period from
  // today — a cycle's dates are fixed once planned, unrelated to when someone views the chart.
  const range = cycle.startsAt && cycle.endsAt
    ? resolveFixedDateRange(cycle.startsAt, cycle.endsAt)
    : resolveDateRange(query.period, query.from, query.to);
  const issues = await prisma.issue.findMany({ where: { workspaceId, cycleId }, select: ISSUE_SELECT });
  const total = issues.length;
  const completed = issues.filter(isDone).length;

  const dailyVelocity = buildVelocitySeries(issues.filter((issue) => issue.createdAt >= range.from && issue.createdAt <= range.to), range.from, range.to);
  const scopeByStatus = groupCount(issues, (issue) => issue.status, "status");
  const scopeByPriority = groupCount(issues, (issue) => issue.priority, "priority");
  const scopeByType = groupCount(issues, (issue) => issue.type, "type");
  const burndown = buildDaySeries(range.from, range.to).map((day) => ({
    date: formatDayKey(day),
    remaining: issues.filter((issue) => issue.createdAt <= day && (!(issue.completedAt as Date | null) || (issue.completedAt as Date).getTime() > day.getTime())).length,
  }));

  return withAnalyticsProvenance({
    cycle,
    summary: {
      totalIssues: total,
      completedIssues: completed,
      openIssues: total - completed,
      progress: getCompletionRate(completed, total),
      avgResolutionTime: msToReadableUnit(avgResolutionTime(issues)),
    },
    charts: {
      burndown,
      dailyVelocity,
      statusBreakdown: scopeByStatus,
      priorityBreakdown: scopeByPriority,
      typeBreakdown: scopeByType,
    },
  }, "cycle", query, range, {
    scopeId: cycleId,
    partialDataNotes: [
      "Cycle analytics reflect issues currently linked to the cycle.",
    ],
  });
}

export async function exportAnalytics(workspaceId: string, role: WorkspaceRole, userId: string, query: ExportQuery) {
  const scopeId = query.scopeId;
  let payload: Record<string, unknown>;
  let exportTitle: string;
  let exportPeriod: string = query.period;

  if (query.scope === "workspace") {
    if (!isPrivileged(role)) {
      throw new AppError(403, ERROR_CODES.FORBIDDEN, "Only admins can export workspace analytics");
    }
    payload = await getWorkspaceAnalytics(workspaceId, query);
    exportTitle = "Workspace Analytics Report";
  } else if (query.scope === "project") {
    payload = await getProjectAnalytics(workspaceId, role, userId, scopeId!, query);
    exportTitle = "Project Analytics Report";
  } else if (query.scope === "team") {
    if (!isPrivileged(role)) {
      throw new AppError(403, ERROR_CODES.FORBIDDEN, "Only admins can export team analytics");
    }
    payload = await getTeamAnalytics(workspaceId, role, userId, scopeId!, query);
    exportTitle = "Team Analytics Report";
  } else if (query.scope === "cycle") {
    if (!isPrivileged(role)) {
      throw new AppError(403, ERROR_CODES.FORBIDDEN, "Only admins can export cycle analytics");
    }
    payload = await getCycleAnalytics(workspaceId, role, userId, scopeId!, query);
    exportTitle = "Cycle Analytics Report";
  } else {
    payload = await getMemberAnalytics(workspaceId, role, userId, scopeId!, query);
    exportTitle = "Member Analytics Report";
  }

  if (typeof payload.period === "object" && payload.period && "from" in payload.period && "to" in payload.period) {
    const periodData = payload.period as Record<string, unknown>;
    exportPeriod = `${String(periodData.from)} to ${String(periodData.to)}`;
  }

  if (query.format === "json") {
    return {
      fileName: `analytics-${query.scope}.json`,
      contentType: "application/json",
      body: JSON.stringify(payload, null, 2),
    };
  }

  if (query.format === "pdf") {
    const body = await buildAnalyticsPdf({
      title: exportTitle,
      scope: query.scope,
      period: exportPeriod,
      payload,
    });

    return {
      fileName: `analytics-${query.scope}.pdf`,
      contentType: "application/pdf",
      body,
    };
  }

  return {
    fileName: `analytics-${query.scope}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: buildAnalyticsCsv({
      title: exportTitle,
      scope: query.scope,
      period: exportPeriod,
      payload,
    }),
  };
}
