import { prisma } from "../utils/prisma.js";
import { logActivity } from "../utils/activity.js";
import { createNotification } from "../../modules/notification/notification.service.js";
import { resolveEffectiveWorkflow, resolveEffectiveWorkflowMap, type EffectiveWorkflow } from "./effective-workflow.js";
import type { WorkspaceStatusRecord } from "./workflow-automation.js";

function isFinalStatus(statuses: Array<{ key: string; isFinal: boolean }>, statusKey: string) {
  return statuses.find((status) => status.key === statusKey)?.isFinal === true;
}

async function getWorkspaceWorkflowSource(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { customStatuses: true, workflowAutomation: true },
  });
  return { customStatuses: workspace?.customStatuses ?? null, workflowAutomation: workspace?.workflowAutomation ?? null };
}

/**
 * Resolves the effective workflow for a single issue's project. Used by automations
 * that act on one issue at a time (subtask completion, single cycle-add).
 */
async function getWorkflowContextForProject(workspaceId: string, projectId: string): Promise<EffectiveWorkflow> {
  const [workspaceSource, project] = await Promise.all([
    getWorkspaceWorkflowSource(workspaceId),
    prisma.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { customStatuses: true, workflowAutomation: true },
    }),
  ]);
  return resolveEffectiveWorkflow(workspaceSource, project);
}

/**
 * Resolves the effective workflow for every distinct project among a set of ids in
 * one batch. Used by automations that act on many issues at once (cycle-start,
 * overdue scan), where those issues can belong to different projects that each
 * may have a different effective workflow.
 */
async function getWorkflowContextForProjects(workspaceId: string, projectIds: string[]): Promise<Map<string, EffectiveWorkflow>> {
  const uniqueProjectIds = [...new Set(projectIds)];
  const [workspaceSource, projects] = await Promise.all([
    getWorkspaceWorkflowSource(workspaceId),
    uniqueProjectIds.length > 0
      ? prisma.project.findMany({
          where: { id: { in: uniqueProjectIds }, workspaceId },
          select: { id: true, customStatuses: true, workflowAutomation: true },
        })
      : Promise.resolve([]),
  ]);
  return resolveEffectiveWorkflowMap(workspaceSource, projects);
}

/**
 * Would moving an issue between these statuses cross a workflow gate?
 *
 * An automation has no reviewer, no role and no way to satisfy a person-specific
 * rule, so it must not perform a move the workflow restricts — otherwise
 * completing subtasks becomes a way around approvals (F-21). It does not
 * evaluate the gate *against the triggering user*: even a user who could make
 * the move by hand should do so explicitly, not as a side effect.
 *
 * Returns the reason it is blocked, or null when the move is unrestricted.
 */
export function automationTransitionBlockedBy(
  statuses: WorkspaceStatusRecord[],
  currentStatusKey: string,
  targetStatusKey: string,
): string | null {
  const current = statuses.find((status) => status.key === currentStatusKey);
  const target = statuses.find((status) => status.key === targetStatusKey);
  if (!current || !target) return "unknown status";

  // Forward move out of an approval-gated status — the exact bypass.
  if (current.approval.required && target.order > current.order) {
    return `${current.label} requires approval before moving forward`;
  }

  if (current.transitions.mode === "restricted") {
    const explicit = current.transitions.to.includes(targetStatusKey);
    const rollback = current.transitions.allowRollback && target.order < current.order;
    if (!explicit && !rollback) {
      return `${current.label} cannot transition to ${target.label}`;
    }
  }

  // Person-specific gates an automation cannot stand in for.
  if (target.transitions.assigneeOnly) return `${target.label} can only be entered by the assignee`;
  if (target.transitions.creatorOnly) return `${target.label} can only be entered by the creator`;

  return null;
}

