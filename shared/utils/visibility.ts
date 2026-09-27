/**
 * Private-project visibility — one definition, used by every read surface.
 *
 * A PRIVATE project is visible only to workspace OWNER/ADMIN, the project lead,
 * and its members. That rule was previously re-implemented per call site, so
 * surfaces that forgot it (AI suggestions, activity feeds, analytics context)
 * leaked private project data to any GUEST — audit F-06.
 *
 * Usage: spread into a Prisma `where`.
 *
 *   prisma.issue.findMany({ where: { workspaceId, ...visibleIssueWhere(viewer) } })
 *   prisma.project.findMany({ where: { workspaceId, ...visibleProjectWhere(viewer) } })
 */

import type { WorkspaceRole } from "../../app/generated/prisma/client.js";
import { prisma } from "./prisma.js";
import { AppError } from "./api-error.js";
import { ERROR_CODES } from "../errors/error-codes.js";

export type Viewer = { userId: string; role: WorkspaceRole };

export function isWorkspaceAdmin(role: WorkspaceRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

/** Where-fragment for `Project` queries. Empty for admins — they see everything. */
export function visibleProjectWhere(viewer: Viewer): Record<string, unknown> {
  if (isWorkspaceAdmin(viewer.role)) return {};
  return {
    OR: [
      { visibility: "PUBLIC" },
      { leadId: viewer.userId },
      { memberships: { some: { userId: viewer.userId } } },
    ],
  };
}

/** Where-fragment for `Issue` queries — filters through the issue's project. */
export function visibleIssueWhere(viewer: Viewer): Record<string, unknown> {
  if (isWorkspaceAdmin(viewer.role)) return {};
  return {
    OR: [
      { project: { visibility: "PUBLIC" } },
      { project: { leadId: viewer.userId } },
      { project: { memberships: { some: { userId: viewer.userId } } } },
    ],
  };
}

/**
 * Which of `userIds` may see this issue: live members of the workspace, each
 * checked with the same rule as visibleIssueWhere. Used before notifying
 * someone about an issue — a notification carries its title and a comment
 * excerpt, so sending one to a non-member of a private project leaks both
 * (F-38). Callers keep the list small (mentions are capped).
 */
export async function filterUsersWhoCanSeeIssue(workspaceId: string, issueId: string, userIds: string[]) {
  if (userIds.length === 0) return [];
  const memberships = await prisma.workspaceMembership.findMany({
    where: { workspaceId, userId: { in: userIds }, user: { deletedAt: null } },
    select: { userId: true, role: true },
  });
  const visible = await Promise.all(memberships.map(async ({ userId, role }) => {
    const count = await prisma.issue.count({ where: { id: issueId, workspaceId, ...visibleIssueWhere({ userId, role }) } });
    return count > 0 ? userId : null;
  }));
  // Keep the caller's order (mention order decides who is notified first).
  const allowed = new Set(visible.filter((id): id is string => id !== null));
  return userIds.filter((id) => allowed.has(id));
}

/**
 * Drop activity rows whose target the viewer cannot see.
 *
 * Activity is workspace-scoped and its messages/metadata embed issue keys,
 * titles, comment excerpts and project names, so an unfiltered feed re-exposes
 * exactly what the issue and project reads protect (F-06 b, m).
 *
 * Rows targeting anything else (teams, cycles, members, integrations) are kept —
 * this filter is about private *projects*, not a general activity ACL.
 */
export async function filterVisibleActivityRows<
  T extends { targetType: string | null; targetId: string | null },
>(rows: T[], workspaceId: string, viewer: Viewer): Promise<T[]> {
  if (isWorkspaceAdmin(viewer.role)) return rows;

  const idsOf = (type: string) => [
    ...new Set(rows.filter((r) => r.targetType === type && r.targetId).map((r) => r.targetId!)),
  ];
  const issueIds = idsOf("ISSUE");
  const projectIds = idsOf("PROJECT");
  if (issueIds.length === 0 && projectIds.length === 0) return rows;

  const [visibleIssues, visibleProjects] = await Promise.all([
    issueIds.length
      ? prisma.issue.findMany({
          where: { id: { in: issueIds }, workspaceId, ...visibleIssueWhere(viewer) },
          select: { id: true },
        })
      : Promise.resolve([] as Array<{ id: string }>),
    projectIds.length
      ? prisma.project.findMany({
          where: { id: { in: projectIds }, workspaceId, ...visibleProjectWhere(viewer) },
          select: { id: true },
        })
      : Promise.resolve([] as Array<{ id: string }>),
  ]);

  const okIssues = new Set(visibleIssues.map((i) => i.id));
  const okProjects = new Set(visibleProjects.map((p) => p.id));

  return rows.filter((r) => {
    if (r.targetType === "ISSUE") return !!r.targetId && okIssues.has(r.targetId);
    if (r.targetType === "PROJECT") return !!r.targetId && okProjects.has(r.targetId);
    return true;
  });
}

/**
 * Throw unless the viewer may see this project.
 *
 * Returns 404 (not 403) for a project that exists but is hidden, so the
 * response cannot be used to probe which project ids exist.
 */
export async function assertProjectVisible(
  workspaceId: string,
  projectId: string,
  viewer: Viewer,
): Promise<void> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId, ...visibleProjectWhere(viewer) },
    select: { id: true },
  });
  if (!project) {
    throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
  }
}

/**
 * Throw unless the viewer may see this issue.
 *
 * 404 for an issue that exists but is hidden, so the response cannot be used to
 * probe which issue keys exist — keys are sequential (`PREFIX-N`) and therefore
 * trivially enumerable.
 */
export async function assertIssueVisible(
  workspaceId: string,
  issueId: string,
  viewer: Viewer,
): Promise<void> {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId, ...visibleIssueWhere(viewer) },
    select: { id: true },
  });
  if (!issue) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }
}
