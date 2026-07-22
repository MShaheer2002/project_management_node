/**
 * Issue Module — Approval Gate Service Layer
 *
 * Tracks reviewer approvals for issues sitting in an approval-gated status.
 * The workflow config (shared/workflow/workflow-automation.ts `approval` field)
 * defines HOW MANY approvals a status needs and WHO is eligible; this module
 * records actual approval events and answers "has this issue met its gate".
 *
 * Approvals are scoped to (issueId, statusKey) and cleared whenever the issue
 * re-enters that status (see issue.service.ts) so a stale approval from an
 * earlier review cycle never silently satisfies a later one.
 */
import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { logActivity } from "../../shared/utils/activity.js";
import { resolveEffectiveWorkflow } from "../../shared/workflow/effective-workflow.js";
import type { WorkspaceStatusApprovalConfig } from "../../shared/workflow/workflow-automation.js";

async function getIssueForApproval(workspaceId: string, issueId: string) {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      teamId: true,
      departmentId: true,
      project: { select: { customStatuses: true, workflowAutomation: true } },
    },
  });
  if (!issue) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }
  return issue;
}

async function getEffectiveStatus(
  workspaceId: string,
  project: { customStatuses: unknown; workflowAutomation: unknown } | null,
  statusKey: string,
) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { customStatuses: true, workflowAutomation: true },
  });
  const effective = resolveEffectiveWorkflow(
    { customStatuses: workspace?.customStatuses ?? null, workflowAutomation: workspace?.workflowAutomation ?? null },
    project,
  );
  const status = effective.statuses.find((candidate) => candidate.key === statusKey);
  if (!status) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, `Invalid status: ${statusKey}`);
  }
  return status;
}

async function isEligibleReviewer(
  workspaceId: string,
  issue: { projectId: string; teamId: string; departmentId: string | null },
  approval: WorkspaceStatusApprovalConfig,
  actorUserId: string,
): Promise<boolean> {
  switch (approval.reviewerSource) {
    case "manual":
      return approval.reviewerUserIds.includes(actorUserId);

    case "team_lead": {
      const team = await prisma.team.findFirst({
        where: { id: issue.teamId, workspaceId },
        select: { leadId: true },
      });
      return team?.leadId === actorUserId;
    }

    case "department_head": {
      if (!issue.departmentId) return false;
      const department = await prisma.department.findFirst({
        where: { id: issue.departmentId, workspaceId },
        select: { headId: true },
      });
      return Boolean(department?.headId) && department!.headId === actorUserId;
    }

    case "project_members":
    default: {
      const [membership, project] = await Promise.all([
        prisma.projectMembership.findUnique({
          where: { projectId_userId: { projectId: issue.projectId, userId: actorUserId } },
          select: { userId: true },
        }),
        prisma.project.findFirst({ where: { id: issue.projectId, workspaceId }, select: { leadId: true } }),
      ]);
      return Boolean(membership) || project?.leadId === actorUserId;
    }
  }
}

export async function getIssueApprovalStatus(workspaceId: string, issueId: string) {
  const issue = await getIssueForApproval(workspaceId, issueId);
  const status = await getEffectiveStatus(workspaceId, issue.project, issue.status);

  const approvals = await prisma.issueApproval.findMany({
    where: { issueId: issue.id, statusKey: issue.status },
    orderBy: { createdAt: "asc" },
    select: {
      approverId: true,
      createdAt: true,
      approver: { select: { id: true, name: true, email: true, avatar: true } },
    },
  });

  return {
    statusKey: issue.status,
    statusLabel: status.label,
    required: status.approval.required,
    requiredCount: status.approval.requiredCount,
    reviewerSource: status.approval.reviewerSource,
    currentCount: approvals.length,
    satisfied: !status.approval.required || approvals.length >= status.approval.requiredCount,
    approvals: approvals.map((approval) => ({
      userId: approval.approverId,
      name: approval.approver.name,
      email: approval.approver.email,
      avatar: approval.approver.avatar,
      approvedAt: approval.createdAt,
    })),
  };
}

export async function approveIssueStatus(workspaceId: string, issueId: string, actorUserId: string) {
  const issue = await getIssueForApproval(workspaceId, issueId);
  const status = await getEffectiveStatus(workspaceId, issue.project, issue.status);

  if (!status.approval.required) {
    throw new AppError(409, ERROR_CODES.APPROVAL_NOT_REQUIRED, `${status.label} does not require approval`);
  }

  const eligible = await isEligibleReviewer(workspaceId, issue, status.approval, actorUserId);
  if (!eligible) {
    throw new AppError(403, ERROR_CODES.APPROVAL_NOT_ELIGIBLE, "You are not an eligible reviewer for this status");
  }

  await prisma.issueApproval.upsert({
    where: { issueId_statusKey_approverId: { issueId: issue.id, statusKey: issue.status, approverId: actorUserId } },
    create: { workspaceId, issueId: issue.id, statusKey: issue.status, approverId: actorUserId },
    update: {},
  });

  await logActivity({
    workspaceId,
    actorId: actorUserId,
    type: "ISSUE_APPROVED",
    targetType: "ISSUE",
    targetId: issue.id,
    message: `Issue ${issue.id} approved at ${status.label}`,
    metadata: {
      issueId: issue.id,
      issuePublicId: issue.id,
      entityId: issue.id,
      entityTitle: issue.title,
      statusKey: issue.status,
    },
  });

  return getIssueApprovalStatus(workspaceId, issueId);
}

export async function revokeIssueApproval(workspaceId: string, issueId: string, actorUserId: string) {
  const issue = await getIssueForApproval(workspaceId, issueId);

  const existing = await prisma.issueApproval.findUnique({
    where: { issueId_statusKey_approverId: { issueId: issue.id, statusKey: issue.status, approverId: actorUserId } },
  });
  if (!existing) {
    throw new AppError(404, ERROR_CODES.APPROVAL_NOT_FOUND, "You have not approved this issue at its current status");
  }

  await prisma.issueApproval.delete({ where: { id: existing.id } });

  await logActivity({
    workspaceId,
    actorId: actorUserId,
    type: "ISSUE_APPROVAL_REVOKED",
    targetType: "ISSUE",
    targetId: issue.id,
    message: `Issue ${issue.id} approval revoked`,
    metadata: {
      issueId: issue.id,
      issuePublicId: issue.id,
      entityId: issue.id,
      entityTitle: issue.title,
      statusKey: issue.status,
    },
  });

  return getIssueApprovalStatus(workspaceId, issueId);
}