export async function runSubtaskCompletionAutomation(
  workspaceId: string,
  issueId: string,
  actorUserId: string,
) {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: {
      id: true,
      title: true,
      status: true,
      completedAt: true,
      assigneeId: true,
      creatorId: true,
      projectId: true,
      watchers: { select: { userId: true } },
      subtasks: { select: { id: true, completed: true } },
    },
  });

  if (!issue) {
    return;
  }

  const { statuses, automation } = await getWorkflowContextForProject(workspaceId, issue.projectId);
  if (!automation.subtaskCompletion.enabled || !automation.subtaskCompletion.targetStatusKey) {
    return;
  }

  if (issue.subtasks.length === 0) {
    return;
  }

  const allCompleted = issue.subtasks.every((subtask) => subtask.completed);
  if (!allCompleted || isFinalStatus(statuses, issue.status)) {
    return;
  }

  const targetStatusKey = automation.subtaskCompletion.targetStatusKey;

  if (automation.subtaskCompletion.mode === "move" && targetStatusKey !== issue.status) {
    const blocked = automationTransitionBlockedBy(statuses, issue.status, targetStatusKey);
    if (blocked) {
      console.warn(
        `[workflow] subtask-completion automation skipped for issue ${issue.id}: ${blocked}`,
      );
      return;
    }

    const nextCompletedAt = isFinalStatus(statuses, targetStatusKey) ? new Date() : issue.completedAt;

    await prisma.issue.update({
      where: { id: issue.id },
      data: {
        status: targetStatusKey,
        completedAt: nextCompletedAt,
      },
    });

    await logActivity({
      workspaceId,
      actorId: actorUserId,
      type: "ISSUE_STATUS_CHANGED",
      targetType: "ISSUE",
      targetId: issue.id,
      message: `Issue ${issue.id} status changed`,
      metadata: {
        issueId: issue.id,
        issuePublicId: issue.id,
        entityId: issue.id,
        entityTitle: issue.title,
        fromStatus: issue.status,
        toStatus: targetStatusKey,
        trigger: "workflow_subtasks_complete",
      },
    });

    return;
  }

  const recipients = new Set<string>([
    issue.assigneeId,
    issue.creatorId,
    ...issue.watchers.map((watcher) => watcher.userId),
  ].filter(Boolean) as string[]);

  await Promise.all(
    [...recipients].map((recipientUserId) =>
      createNotification({
        workspaceId,
        recipientUserId,
        actorUserId,
        type: "UPDATE",
        category: "update",
        title: "Issue ready for completion",
        message: `${issue.id} has all subtasks completed and can move to ${targetStatusKey}`,
        target: {
          type: "issue",
          id: issue.id,
          publicId: issue.id,
          url: `/issues/${issue.id}`,
        },
        metadata: {
          issueId: issue.id,
          issuePublicId: issue.id,
          entityId: issue.id,
          entityTitle: issue.title,
          workflowAutomation: "subtaskCompletion",
          suggestedStatus: targetStatusKey,
          url: `/issues/${issue.id}`,
        },
        eventId: `workflow-subtasks-ready:${issue.id}:${targetStatusKey}:${issue.subtasks.length}`,
      }),
    ),
  );
}

export async function runCycleStartAutomation(
  workspaceId: string,
  cycleId: string,
  actorUserId: string,
) {
  const issues = await prisma.issue.findMany({
    where: {
      workspaceId,
      cycleId,
      completedAt: null,
    },
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
    },
  });

  if (issues.length === 0) {
    return;
  }

  const workflowByProject = await getWorkflowContextForProjects(workspaceId, issues.map((issue) => issue.projectId));

  const movable = issues.filter((issue) => {
    const workflow = workflowByProject.get(issue.projectId);
    const cycleStart = workflow?.automation.cycleStart;
    if (!cycleStart?.enabled || !cycleStart.fromStatusKey || !cycleStart.targetStatusKey) return false;
    if (cycleStart.fromStatusKey === cycleStart.targetStatusKey) return false;
    return issue.status === cycleStart.fromStatusKey;
  });

  if (movable.length === 0) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const issue of movable) {
      const targetStatusKey = workflowByProject.get(issue.projectId)!.automation.cycleStart.targetStatusKey!;

      await tx.issue.update({
        where: { id: issue.id },
        data: { status: targetStatusKey },
      });

      await logActivity({
        workspaceId,
        actorId: actorUserId,
        type: "ISSUE_STATUS_CHANGED",
        targetType: "ISSUE",
        targetId: issue.id,
        message: `Issue ${issue.id} status changed`,
        metadata: {
          issueId: issue.id,
          issuePublicId: issue.id,
          entityId: issue.id,
          entityTitle: issue.title,
          cycleId,
          fromStatus: issue.status,
          toStatus: targetStatusKey,
          trigger: "workflow_cycle_started",
        },
      });
    }
  });
}

