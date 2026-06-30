import type { WorkspaceRole } from "../../app/generated/prisma/client.js";

import { prisma } from "../../shared/utils/prisma.js";
import {
  formatAnalyticsReport,
  getCycleAnalytics,
  getProjectAnalytics,
  getTeamAnalytics,
  getWorkspaceAnalytics,
} from "../analytics/analytics.service.js";

type ProactiveSummaryType = "PROJECT_HEALTH" | "TEAM_HEALTH" | "CYCLE_HEALTH";
type ProactiveSummaryScope = "project" | "team" | "cycle";

const BACKGROUND_ANALYTICS_ROLE: WorkspaceRole = "ADMIN";
const DEFAULT_RANGE = { period: "30d" } as const;
const DEFAULT_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;

type ProactiveSummaryResult = {
  type: ProactiveSummaryType;
  targetType: ProactiveSummaryScope;
  targetId: string;
  title: string;
  message: string;
  confidence: number;
  reason: string;
  payload: Record<string, unknown>;
  recipientUserIds: string[];
  dedupeSuffix: string;
  expiresAt: Date;
  notificationTargetType?: "workspace" | "project" | "team";
  notificationTargetId?: string;
  notificationUrl?: string;
};

function getDayBucket(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function expiresInDefaultWindow() {
  return new Date(Date.now() + DEFAULT_EXPIRY_MS);
}

async function getWorkspaceAdminIds(workspaceId: string) {
  const rows = await prisma.workspaceMembership.findMany({
    where: {
      workspaceId,
      role: { in: ["OWNER", "ADMIN"] as any },
    },
    select: { userId: true },
    take: 100,
  });
  return rows.map((row) => row.userId);
}

function uniqueUserIds(values: Array<string | null | undefined>) {
  return [...new Set(values.filter(Boolean) as string[])];
}

export async function buildWorkspaceDigestPayload(workspaceId: string) {
  const [analytics, owners, blockedRows, currentCycles] = await Promise.all([
    getWorkspaceAnalytics(workspaceId, { period: "7d" }),
    getWorkspaceAdminIds(workspaceId),
    prisma.issueRelation.findMany({
      where: {
        type: "BLOCKED_BY" as any,
        issue: { workspaceId, completedAt: null },
      },
      select: {
        issueId: true,
        issue: {
          select: {
            id: true,
            title: true,
            internalId: true,
            status: true,
          },
        },
      },
      take: 200,
    }),
    prisma.cycle.findMany({
      where: { workspaceId, status: "CURRENT" as any },
      select: {
        id: true,
        name: true,
        issues: { select: { id: true, status: true } },
      },
      take: 10,
    }),
  ]);

  const blockerCount = new Map<string, { issueId: string; title: string; publicId: string; count: number; status: string }>();
  for (const row of blockedRows) {
    if (!row.issue) continue;
    const current = blockerCount.get(row.issueId) ?? {
      issueId: row.issue.id,
      title: row.issue.title,
      publicId: row.issue.internalId,
      status: row.issue.status,
      count: 0,
    };
    current.count += 1;
    blockerCount.set(row.issueId, current);
  }

  const topBlockers = [...blockerCount.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const cycleProgress = currentCycles.map((cycle) => {
    const total = cycle.issues.length;
    const completed = cycle.issues.filter((issue) => issue.status === "DONE").length;
    return {
      cycleId: cycle.id,
      cycleName: cycle.name,
      totalIssues: total,
      completedIssues: completed,
      progressPercent: total === 0 ? 0 : Math.round((completed / total) * 100),
    };
  });

  return {
    title: "Weekly AI digest ready",
    message: formatAnalyticsReport("workspace", analytics),
    confidence: 1,
    reason: "Built from the shared workspace analytics primitives used by Trussen AI reports, with blocker and current-cycle highlights.",
    payload: {
      scope: "workspace",
      analytics,
      report: formatAnalyticsReport("workspace", analytics),
      topBlockers,
      cycleProgress,
    },
    recipientUserIds: owners,
    dedupeSuffix: `week:${getDayBucket()}`,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };
}

export async function buildProjectHealthSummary(workspaceId: string, projectId: string): Promise<ProactiveSummaryResult | null> {
  const [analytics, project, admins, memberships] = await Promise.all([
    getProjectAnalytics(workspaceId, BACKGROUND_ANALYTICS_ROLE, "", projectId, DEFAULT_RANGE),
    prisma.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { id: true, name: true, leadId: true },
    }),
    getWorkspaceAdminIds(workspaceId),
    prisma.projectMembership.findMany({
      where: { projectId },
      select: { userId: true },
      take: 100,
    }),
  ]);

  if (!project) return null;

  const summary = (analytics.summary ?? {}) as Record<string, any>;
  const memberWorkload = Array.isArray((analytics.tables ?? {}).memberWorkload)
    ? (analytics.tables?.memberWorkload as Array<Record<string, any>>)
    : [];
  const overloadedMembers = memberWorkload.filter((row) => Number(row.open ?? 0) >= 6);
  const overdueMembers = memberWorkload.filter((row) => Number(row.overdue ?? 0) > 0);
  const timelineHealth = String(summary.timelineHealth ?? "unknown");
  const openIssues = Number(summary.openIssues ?? 0);

  if (timelineHealth === "on-track" && overloadedMembers.length === 0 && overdueMembers.length === 0 && openIssues < 8) {
    return null;
  }

  const riskSignals = [
    `timeline health: ${timelineHealth}`,
    ...(overloadedMembers.length > 0 ? [`${overloadedMembers.length} overloaded member${overloadedMembers.length === 1 ? "" : "s"}`] : []),
    ...(overdueMembers.length > 0 ? [`${overdueMembers.length} member${overdueMembers.length === 1 ? "" : "s"} carrying overdue work`] : []),
    `${openIssues} open issue${openIssues === 1 ? "" : "s"}`,
  ];

  return {
    type: "PROJECT_HEALTH",
    targetType: "project",
    targetId: project.id,
    title: "Project health summary",
    message: formatAnalyticsReport("project", analytics),
    confidence: timelineHealth === "behind" ? 0.92 : 0.82,
    reason: "Generated from the shared project analytics pipeline to proactively surface delivery risk.",
    payload: {
      scope: "project",
      analytics,
      report: formatAnalyticsReport("project", analytics),
      riskSignals,
      anchor: { targetType: "project", targetId: project.id },
    },
    recipientUserIds: uniqueUserIds([
      ...admins,
      project.leadId,
      ...memberships.map((membership) => membership.userId),
    ]),
    dedupeSuffix: `day:${getDayBucket()}`,
    expiresAt: expiresInDefaultWindow(),
    notificationTargetType: "project",
    notificationTargetId: project.id,
    notificationUrl: `/projects/${project.id}`,
  };
}

