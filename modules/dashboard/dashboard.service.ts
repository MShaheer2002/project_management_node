/**
 * Dashboard Module — Service Layer
 *
 * Aggregates read-only workspace data for the dashboard screen.
 * Every query is scoped by workspaceId to preserve tenant isolation.
 */

import { prisma } from "../../shared/utils/prisma.js";

function formatDueTime(value: Date | string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 5);

  const hours = String(value.getUTCHours()).padStart(2, "0");
  const minutes = String(value.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

const DASHBOARD_DAYS = 7;
const LIST_LIMIT = 5;
const ACTIVITY_LIMIT = 10;

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function formatDayLabel(date: Date) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
}

function getLastSevenDays() {
  const today = startOfDay(new Date());
  return Array.from({ length: DASHBOARD_DAYS }, (_, index) =>
    addDays(today, index - (DASHBOARD_DAYS - 1)),
  );
}

function getIssueProgress(total: number, completed: number) {
  if (total === 0) return 0;
  return Math.round((completed / total) * 100);
}

/**
 * GET /dashboard
 *
 * Returns all data needed to render the dashboard after signup/login.
 */
export async function getDashboardData(workspaceId: string, userId: string) {
  const days = getLastSevenDays();
  const rangeStart = days[0]!;
  const rangeEnd = addDays(days[days.length - 1]!, 1);
  const today = startOfDay(new Date());

  const [
    workspace,
    issuesCompleted,
    activeProjectsCount,
    teamMembers,
    openIssues,
    unreadNotifications,
    assignedToMe,
    activeProjects,
    upcomingDeadlines,
    teamActivity,
    completedIssuesInRange,
    openIssuesCreatedInRange,
    currentOpenIssues,
  ] = await Promise.all([
    prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: {
        id: true,
        name: true,
        slug: true,
        logo: true,
        teamSize: true,
      },
    }),
    prisma.issue.count({
      where: { workspaceId, status: "DONE" },
    }),
    prisma.project.count({
      where: { workspaceId, status: "ACTIVE" },
    }),
    prisma.workspaceMembership.count({
      where: { workspaceId },
    }),
    prisma.issue.count({
      where: { workspaceId, status: { not: "DONE" } },
    }),
    prisma.notification.count({
      where: { workspaceId, recipientUserId: userId, readAt: null },
    }),
    prisma.issue.findMany({
      where: { workspaceId, assigneeId: userId, status: { not: "DONE" } },
      orderBy: [
        { priority: "desc" },
        { dueDate: "asc" },
        { updatedAt: "desc" },
      ],
      take: LIST_LIMIT,
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        priority: true,
        dueDate: true,
        dueTime: true,
        updatedAt: true,
        project: { select: { id: true, name: true } },
        team: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true, email: true, avatar: true } },
        _count: { select: { subtasks: true } },
        subtasks: { select: { completed: true } },
      },
    }),
    prisma.project.findMany({
      where: { workspaceId, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      take: LIST_LIMIT,
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        visibility: true,
        updatedAt: true,
        team: { select: { id: true, name: true } },
        lead: { select: { id: true, name: true, email: true, avatar: true } },
        issues: {
          select: { status: true },
        },
      },
    }),
    prisma.issue.findMany({
      where: {
        workspaceId,
        status: { not: "DONE" },
        dueDate: { gte: today },
      },
      orderBy: [{ dueDate: "asc" }, { priority: "desc" }],
      take: LIST_LIMIT,
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        priority: true,
        dueDate: true,
        dueTime: true,
        project: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true, email: true, avatar: true } },
      },
    }),
    prisma.activity.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: ACTIVITY_LIMIT,
      select: {
        id: true,
        type: true,
        targetId: true,
        targetType: true,
        description: true,
        metadata: true,
        createdAt: true,
        actor: { select: { id: true, name: true, email: true, avatar: true } },
      },
    }),
    prisma.issue.findMany({
      where: {
        workspaceId,
        status: "DONE",
        updatedAt: { gte: rangeStart, lt: rangeEnd },
      },
      select: { updatedAt: true },
    }),
    prisma.issue.findMany({
      where: {
        workspaceId,
        status: { not: "DONE" },
        createdAt: { gte: rangeStart, lt: rangeEnd },
      },
      select: { createdAt: true },
    }),
    prisma.issue.findMany({
      where: { workspaceId, status: { not: "DONE" } },
      select: { createdAt: true },
    }),
  ]);

  const velocity = days.map((day) => {
    const nextDay = addDays(day, 1);
    const completed = completedIssuesInRange.filter(
      (issue) => issue.updatedAt >= day && issue.updatedAt < nextDay,
    ).length;
    const opened = openIssuesCreatedInRange.filter(
      (issue) => issue.createdAt >= day && issue.createdAt < nextDay,
    ).length;

    return {
      date: day.toISOString(),
      label: formatDayLabel(day),
      completed,
      opened,
    };
  });

  const sprintProgress = days.map((day) => {
    const nextDay = addDays(day, 1);
    const open = currentOpenIssues.filter((issue) => issue.createdAt < nextDay).length;

    return {
      date: day.toISOString(),
      label: formatDayLabel(day),
      open,
    };
  });

  return {
    workspace,
    stats: {
      issuesCompleted,
      activeProjects: activeProjectsCount,
      teamMembers,
      openIssues,
      unreadNotifications,
    },
    charts: {
      velocity,
      sprintProgress,
    },
    assignedToMe: assignedToMe.map((issue) => {
      const completedSubtasks = issue.subtasks.filter((subtask) => subtask.completed).length;

      return {
        id: issue.id,
        title: issue.title,
        type: issue.type,
        status: issue.status,
        priority: issue.priority,
        dueDate: issue.dueDate,
        dueTime: formatDueTime(issue.dueTime),
        updatedAt: issue.updatedAt,
        project: issue.project,
        team: issue.team,
        assignee: issue.assignee,
        subtasks: {
          total: issue._count.subtasks,
          completed: completedSubtasks,
        },
      };
    }),
    activeProjects: activeProjects.map((project) => {
      const issueCount = project.issues.length;
      const completedIssueCount = project.issues.filter((issue) => issue.status === "DONE").length;

      return {
        id: project.id,
        name: project.name,
        description: project.description,
        status: project.status,
        visibility: project.visibility,
        updatedAt: project.updatedAt,
        team: project.team,
        lead: project.lead,
        issueCount,
        completedIssueCount,
        progress: getIssueProgress(issueCount, completedIssueCount),
      };
    }),
    upcomingDeadlines,
    teamActivity,
  };
}