export async function runIssueAddedToCurrentCycleAutomation(
  workspaceId: string,
  cycleId: string,
  issueId: string,
  actorUserId: string,
) {
  const cycle = await prisma.cycle.findFirst({
    where: { id: cycleId, workspaceId },
    select: { id: true, status: true },
  });

  if (!cycle || cycle.status !== "CURRENT") {
    return;
  }

  const issue = await prisma.issue.findFirst({
    where: {
      id: issueId,
      workspaceId,
      cycleId,
      completedAt: null,
    },
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
    },
  });

  if (!issue) {
    return;
  }

  const { statuses, automation } = await getWorkflowContextForProject(workspaceId, issue.projectId);
  const { cycleStart } = automation;
  if (!cycleStart.enabled || !cycleStart.fromStatusKey || !cycleStart.targetStatusKey) {
    return;
  }
  if (cycleStart.fromStatusKey === cycleStart.targetStatusKey) {
    return;
  }
  if (issue.status !== cycleStart.fromStatusKey || isFinalStatus(statuses, issue.status)) {
    return;
  }

  await prisma.issue.update({
    where: { id: issue.id },
    data: { status: cycleStart.targetStatusKey },
  });

  await logActivity({
    workspaceId,
    actorId: actorUserId,
    type: "ISSUE_STATUS_CHANGED",
    targetType: "ISSUE",
    targetId: issue.id,
    message: `Issue ${issue.id} status changed`,
    metadata: {
      issueId: issue.id,
      issuePublicId: issue.id,
      entityId: issue.id,
      entityTitle: issue.title,
      cycleId,
      fromStatus: issue.status,
      toStatus: cycleStart.targetStatusKey,
      trigger: "workflow_issue_added_to_current_cycle",
    },
  });
}

export async function runOverdueIssueAutomation(workspaceId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const windowKey = today.toISOString().slice(0, 10);

  const issues = await prisma.issue.findMany({
    where: {
      workspaceId,
      completedAt: null,
      dueDate: { lt: today },
    },
    select: {
      id: true,
      title: true,
      dueDate: true,
      assigneeId: true,
      creatorId: true,
      projectId: true,
      watchers: { select: { userId: true } },
    },
    take: 250,
  });

  if (issues.length === 0) {
    return;
  }

  const workflowByProject = await getWorkflowContextForProjects(workspaceId, issues.map((issue) => issue.projectId));
  const eligibleIssues = issues.filter((issue) => workflowByProject.get(issue.projectId)?.automation.overdue.enabled);

  await Promise.all(
    eligibleIssues.flatMap((issue) => {
      const recipients = new Set<string>([
        issue.assigneeId,
        issue.creatorId,
        ...issue.watchers.map((watcher) => watcher.userId),
      ].filter(Boolean) as string[]);

      return [...recipients].map((recipientUserId) =>
        createNotification({
          workspaceId,
          recipientUserId,
          type: "ISSUE_OVERDUE",
          category: "update",
          title: "Issue overdue",
          message: `${issue.id} is overdue and still needs attention`,
          target: {
            type: "issue",
            id: issue.id,
            publicId: issue.id,
            url: `/issues/${issue.id}`,
          },
          metadata: {
            issueId: issue.id,
            issuePublicId: issue.id,
            entityId: issue.id,
            entityTitle: issue.title,
            workflowAutomation: "overdue",
            overdueDate: issue.dueDate?.toISOString().slice(0, 10) ?? null,
            url: `/issues/${issue.id}`,
          },
          eventId: `workflow-overdue:${issue.id}:${windowKey}`,
        }),
      );
    }),
  );
}

/**
 * Resolves GitHub PR automation targets for a specific project (falls back to the
 * workspace default if the project has no override).
 */
export async function getGithubAutomationTargets(workspaceId: string, projectId: string) {
  const { automation } = await getWorkflowContextForProject(workspaceId, projectId);
  return automation.githubPullRequest;
}