export async function buildTeamHealthSummary(workspaceId: string, teamId: string): Promise<ProactiveSummaryResult | null> {
  const [analytics, team, admins, memberships] = await Promise.all([
    getTeamAnalytics(workspaceId, BACKGROUND_ANALYTICS_ROLE, "", teamId, DEFAULT_RANGE),
    prisma.team.findFirst({
      where: { id: teamId, workspaceId },
      select: { id: true, name: true, leadId: true },
    }),
    getWorkspaceAdminIds(workspaceId),
    prisma.teamMembership.findMany({
      where: { teamId },
      select: { userId: true },
      take: 100,
    }),
  ]);

  if (!team) return null;

  const summary = (analytics.summary ?? {}) as Record<string, any>;
  const memberPerformance = Array.isArray((analytics.tables ?? {}).memberPerformance)
    ? (analytics.tables?.memberPerformance as Array<Record<string, any>>)
    : [];
  const overloadedMembers = memberPerformance.filter((row) => Number(row.open ?? 0) >= 6);
  const overdueMembers = memberPerformance.filter((row) => Number(row.overdue ?? 0) > 0);
  const velocityDirection = String((summary.velocity ?? {}).direction ?? "flat");

  if (overloadedMembers.length === 0 && overdueMembers.length === 0 && velocityDirection !== "down") {
    return null;
  }

  const riskSignals = [
    ...(overloadedMembers.length > 0 ? [`${overloadedMembers.length} overloaded member${overloadedMembers.length === 1 ? "" : "s"}`] : []),
    ...(overdueMembers.length > 0 ? [`${overdueMembers.length} member${overdueMembers.length === 1 ? "" : "s"} with overdue work`] : []),
    `velocity trend: ${velocityDirection}`,
  ];

  return {
    type: "TEAM_HEALTH",
    targetType: "team",
    targetId: team.id,
    title: "Team health summary",
    message: formatAnalyticsReport("team", analytics),
    confidence: overloadedMembers.length > 0 || overdueMembers.length > 0 ? 0.84 : 0.74,
    reason: "Generated from the shared team analytics pipeline to surface workload imbalance and delivery pressure.",
    payload: {
      scope: "team",
      analytics,
      report: formatAnalyticsReport("team", analytics),
      riskSignals,
      anchor: { targetType: "team", targetId: team.id },
    },
    recipientUserIds: uniqueUserIds([
      ...admins,
      team.leadId,
      ...memberships.map((membership) => membership.userId),
    ]),
    dedupeSuffix: `day:${getDayBucket()}`,
    expiresAt: expiresInDefaultWindow(),
    notificationTargetType: "team",
    notificationTargetId: team.id,
    notificationUrl: `/teams/${team.id}`,
  };
}

export async function buildCycleHealthSummary(workspaceId: string, cycleId: string): Promise<ProactiveSummaryResult | null> {
  const [analytics, cycle, admins, memberships] = await Promise.all([
    getCycleAnalytics(workspaceId, BACKGROUND_ANALYTICS_ROLE, "", cycleId, DEFAULT_RANGE),
    prisma.cycle.findFirst({
      where: { id: cycleId, workspaceId },
      select: {
        id: true,
        name: true,
        teamId: true,
        team: { select: { leadId: true } },
      },
    }),
    getWorkspaceAdminIds(workspaceId),
    prisma.cycle.findFirst({
      where: { id: cycleId, workspaceId },
      select: {
        team: {
          select: {
            memberships: {
              select: { userId: true },
              take: 100,
            },
          },
        },
      },
    }),
  ]);

  if (!cycle) return null;

  const summary = (analytics.summary ?? {}) as Record<string, any>;
  const progress = Number(summary.progress ?? 0);
  const openIssues = Number(summary.openIssues ?? 0);

  if (progress >= 70 && openIssues <= 6) {
    return null;
  }

  const riskSignals = [
    `progress: ${progress}%`,
    `${openIssues} open issue${openIssues === 1 ? "" : "s"}`,
  ];

  return {
    type: "CYCLE_HEALTH",
    targetType: "cycle",
    targetId: cycle.id,
    title: "Cycle health summary",
    message: formatAnalyticsReport("cycle", analytics),
    confidence: progress < 40 ? 0.88 : 0.76,
    reason: "Generated from the shared cycle analytics pipeline to highlight pacing risk before the cycle slips further.",
    payload: {
      scope: "cycle",
      analytics,
      report: formatAnalyticsReport("cycle", analytics),
      riskSignals,
      teamId: cycle.teamId,
      anchor: { targetType: "cycle", targetId: cycle.id },
    },
    recipientUserIds: uniqueUserIds([
      ...admins,
      cycle.team?.leadId,
      ...((memberships?.team?.memberships ?? []).map((membership) => membership.userId)),
    ]),
    dedupeSuffix: `day:${getDayBucket()}`,
    expiresAt: expiresInDefaultWindow(),
    notificationTargetType: "team",
    notificationTargetId: cycle.teamId,
    notificationUrl: `/cycles/${cycle.id}`,
  };
}
