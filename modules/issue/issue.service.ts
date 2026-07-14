import type { WorkspaceRole } from "../../app/generated/prisma/client.js";

import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { logActivity } from "../../shared/utils/activity.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import { emitIssueCreated, emitIssueDeleted, emitIssueUpdated } from "../../socket/events.js";
import { getSocketServer } from "../../socket/index.js";
import { createNotification } from "../notification/notification.service.js";
import { createIssueAttachments } from "./issue-attachment.service.js";
import { dispatchIntegrationEvent } from "../integration/dispatcher.js";
import { decrementStorageUsage } from "../billing/billing.service.js";
import { triggerIssueBackgroundJobs } from "../ai/ai.background.js";
import type {
  CheckAssignmentEligibilityInput,
  CreateIssueInput,
  ListIssuesQuery,
  UpdateIssueInput,
} from "./issue.schemas.js";

async function getWorkspaceStatuses(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { customStatuses: true },
  });
  return (workspace?.customStatuses as any[]) ?? [];
}

function isStatusFinal(statuses: any[], statusKey: string): boolean {
  return statuses.find((s) => s.key === statusKey)?.isFinal ?? false;
}

const priorityToDb: Record<string, string> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  urgent: "URGENT",
};

const priorityFromDb: Record<string, string> = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  URGENT: "urgent",
};

const typeToDb: Record<string, string> = {
  task: "TASK",
  bug: "BUG",
  issue: "ISSUE",
};

const typeFromDb: Record<string, string> = {
  TASK: "task",
  BUG: "bug",
  ISSUE: "issue",
};

const severityToDb: Record<string, string> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
};

const severityFromDb: Record<string, string> = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
};

function normalizeStoredIntegrationRefs(value: any) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value
      .filter((item) => item && typeof item === "object")
      .map((item: any) => ({
        id: String(item.id ?? ""),
        provider: item.provider,
        label: item.label ?? null,
        externalId: item.externalId ?? null,
        url: item.url ?? null,
      }))
      .filter((item: any) => item.id && item.provider);
  }

  if (typeof value === "object" && value.provider) {
    return [
      {
        id: String(value.id ?? "legacy-ref"),
        provider: value.provider,
        label: value.label ?? null,
        externalId: value.externalId ?? null,
        url: value.url ?? null,
      },
    ];
  }

  return [];
}

function normalizeLabelName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeLabelKey(value: string) {
  return normalizeLabelName(value).toLowerCase();
}

function parseDueTime(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value.length === 0) {
    return null;
  }

  const date = new Date(`1970-01-01T${value.length === 5 ? `${value}:00` : value}Z`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function formatDueTimeForActivity(value: Date | string | null | undefined) {
  if (!value) return null;

  if (typeof value === "string") {
    return value;
  }

  const hours = String(value.getUTCHours()).padStart(2, "0");
  const minutes = String(value.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function buildActorSummary(user: { id: string; name: string | null } | null | undefined) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name ?? "Unknown",
  };
}

function buildIssueActivityMetadata(
  issuePublicId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    issueId: issuePublicId,
    issuePublicId,
    entityId: issuePublicId,
    ...extra,
  };
}

function formatDueTime(value: Date | string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value.slice(0, 5);
  }

  const hours = String(value.getUTCHours()).padStart(2, "0");
  const minutes = String(value.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function getCompletedAtForStatusTransition(
  isFinalOld: boolean,
  isFinalNew: boolean,
  currentCompletedAt?: Date | null,
) {
  if (!isFinalOld && isFinalNew) {
    return new Date();
  }

  if (isFinalOld && !isFinalNew) {
    return null;
  }

  return currentCompletedAt;
}

export function mapIssue(record: any, includeRelations = true) {
  const labelObjects = (record.labels ?? []).map((labelLink: any) => ({
    id: labelLink.label.id,
    name: labelLink.label.name,
    color: labelLink.label.color,
  }));
  const labels = labelObjects.map((label: any) => label.name);
  const subtasks = (record.subtasks ?? []).map((subtask: any) => ({
    id: subtask.id,
    title: subtask.title,
    completed: subtask.completed,
    order: subtask.order,
  }));

  const attachments = (record.attachments ?? []).map((attachment: any) => ({
    id: attachment.id,
    key: attachment.key,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    size: attachment.size,
    kind: attachment.kind,
    assetUrl: attachment.assetUrl,
    createdAt: attachment.createdAt,
  }));

  const base = {
    id: record.id,
    entityId: record.internalId,
    title: record.title,
    description: record.description,
    type: typeFromDb[record.type] ?? "task",
    status: record.status ?? "backlog",
    priority: priorityFromDb[record.priority] ?? "medium",
    labels,
    labelObjects,
    dueDate: record.dueDate,
    dueTime: formatDueTime(record.dueTime),
    estimate: record.estimate ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    creatorId: record.creatorId,
    assigneeId: record.assigneeId,
    projectId: record.projectId,
    teamId: record.teamId,
    cycleId: record.cycleId ?? null,
    departmentId: record.departmentId,
    templateId: record.templateId ?? null,
    templateVersion: record.templateVersion ?? null,
    templateAppliedAt: record.templateAppliedAt ?? null,
    subtaskStats: {
      total: subtasks.length,
      completed: subtasks.filter((subtask: any) => subtask.completed).length,
    },
    attachmentCount: attachments.length,
  };

  if (!includeRelations) {
    return base;
  }

  return {
    ...base,
    creator: record.creator,
    assignee: record.assignee,
    project: record.project ? { id: record.project.id, name: record.project.name } : null,
    team: record.team ? { id: record.team.id, name: record.team.name } : null,
    cycle: record.cycle ? { id: record.cycle.id, name: record.cycle.name, status: record.cycle.status } : null,
    department: record.department
      ? { id: record.department.id, name: record.department.name, color: record.department.color }
      : null,
    subtasks,
    attachments,
    parent: record.parent
      ? {
          id: record.parent.id,
          title: record.parent.title,
          status: record.parent.status ?? "backlog",
        }
      : null,
    dependencies: Array.from(
      new Map(
        [
          ...(record.relationsFrom ?? []).map((relation: any) => ({
            issueId: relation.related?.id ?? relation.relatedId,
            relation: relation.type === "BLOCKS" ? "blocks" : relation.type === "BLOCKED_BY" ? "blocked-by" : "related",
            issue: relation.related
              ? {
                  id: relation.related.id,
                  title: relation.related.title,
                  status: relation.related.status ?? "backlog",
                }
              : null,
          })),
          ...(record.relationsTo ?? []).map((relation: any) => ({
            issueId: relation.issue?.id ?? relation.issueId,
            relation: relation.type === "BLOCKS" ? "blocked-by" : relation.type === "BLOCKED_BY" ? "blocks" : "related",
            issue: relation.issue
              ? {
                  id: relation.issue.id,
                  title: relation.issue.title,
                  status: relation.issue.status ?? "backlog",
                }
              : null,
          })),
        ].map((dependency: any) => [`${dependency.relation}:${dependency.issueId}`, dependency]),
      ).values(),
    ),
    watchers: (record.watchers ?? []).map((watcher: any) => ({
      id: watcher.user.id,
      name: watcher.user.name,
      email: watcher.user.email,
      avatar: watcher.user.avatar,
      role: watcher.user.workspaceMemberships?.[0]?.role ?? "MEMBER",
    })),
    integrationRef: record.integrationRef ?? null,
    integrationRefs: normalizeStoredIntegrationRefs(record.integrationRef),
    stepsToReproduce: record.stepsToReproduce,
    expectedBehavior: record.expectedBehavior,
    actualBehavior: record.actualBehavior,
    severity: record.severity ? (severityFromDb[record.severity] ?? null) : null,
    acceptanceCriteria: record.acceptanceCriteria,
    notes: record.notes,
  };
}

function getIssueOrderBy(sort: ListIssuesQuery["sort"]) {
  switch (sort) {
    case "createdAt:asc":
      return [{ createdAt: "asc" }, { id: "asc" }] as any;
    case "updatedAt:asc":
      return [{ updatedAt: "asc" }, { id: "asc" }] as any;
    case "dueDate:asc":
      return [{ dueDate: "asc" }, { id: "asc" }] as any;
    case "dueDate:desc":
      return [{ dueDate: "desc" }, { id: "desc" }] as any;
    case "createdAt:desc":
      return [{ createdAt: "desc" }, { id: "desc" }] as any;
    case "updatedAt:desc":
    default:
      return [{ updatedAt: "desc" }, { id: "desc" }] as any;
  }
}

function buildIssueWhere(workspaceId: string, workspaceRole: WorkspaceRole, userId: string, query: ListIssuesQuery) {
  const and: any[] = [];

  if (workspaceRole !== "OWNER" && workspaceRole !== "ADMIN") {
    and.push({
      OR: [
        { project: { visibility: "PUBLIC" } },
        { project: { leadId: userId } },
        { project: { memberships: { some: { userId } } } },
      ],
    });
  }

  if (query.q) {
    and.push({
      OR: [
        { id: { contains: query.q, mode: "insensitive" } },
        { title: { contains: query.q, mode: "insensitive" } },
        { description: { contains: query.q, mode: "insensitive" } },
      ],
    });
  }

  return {
    workspaceId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.priority ? { priority: priorityToDb[query.priority] ?? "MEDIUM" } : {}),
    ...(query.type ? { type: typeToDb[query.type] ?? "TASK" } : {}),
    ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.teamId ? { teamId: query.teamId } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.creatorId ? { creatorId: query.creatorId } : {}),
    ...(and.length > 0 ? { AND: and } : {}),
  };
}

async function assertIssueAccessible(workspaceId: string, workspaceRole: WorkspaceRole, userId: string, issueId: string) {
  const issue = await prisma.issue.findFirst({
    where: {
      id: issueId,
      workspaceId,
      ...(workspaceRole === "OWNER" || workspaceRole === "ADMIN"
        ? {}
        : {
            OR: [
              { project: { visibility: "PUBLIC" } },
              { project: { leadId: userId } },
              { project: { memberships: { some: { userId } } } },
            ],
          }),
    },
    select: { id: true },
  });

  if (!issue) {
    const existing = await prisma.issue.findFirst({
      where: { id: issueId, workspaceId },
      select: { id: true },
    });
    if (!existing) {
      throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
    }
    throw new AppError(404, ERROR_CODES.FORBIDDEN, "Issue is not visible");
  }
}

async function assertProjectInWorkspace(tx: any, workspaceId: string, projectId: string) {
  const project = await tx.project.findFirst({
    where: { id: projectId, workspaceId },
    select: { id: true, teamId: true, departmentId: true },
  });
  if (!project) {
    throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
  }
  return project;
}

async function assertCycleAssignable(tx: any, workspaceId: string, cycleId: string, teamId: string) {
  const cycle = await (tx as any).cycle.findFirst({
    where: { id: cycleId, workspaceId },
    select: { id: true, teamId: true, status: true },
  });

  if (!cycle) {
    throw new AppError(404, ERROR_CODES.CYCLE_NOT_FOUND, "Cycle not found");
  }

  if (cycle.teamId !== teamId) {
    throw new AppError(409, ERROR_CODES.CYCLE_TEAM_MISMATCH, "Selected cycle does not belong to this project's team");
  }

  if (cycle.status === "COMPLETED") {
    throw new AppError(409, ERROR_CODES.CYCLE_ASSIGN_COMPLETED_FORBIDDEN, "Completed cycles cannot accept new issues");
  }
}

async function assertAssigneeInWorkspace(tx: any, workspaceId: string, assigneeId: string) {
  const membership = await tx.workspaceMembership.findUnique({
    where: {
      userId_workspaceId: {
        userId: assigneeId,
        workspaceId,
      },
    },
    select: { id: true },
  });
  if (!membership) {
    throw new AppError(404, ERROR_CODES.ASSIGNEE_NOT_WORKSPACE_MEMBER, "Assignee is not a workspace member");
  }
}

async function assertAssigneeInProject(tx: any, projectId: string, assigneeId: string) {
  const membership = await (tx as any).projectMembership.findUnique({
    where: {
      projectId_userId: {
        projectId,
        userId: assigneeId,
      },
    },
    select: { userId: true },
  });

  if (!membership) {
    throw new AppError(
      409,
      ERROR_CODES.ASSIGNEE_NOT_PROJECT_MEMBER,
      "Assignee must be added to the project before this issue can be assigned",
    );
  }
}

async function getAssignmentEligibility(
  tx: any,
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  actorUserId: string,
  projectId: string,
  assigneeId: string,
) {
  const [project, workspaceMembership, projectMembership] = await Promise.all([
    tx.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { id: true, name: true, leadId: true },
    }),
    tx.workspaceMembership.findUnique({
      where: {
        userId_workspaceId: {
          userId: assigneeId,
          workspaceId,
        },
      },
      select: { userId: true },
    }),
    (tx as any).projectMembership.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId: assigneeId,
        },
      },
      select: { userId: true },
    }),
  ]);

  if (!project) {
    throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
  }

  return {
    projectId: project.id,
    projectName: project.name,
    workspaceMember: Boolean(workspaceMembership),
    projectMember: Boolean(projectMembership),
    canAutoAdd: workspaceRole === "OWNER" || workspaceRole === "ADMIN" || project.leadId === actorUserId,
  };
}

async function syncIssueLabels(tx: any, workspaceId: string, issueId: string, labels: string[] | undefined) {
  if (!labels) {
    return;
  }

  const uniqueNames = [...new Set(labels.map((label) => normalizeLabelName(label)).filter(Boolean))];

  await tx.issueLabel.deleteMany({ where: { issueId } });
  if (uniqueNames.length === 0) {
    return;
  }

  const createdLabels: Array<{ id: string }> = [];
  for (const name of uniqueNames) {
    const label = await tx.label.upsert({
      where: {
        workspaceId_normalizedName: {
          workspaceId,
          normalizedName: normalizeLabelKey(name),
        },
      },
      update: {},
      create: {
        workspaceId,
        name,
        normalizedName: normalizeLabelKey(name),
        color: "#6b7280",
      },
      select: { id: true },
    });
    createdLabels.push(label);
  }

  await tx.issueLabel.createMany({
    data: createdLabels.map((label) => ({ issueId, labelId: label.id })),
    skipDuplicates: true,
  });
}

async function syncRelatedIssues(tx: any, workspaceId: string, issueId: string, relatedIssueKeys: string[] | undefined) {
  if (!relatedIssueKeys) {
    return;
  }
  await tx.issueRelation.deleteMany({
    where: {
      issueId,
      type: "RELATED",
    },
  });

  const uniqueKeys = [...new Set(relatedIssueKeys)];
  for (const relatedId of uniqueKeys) {
    if (relatedId === issueId) {
      continue;
    }
    const exists = await tx.issue.findFirst({
      where: { id: relatedId, workspaceId },
      select: { id: true },
    });
    if (!exists) {
      throw new AppError(404, ERROR_CODES.INVALID_RELATED_ISSUE, `Related issue ${relatedId} not found`);
    }
    await tx.issueRelation.create({
      data: {
        issueId,
        relatedId,
        type: "RELATED" as any,
      },
    });
  }
}

function validateTypeSpecific(input: CreateIssueInput | UpdateIssueInput, currentType?: string) {
  const nextType = ("type" in input && input.type ? input.type : currentType ? typeFromDb[currentType] : null);
  const isUpdate = Boolean(currentType);
  const currentTypeKey = currentType ? typeFromDb[currentType] : null;
  const isTypeTransition = isUpdate && Boolean(nextType && currentTypeKey && nextType !== currentTypeKey);

  if (nextType === "bug") {
    const steps = "stepsToReproduce" in input ? input.stepsToReproduce : undefined;
    const expected = "expectedBehavior" in input ? input.expectedBehavior : undefined;
    const actual = "actualBehavior" in input ? input.actualBehavior : undefined;
    const severity = "severity" in input ? input.severity : undefined;

    // For PATCH updates, enforce required bug fields only when switching to BUG.
    // Existing BUG issues can be updated partially without resending all bug fields.
    const mustValidate = !isUpdate || isTypeTransition;
    if (mustValidate && (!steps || !expected || !actual || !severity)) {
      throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "BUG issues require reproduction, expected, actual, and severity");
    }
  }

  if (nextType === "issue") {
    const acceptance = "acceptanceCriteria" in input ? input.acceptanceCriteria : undefined;

    // For PATCH updates, enforce acceptance criteria only when switching to ISSUE.
    // Existing ISSUE issues can be updated partially without resending acceptanceCriteria.
    const mustValidate = !isUpdate || isTypeTransition;
    if (mustValidate && !acceptance) {
      throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "ISSUE type requires acceptanceCriteria");
    }
  }
}

export async function createIssue(workspaceId: string, creatorId: string, input: CreateIssueInput) {
  const mapped = await prisma.$transaction(async (tx) => {
    let template: any = null;
    if ((input as any).templateId) {
      template = await (tx as any).template.findFirst({
        where: { id: (input as any).templateId, workspaceId, deletedAt: null },
        select: {
          id: true,
          activeVersion: true,
          issueType: true,
          defaultPriority: true,
          defaultStatus: true,
          defaultAssigneeId: true,
          defaultEstimate: true,
          defaultDueDateOffset: true,
          defaultSeverity: true,
          contentTemplate: true,
          titleTemplate: true,
          acceptanceCriteriaTemplate: true,
          stepsToReproduceTemplate: true,
          expectedBehaviorTemplate: true,
          actualBehaviorTemplate: true,
          notesTemplate: true,
          checklistItems: true,
          defaultLabelIds: true,
        },
      });
      if (!template) {
        throw new AppError(404, ERROR_CODES.TEMPLATE_NOT_FOUND, "Template not found");
      }
    }

    const normalizedInput = {
      ...input,
      type: template?.issueType ?? input.type,
      priority: template?.defaultPriority ?? input.priority,
      status: input.status ?? template?.defaultStatus ?? "backlog",
      title: input.title || template?.titleTemplate || input.title,
      description: input.description ?? template?.contentTemplate ?? null,
      assigneeId: input.assigneeId ?? template?.defaultAssigneeId ?? null,
      estimate: input.estimate ?? template?.defaultEstimate ?? null,
      severity: input.severity ?? template?.defaultSeverity ?? undefined,
      acceptanceCriteria: input.acceptanceCriteria ?? template?.acceptanceCriteriaTemplate ?? undefined,
      stepsToReproduce: input.stepsToReproduce ?? template?.stepsToReproduceTemplate ?? undefined,
      expectedBehavior: input.expectedBehavior ?? template?.expectedBehaviorTemplate ?? undefined,
      actualBehavior: input.actualBehavior ?? template?.actualBehaviorTemplate ?? undefined,
      notes: input.notes ?? template?.notesTemplate ?? undefined,
      labels: (input.labels && input.labels.length > 0) ? input.labels : undefined,
      subtasks: (input.subtasks && input.subtasks.length > 0)
        ? input.subtasks
        : (template?.checklistItems ?? []).map((title: string, index: number) => ({ title, order: index })),
      dueDate: input.dueDate ?? (template?.defaultDueDateOffset !== null && template?.defaultDueDateOffset !== undefined
        ? new Date(Date.now() + template.defaultDueDateOffset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        : undefined),
    } as CreateIssueInput;

    validateTypeSpecific(normalizedInput);

    const workspaceStatuses = await getWorkspaceStatuses(workspaceId);
    const resolvedStatus = normalizedInput.status ?? "backlog";
    if (!workspaceStatuses.some((s: any) => s.key === resolvedStatus)) {
      throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, `Invalid status: ${resolvedStatus}`);
    }
    const isFinalStatus = isStatusFinal(workspaceStatuses, resolvedStatus);

    const project = await assertProjectInWorkspace(tx, workspaceId, input.projectId);
    if (input.cycleId) {
      await assertCycleAssignable(tx, workspaceId, input.cycleId, project.teamId);
    }
    if (normalizedInput.assigneeId) {
      await assertAssigneeInWorkspace(tx, workspaceId, normalizedInput.assigneeId);
      await assertAssigneeInProject(tx, input.projectId, normalizedInput.assigneeId);
    }

    if (input.parentIssueId) {
      const parent = await tx.issue.findFirst({
        where: { id: input.parentIssueId, workspaceId },
        select: { id: true },
      });
      if (!parent) {
        throw new AppError(404, ERROR_CODES.PARENT_ISSUE_NOT_FOUND, "Parent issue not found");
      }
    }

    const workspace = await tx.workspace.update({
      where: { id: workspaceId },
      data: { issueCounter: { increment: 1 } },
      select: { issueCounter: true, issuePrefix: true },
    });

    const issueId = `${workspace.issuePrefix}-${workspace.issueCounter}`;
    const issue = await tx.issue.create({
      data: {
        id: issueId,
        number: workspace.issueCounter,
        workspaceId,
        projectId: input.projectId,
        teamId: project.teamId,
        cycleId: input.cycleId ?? null,
        departmentId: project.departmentId ?? null,
        title: normalizedInput.title,
        description: normalizedInput.description ?? null,
        type: typeToDb[normalizedInput.type],
        status: normalizedInput.status ?? "backlog",
        priority: priorityToDb[normalizedInput.priority],
        assigneeId: normalizedInput.assigneeId ?? null,
        creatorId,
        dueDate: normalizedInput.dueDate ? new Date(normalizedInput.dueDate) : null,
        dueTime: parseDueTime(normalizedInput.dueTime),
        estimate: normalizedInput.estimate ?? null,
        stepsToReproduce: normalizedInput.stepsToReproduce ?? null,
        expectedBehavior: normalizedInput.expectedBehavior ?? null,
        actualBehavior: normalizedInput.actualBehavior ?? null,
        severity: normalizedInput.severity ? severityToDb[normalizedInput.severity] : null,
        acceptanceCriteria: normalizedInput.acceptanceCriteria ?? null,
        notes: normalizedInput.notes ?? null,
        parentIssueId: input.parentIssueId ?? null,
        templateId: template?.id ?? null,
        templateVersion: template?.activeVersion ?? null,
        templateAppliedAt: template ? new Date() : null,
        completedAt: isFinalStatus ? new Date() : null,
      } as any,
      select: { id: true },
    });

    if (normalizedInput.subtasks && normalizedInput.subtasks.length > 0) {
      await tx.issueSubtask.createMany({
        data: normalizedInput.subtasks.map((subtask, index) => ({
          issueId: issue.id,
          title: subtask.title,
          order: subtask.order ?? index,
        })),
      });
    }

    await syncIssueLabels(tx, workspaceId, issue.id, normalizedInput.labels);
    if ((!input.labels || input.labels.length === 0) && template?.defaultLabelIds?.length > 0) {
      const existingLabels = await tx.label.findMany({
        where: { workspaceId, id: { in: template.defaultLabelIds } },
        select: { id: true },
      });
      if (existingLabels.length > 0) {
        await tx.issueLabel.createMany({
          data: existingLabels.map((label: { id: string }) => ({ issueId: issue.id, labelId: label.id })),
          skipDuplicates: true,
        });
      }
    }
    await syncRelatedIssues(tx, workspaceId, issue.id, normalizedInput.relatedIssueKeys);

    if (input.attachments && input.attachments.length > 0) {
      await createIssueAttachments(tx, issue.id, workspaceId, creatorId, input.attachments);
    }

    const created = await tx.issue.findUnique({
      where: { id: issue.id },
      include: {
        creator: { select: { id: true, name: true, email: true, avatar: true } },
        assignee: { select: { id: true, name: true, email: true, avatar: true } },
        project: { select: { id: true, name: true } },
        team: { select: { id: true, name: true } },
        cycle: { select: { id: true, name: true, status: true } },
        department: { select: { id: true, name: true, color: true } },
        subtasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] },
        labels: { include: { label: { select: { id: true, name: true, color: true } } } },
        attachments: { orderBy: [{ createdAt: "desc" }] },
        parent: { select: { id: true, title: true, status: true } },
        relationsFrom: { include: { related: { select: { id: true, title: true, status: true } } } },
        relationsTo: { include: { issue: { select: { id: true, title: true, status: true } } } },
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

    if (!created) {
      throw new AppError(500, ERROR_CODES.INTERNAL_ERROR, "Failed to load created issue");
    }

    const mapped = mapIssue(created);
    await logActivity({
      workspaceId,
      actorId: creatorId,
      type: "ISSUE_CREATED",
      targetType: "ISSUE",
      targetId: issue.id,
      message: `Issue ${issue.id} created`,
      metadata: {
        entityId: issue.id,
        entityTitle: normalizedInput.title,
        issueId: issue.id,
        projectId: input.projectId,
        teamId: project.teamId,
        templateId: template?.id ?? null,
        templateVersion: template?.activeVersion ?? null,
      },
    });

    // If issue is created with an assignee, emit assignment notification immediately.
    if (created.assigneeId) {
      const issuePublicId = created.id;
      await createNotification({
        workspaceId,
        recipientUserId: created.assigneeId,
        actorUserId: creatorId,
        type: "ASSIGNMENT",
        category: "assignment",
        title: "New issue assignment",
        message: `You were assigned issue ${issuePublicId}`,
        target: {
          type: "issue",
          id: created.id,
          publicId: issuePublicId,
          url: `/issues/${issuePublicId}`,
        },
        metadata: {
          issueId: created.id,
          fromAssignee: null,
          toAssignee: created.assigneeId,
          workspaceId,
          entityId: created.id,
          entityTitle: created.title,
          url: `/issues/${issuePublicId}`,
        },
        eventId: `issue-assignment:create:${created.id}:${created.assigneeId}`,
      });
    }

    const io = getSocketServer();
    if (io) {
      emitIssueCreated(io, workspaceId, {
        issueId: created.id,
        publicId: created.id,
        full: mapped,
      });
    }

    // Integrations: notify on high/urgent issue creation (fire-and-forget)
    dispatchIntegrationEvent(workspaceId, {
      type: "issue.created",
      payload: {
        id: created.id,
        title: created.title,
        priority: normalizedInput.priority,
        status: normalizedInput.status ?? "backlog",
        projectId: created.projectId,
        teamId: created.teamId,
        assigneeName: created.assignee?.name,
        assigneeEmail: created.assignee?.email,
        creatorName: created.creator?.name ?? "Unknown",
        projectName: created.project?.name,
      },
    }).catch(() => {});

    return mapped;
  });

  await triggerIssueBackgroundJobs({
    workspaceId,
    issueId: mapped.id,
    triggeredByUserId: creatorId,
    reason: "created",
  });

  return mapped;
}

export async function checkAssignmentEligibility(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  actorUserId: string,
  input: CheckAssignmentEligibilityInput,
) {
  return prisma.$transaction(async (tx) =>
    getAssignmentEligibility(
      tx,
      workspaceId,
      workspaceRole,
      actorUserId,
      input.projectId,
      input.assigneeId,
    ),
  );
}

export async function resolveIssueRouteId(workspaceId: string, issueIdentifier: string) {
  const byPublicId = await prisma.issue.findFirst({
    where: { id: issueIdentifier, workspaceId },
    select: { id: true },
  });

  if (byPublicId) {
    return byPublicId.id;
  }

  const byEntityId = await prisma.issue.findFirst({
    where: { internalId: issueIdentifier, workspaceId },
    select: { id: true },
  });

  if (byEntityId) {
    return byEntityId.id;
  }

  throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
}

export async function listIssues(workspaceId: string, workspaceRole: WorkspaceRole, userId: string, query: ListIssuesQuery) {
  const limit = clampListLimit(query.limit);
  const where = buildIssueWhere(workspaceId, workspaceRole, userId, query);
  const orderBy = getIssueOrderBy(query.sort);

  const [total, records] = await Promise.all([
    prisma.issue.count({ where: where as any }),
    prisma.issue.findMany({
      where,
      orderBy: orderBy as any,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: limit + 1,
      include: query.view === "compact"
        ? undefined
        : {
            creator: { select: { id: true, name: true, email: true, avatar: true } },
            assignee: { select: { id: true, name: true, email: true, avatar: true } },
            project: { select: { id: true, name: true } },
            team: { select: { id: true, name: true } },
            cycle: { select: { id: true, name: true, status: true } },
            department: { select: { id: true, name: true, color: true } },
            labels: { include: { label: { select: { id: true, name: true, color: true } } } },
            subtasks: { select: { id: true, completed: true, order: true, title: true } },
            attachments: { select: { id: true } },
          },
      select: query.view === "compact"
        ? {
            id: true,
            title: true,
            status: true,
            projectId: true,
          }
        : undefined,
    } as any),
  ]);

  const page = slicePage(records as any[], limit);
  const items = query.view === "compact"
    ? page.items.map((record: any) => ({
        id: record.id,
        title: record.title,
        status: record.status ?? "backlog",
        projectId: record.projectId,
      }))
    : page.items.map((record: any) => mapIssue(record, true));

  return {
    items,
    meta: {
      total,
      cursor: page.hasMore ? page.items[page.items.length - 1]?.id ?? null : null,
      hasMore: page.hasMore,
    },
  };
}

export async function getIssueById(workspaceId: string, workspaceRole: WorkspaceRole, userId: string, issueId: string) {
  await assertIssueAccessible(workspaceId, workspaceRole, userId, issueId);

  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    include: {
      creator: { select: { id: true, name: true, email: true, avatar: true } },
      assignee: { select: { id: true, name: true, email: true, avatar: true } },
      project: { select: { id: true, name: true } },
      team: { select: { id: true, name: true } },
      cycle: { select: { id: true, name: true, status: true } },
      department: { select: { id: true, name: true, color: true } },
      subtasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] },
      labels: { include: { label: { select: { id: true, name: true, color: true } } } },
      attachments: { orderBy: [{ createdAt: "desc" }] },
      parent: { select: { id: true, title: true, status: true } },
      relationsFrom: { include: { related: { select: { id: true, title: true, status: true } } } },
      relationsTo: { include: { issue: { select: { id: true, title: true, status: true } } } },
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

  if (!issue) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }

  return mapIssue(issue, true);
}

export async function updateIssue(workspaceId: string, issueId: string, actorUserId: string, input: UpdateIssueInput) {
  const mapped = await prisma.$transaction(async (tx) => {
    const current = await tx.issue.findFirst({
      where: { id: issueId, workspaceId },
      select: {
        id: true,
        title: true,
        description: true,
        type: true,
        status: true,
        priority: true,
        assigneeId: true,
        dueDate: true,
        dueTime: true,
        estimate: true,
        parentIssueId: true,
        projectId: true,
        teamId: true,
        creatorId: true,
        cycleId: true,
        completedAt: true,
        assignee: { select: { id: true, name: true } },
        parent: { select: { id: true, title: true } },
        project: { select: { id: true, name: true } },
        team: { select: { id: true, name: true } },
        labels: {
          include: {
            label: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!current) {
      throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
    }

    validateTypeSpecific(input, current.type);

    if (input.assigneeId) {
      await assertAssigneeInWorkspace(tx, workspaceId, input.assigneeId);
      await assertAssigneeInProject(tx, current.projectId, input.assigneeId);
    }

    if (input.parentIssueId !== undefined && input.parentIssueId !== null) {
      if (input.parentIssueId === issueId) {
        throw new AppError(409, ERROR_CODES.INVALID_PARENT_ISSUE, "Issue cannot be its own parent");
      }
      const parent = await tx.issue.findFirst({
        where: { id: input.parentIssueId, workspaceId },
        select: { id: true, parentIssueId: true },
      });
      if (!parent) {
        throw new AppError(404, ERROR_CODES.PARENT_ISSUE_NOT_FOUND, "Parent issue not found");
      }
      if (parent.parentIssueId === issueId) {
        throw new AppError(409, ERROR_CODES.ISSUE_CYCLE_DETECTED, "Parent linkage cycle detected");
      }
    }

    const nextStatus = input.status !== undefined ? input.status : current.status;
    let nextCompletedAt: Date | null | undefined = current.completedAt;
    if (input.status !== undefined) {
      const statuses = await getWorkspaceStatuses(workspaceId);
      if (!statuses.some((s: any) => s.key === nextStatus)) {
        throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, `Invalid status: ${nextStatus}`);
      }
      const isFinalOld = isStatusFinal(statuses, current.status);
      const isFinalNew = isStatusFinal(statuses, nextStatus);
      nextCompletedAt = getCompletedAtForStatusTransition(isFinalOld, isFinalNew, current.completedAt);
    }

    await tx.issue.update({
      where: { id: issueId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.type !== undefined ? { type: typeToDb[input.type] as any } : {}),
        ...(input.priority !== undefined ? { priority: priorityToDb[input.priority] as any } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.status !== undefined ? { completedAt: nextCompletedAt } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate ? new Date(input.dueDate) : null } : {}),
        ...(input.dueTime !== undefined ? { dueTime: parseDueTime(input.dueTime) } : {}),
        ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
        ...(input.stepsToReproduce !== undefined ? { stepsToReproduce: input.stepsToReproduce } : {}),
        ...(input.expectedBehavior !== undefined ? { expectedBehavior: input.expectedBehavior } : {}),
        ...(input.actualBehavior !== undefined ? { actualBehavior: input.actualBehavior } : {}),
        ...(input.severity !== undefined ? { severity: input.severity ? severityToDb[input.severity] as any : null } : {}),
        ...(input.acceptanceCriteria !== undefined ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.parentIssueId !== undefined ? { parentIssueId: input.parentIssueId } : {}),
      } as any,
    });

    await syncIssueLabels(tx, workspaceId, issueId, input.labels);
    await syncRelatedIssues(tx, workspaceId, issueId, input.relatedIssueKeys);

    if (input.attachments && input.attachments.length > 0) {
      const existing = await (tx as any).issueAttachment.findMany({
        where: { issueId },
        select: { key: true },
      });
      const existingKeys = new Set(existing.map((row: any) => row.key));
      const toAdd = input.attachments.filter((attachment) => !existingKeys.has(attachment.key));
      await createIssueAttachments(tx, issueId, workspaceId, current.id, toAdd);
    }

    const updated = await tx.issue.findFirst({
      where: { id: issueId, workspaceId },
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
        relationsTo: { include: { issue: { select: { id: true, title: true, status: true } } } },
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

    const issuePublicId = updated?.id ?? current.id;

    if (input.title !== undefined && input.title !== current.title) {
      await logActivity({
        workspaceId,
        actorId: actorUserId,
        type: "ISSUE_TITLE_CHANGED",
        targetType: "ISSUE",
        targetId: issueId,
        message: `Issue ${issuePublicId} title changed`,
        metadata: buildIssueActivityMetadata(issuePublicId, {
          entityTitle: updated?.title ?? input.title,
          fromTitle: current.title,
          toTitle: updated?.title ?? input.title,
          cycleId: current.cycleId ?? null,
        }),
      });
    }

    if (input.description !== undefined && input.description !== current.description) {
      await logActivity({
        workspaceId,
        actorId: actorUserId,
        type: "ISSUE_DESCRIPTION_CHANGED",
        targetType: "ISSUE",
        targetId: issueId,
        message: `Issue ${issuePublicId} description changed`,
        metadata: buildIssueActivityMetadata(issuePublicId, {
          entityTitle: updated?.title ?? current.title,
          cycleId: current.cycleId ?? null,
        }),
      });
    }

    if (input.type !== undefined && typeToDb[input.type] !== current.type) {
      await logActivity({
        workspaceId,
        actorId: actorUserId,
        type: "ISSUE_TYPE_CHANGED",
        targetType: "ISSUE",
        targetId: issueId,
        message: `Issue ${issuePublicId} type changed`,
        metadata: buildIssueActivityMetadata(issuePublicId, {
          entityTitle: updated?.title ?? current.title,
          fromType: typeFromDb[current.type],
          toType: input.type,
          cycleId: current.cycleId ?? null,
        }),
      });
    }
    if (input.status !== undefined && input.status !== current.status) {
      await logActivity({
        workspaceId,
        actorId: actorUserId,
        type: "ISSUE_STATUS_CHANGED",
        targetType: "ISSUE",
        targetId: issueId,
        message: `Issue ${issuePublicId} status changed`,
        metadata: buildIssueActivityMetadata(issuePublicId, {
          entityTitle: updated?.title ?? current.title,
          fromStatus: current.status,
          toStatus: input.status,
          cycleId: current.cycleId ?? null,
        }),
      });
    }
    if (input.priority !== undefined && priorityToDb[input.priority] !== current.priority) {
      await logActivity({
        workspaceId,
        actorId: actorUserId,
        type: "ISSUE_PRIORITY_CHANGED",
        targetType: "ISSUE",
        targetId: issueId,
        message: `Issue ${issuePublicId} priority changed`,
        metadata: buildIssueActivityMetadata(issuePublicId, {
          entityTitle: updated?.title ?? current.title,
          fromPriority: priorityFromDb[current.priority],
          toPriority: input.priority,
          cycleId: current.cycleId ?? null,
        }),
      });
    }
    if (input.assigneeId !== undefined && input.assigneeId !== current.assigneeId) {
      await logActivity({
        workspaceId,
        actorId: actorUserId,
        type: "ISSUE_ASSIGNEE_CHANGED",
        targetType: "ISSUE",
        targetId: issueId,
        message: `Issue ${issuePublicId} assignee changed`,
        metadata: buildIssueActivityMetadata(issuePublicId, {
          entityTitle: updated?.title ?? current.title,
          fromAssigneeId: current.assigneeId,
          toAssigneeId: input.assigneeId ?? null,
          fromAssignee: buildActorSummary(current.assignee),
          toAssignee: buildActorSummary(updated?.assignee),
          cycleId: current.cycleId ?? null,
        }),
      });
    }
    if (input.dueDate !== undefined) {
      const before = current.dueDate ? current.dueDate.toISOString().slice(0, 10) : null;
      const after = input.dueDate ?? null;
      if (before !== after) {
        await logActivity({
          workspaceId,
          actorId: actorUserId,
          type: "ISSUE_DUE_DATE_CHANGED",
          targetType: "ISSUE",
          targetId: issueId,
          message: `Issue ${issuePublicId} due date changed`,
          metadata: buildIssueActivityMetadata(issuePublicId, {
            entityTitle: updated?.title ?? current.title,
            fromDueDate: before,
            toDueDate: after,
            cycleId: current.cycleId ?? null,
          }),
        });
      }
    }

    if (input.dueTime !== undefined) {
      const before = formatDueTimeForActivity(current.dueTime);
      const after = formatDueTimeForActivity(parseDueTime(input.dueTime));
      if (before !== after) {
        await logActivity({
          workspaceId,
          actorId: actorUserId,
          type: "ISSUE_DUE_TIME_CHANGED",
          targetType: "ISSUE",
          targetId: issueId,
          message: `Issue ${issuePublicId} due time changed`,
          metadata: buildIssueActivityMetadata(issuePublicId, {
            entityTitle: updated?.title ?? current.title,
            fromDueTime: before,
            toDueTime: after,
            cycleId: current.cycleId ?? null,
          }),
        });
      }
    }

    if (input.estimate !== undefined && input.estimate !== current.estimate) {
      await logActivity({
        workspaceId,
        actorId: actorUserId,
        type: "ISSUE_ESTIMATE_CHANGED",
        targetType: "ISSUE",
        targetId: issueId,
        message: `Issue ${issuePublicId} estimate changed`,
        metadata: buildIssueActivityMetadata(issuePublicId, {
          entityTitle: updated?.title ?? current.title,
          fromEstimate: current.estimate ?? null,
          toEstimate: input.estimate ?? null,
          cycleId: current.cycleId ?? null,
        }),
      });
    }

    if (input.parentIssueId !== undefined && input.parentIssueId !== current.parentIssueId) {
      await logActivity({
        workspaceId,
        actorId: actorUserId,
        type: "ISSUE_PARENT_CHANGED",
        targetType: "ISSUE",
        targetId: issueId,
        message: `Issue ${issuePublicId} parent issue changed`,
        metadata: buildIssueActivityMetadata(issuePublicId, {
          entityTitle: updated?.title ?? current.title,
          fromParent: current.parent ? { id: current.parent.id, title: current.parent.title } : null,
          toParent: updated?.parent ? { id: updated.parent.id, title: updated.parent.title } : null,
          cycleId: current.cycleId ?? null,
        }),
      });
    }

    if (input.labels !== undefined) {
      const beforeLabels = current.labels.map((item) => item.label.name).sort();
      const afterLabels = (updated?.labels ?? []).map((item: any) => item.label.name).sort();
      if (JSON.stringify(beforeLabels) !== JSON.stringify(afterLabels)) {
        await logActivity({
          workspaceId,
          actorId: actorUserId,
          type: "ISSUE_LABELS_CHANGED",
          targetType: "ISSUE",
          targetId: issueId,
          message: `Issue ${issuePublicId} labels updated`,
          metadata: buildIssueActivityMetadata(issuePublicId, {
            entityTitle: updated?.title ?? current.title,
            previousLabels: beforeLabels,
            labels: afterLabels,
            cycleId: current.cycleId ?? null,
          }),
        });
      }
    }

    if (updated && (updated.projectId !== current.projectId || updated.teamId !== current.teamId)) {
      await logActivity({
        workspaceId,
        actorId: actorUserId,
        type: "ISSUE_SCOPE_CHANGED",
        targetType: "ISSUE",
        targetId: issueId,
        message: `Issue ${issuePublicId} scope changed`,
        metadata: buildIssueActivityMetadata(issuePublicId, {
          entityTitle: updated?.title ?? current.title,
          fromProjectId: current.projectId,
          toProjectId: updated?.projectId,
          fromProject: current.project ? { id: current.project.id, name: current.project.name } : null,
          toProject: updated?.project ? { id: updated.project.id, name: updated.project.name } : null,
          fromTeamId: current.teamId,
          toTeamId: updated?.teamId,
          fromTeam: current.team ? { id: current.team.id, name: current.team.name } : null,
          toTeam: updated?.team ? { id: updated.team.id, name: updated.team.name } : null,
          cycleId: current.cycleId ?? null,
        }),
      });
    }

    if (updated) {
      if (input.assigneeId !== undefined && input.assigneeId !== current.assigneeId && input.assigneeId) {
        await createNotification({
          workspaceId,
          recipientUserId: input.assigneeId,
          actorUserId,
          type: "ASSIGNMENT",
          category: "assignment",
          title: "New issue assignment",
          message: `You were assigned issue ${issuePublicId}`,
          target: {
            type: "issue",
            id: issueId,
            publicId: issuePublicId,
            url: `/issues/${issuePublicId}`,
          },
          metadata: {
            issueId,
            fromAssignee: current.assigneeId,
            toAssignee: input.assigneeId,
            workspaceId,
            entityId: issueId,
            entityTitle: updated.title,
            url: `/issues/${issuePublicId}`,
          },
          eventId: `issue-assignment:${issueId}:${input.assigneeId}:${updated.updatedAt.toISOString()}`,
        });

        // Slack: DM new assignee + channel notification (fire-and-forget)
        const newAssignee = await prisma.user.findUnique({
          where: { id: input.assigneeId },
          select: { name: true, email: true },
        });
        const actor = await prisma.user.findUnique({
          where: { id: actorUserId },
          select: { name: true },
        });
        dispatchIntegrationEvent(workspaceId, {
          type: "issue.assigned",
          payload: {
            id: issueId,
            title: updated.title,
            assigneeName: newAssignee?.name ?? "Unknown",
            assigneeEmail: newAssignee?.email,
            assignedByName: actor?.name ?? "Unknown",
            priority: priorityFromDb[updated.priority] ?? "medium",
            projectId: updated.projectId,
            teamId: updated.teamId,
            projectName: updated.project?.name,
          },
        }).catch(() => {});
      }

      const recipientSet = new Set<string>();
      if (updated.assigneeId) recipientSet.add(updated.assigneeId);
      if (updated.creatorId) recipientSet.add(updated.creatorId);
      for (const watcher of updated.watchers ?? []) {
        if (watcher?.user?.id) recipientSet.add(watcher.user.id);
      }

      const changedFields: Array<{ field: string; from: unknown; to: unknown }> = [];
      if (input.status !== undefined && input.status !== current.status) {
        changedFields.push({ field: "status", from: current.status, to: input.status });
      }
      if (input.priority !== undefined && priorityToDb[input.priority] !== current.priority) {
        changedFields.push({ field: "priority", from: priorityFromDb[current.priority], to: input.priority });
      }
      if (input.dueDate !== undefined) {
        const before = current.dueDate ? current.dueDate.toISOString().slice(0, 10) : null;
        const after = input.dueDate ?? null;
        if (before !== after) changedFields.push({ field: "dueDate", from: before, to: after });
      }

      await Promise.all(changedFields.flatMap((change) => [...recipientSet].map((recipientUserId) => createNotification({
        workspaceId,
        recipientUserId,
        actorUserId,
        type: "UPDATE",
        category: "update",
        title: "Issue updated",
        message: `${updated.title} ${change.field} changed`,
        target: {
          type: "issue",
          id: issueId,
          publicId: issuePublicId,
          url: `/issues/${issuePublicId}`,
        },
        metadata: {
          issueId,
          field: change.field,
          from: change.from,
          to: change.to,
          workspaceId,
          entityId: issueId,
          entityTitle: updated.title,
          url: `/issues/${issuePublicId}`,
        },
        eventId: `issue-update:${issueId}:${change.field}:${updated.updatedAt.toISOString()}:${recipientUserId}`,
      }))));
    }

    if (!updated) {
      throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
    }

    const mapped = mapIssue(updated, true);
    const io = getSocketServer();
    if (io) {
      emitIssueUpdated(io, workspaceId, {
        issueId,
        publicId: updated.id,
        full: mapped,
      });
    }

    // Integrations: notify on completion via updateIssue (fire-and-forget)
    if (input.status && input.status !== current.status && nextCompletedAt instanceof Date && !current.completedAt) {
      const actor = await prisma.user.findUnique({ where: { id: actorUserId }, select: { name: true } });
      const completePayload = {
        id: issueId,
        title: updated.title,
        completedByName: actor?.name ?? "Unknown",
        projectId: updated.projectId,
        teamId: updated.teamId,
        projectName: updated.project?.name,
      };
      dispatchIntegrationEvent(workspaceId, { type: "issue.completed", payload: completePayload }).catch(() => {});
    }

    return mapped;
  });

  const shouldTriggerBackground = [
    input.title,
    input.description,
    input.status,
    input.priority,
    input.assigneeId,
    input.labels,
    input.relatedIssueKeys,
  ].some((value) => value !== undefined);

  if (shouldTriggerBackground) {
    await triggerIssueBackgroundJobs({
      workspaceId,
      issueId: mapped.id,
      triggeredByUserId: actorUserId,
      reason: "updated",
    });
  }

  return mapped;
}

export async function updateIssueStatus(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  userId: string,
  issueId: string,
  status: string,
) {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: { id: true, status: true, cycleId: true, completedAt: true },
  });
  if (!issue) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }

  const nextStatus = status;
  const statuses = await getWorkspaceStatuses(workspaceId);
  if (!statuses.some((s: any) => s.key === nextStatus)) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, `Invalid status: ${nextStatus}`);
  }
  const isFinalOld = isStatusFinal(statuses, issue.status);
  const isFinalNew = isStatusFinal(statuses, nextStatus);
  const nextCompletedAt = getCompletedAtForStatusTransition(isFinalOld, isFinalNew, issue.completedAt);
  const updateData: Record<string, unknown> = { status: nextStatus };
  if (nextCompletedAt !== undefined) {
    updateData.completedAt = nextCompletedAt;
  }

  await prisma.issue.update({
    where: { id: issueId },
    data: updateData as any,
  });
  if (nextStatus !== issue.status) {
    await logActivity({
      workspaceId,
      actorId: userId,
      type: "ISSUE_STATUS_CHANGED",
      targetType: "ISSUE",
      targetId: issueId,
      message: `Issue ${issueId} status changed`,
      metadata: {
        entityId: issueId,
        fromStatus: issue.status,
        toStatus: status,
        cycleId: issue.cycleId ?? null,
      },
    });

    const updated = await prisma.issue.findFirst({
      where: { id: issueId, workspaceId },
      select: {
        id: true,
        internalId: true,
        title: true,
        creatorId: true,
        assigneeId: true,
        watchers: { select: { userId: true } },
      },
    });

    if (updated) {
      const issuePublicId = updated.id;
      const recipients = new Set<string>();
      if (updated.assigneeId) recipients.add(updated.assigneeId);
      if (updated.creatorId) recipients.add(updated.creatorId);
      for (const watcher of updated.watchers) recipients.add(watcher.userId);

      await Promise.all([...recipients].map((recipientUserId) => createNotification({
        workspaceId,
        recipientUserId,
        actorUserId: userId,
        type: "UPDATE",
        category: "update",
        title: "Issue updated",
        message: `${updated.title} status changed`,
        target: {
          type: "issue",
          id: updated.id,
          publicId: issuePublicId,
          url: `/issues/${issuePublicId}`,
        },
        metadata: {
          issueId: updated.id,
          field: "status",
          from: issue.status,
          to: status,
          workspaceId,
          entityId: updated.id,
          entityTitle: updated.title,
          url: `/issues/${issuePublicId}`,
        },
        eventId: `issue-update:${updated.id}:status:${new Date().toISOString()}:${recipientUserId}`,
      })));
    }
  }

  const resolved = await getIssueById(workspaceId, workspaceRole, userId, issueId);
  const io = getSocketServer();
  if (io) {
    emitIssueUpdated(io, workspaceId, {
      issueId,
      publicId: (resolved as any)?.id ?? issueId,
      full: resolved,
    });
  }

  // Integrations: notify channel when issue is completed (fire-and-forget)
  if (isFinalNew && !isFinalOld) {
    const actor = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    const issueData = await prisma.issue.findFirst({
      where: { id: issueId },
      select: { projectId: true, teamId: true, project: { select: { name: true } } },
    });
    const completePayload = {
      id: issueId,
      title: (resolved as any)?.title ?? issueId,
      completedByName: actor?.name ?? "Unknown",
      projectId: issueData?.projectId,
      teamId: issueData?.teamId,
      projectName: issueData?.project?.name,
    };
    dispatchIntegrationEvent(workspaceId, { type: "issue.completed", payload: completePayload }).catch(() => {});
  }

  if (nextStatus !== issue.status) {
    await triggerIssueBackgroundJobs({
      workspaceId,
      issueId,
      triggeredByUserId: userId,
      reason: "updated",
    });
  }

  return resolved;
}

export async function deleteIssue(workspaceId: string, issueId: string) {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: { id: true, creatorId: true },
  });
  if (!issue) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }
  await logActivity({
    workspaceId,
    actorId: issue.creatorId,
    type: "ISSUE_ARCHIVED",
    targetType: "ISSUE",
    targetId: issueId,
    message: `Issue ${issueId} archived`,
    metadata: { entityId: issueId },
  });
  await prisma.issue.delete({ where: { id: issueId } });
  const io = getSocketServer();
  if (io) {
    emitIssueDeleted(io, workspaceId, { issueId });
  }
}

export async function addDependency(
  workspaceId: string,
  issueId: string,
  relatedId: string,
  relation: "blocks" | "blocked-by" | "related",
  actorUserId?: string,
) {
  if (issueId === relatedId) {
    throw new AppError(409, ERROR_CODES.INVALID_RELATED_ISSUE, "Issue cannot depend on itself");
  }

  const [source, target] = await Promise.all([
    prisma.issue.findFirst({ where: { id: issueId, workspaceId }, select: { id: true, title: true, cycleId: true } }),
    prisma.issue.findFirst({ where: { id: relatedId, workspaceId }, select: { id: true, title: true, status: true } }),
  ]);
  if (!source || !target) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }

  const type = relation === "blocks" ? "BLOCKS" : relation === "blocked-by" ? "BLOCKED_BY" : "RELATED";

  try {
    await prisma.issueRelation.create({
      data: {
        issueId,
        relatedId,
        type: type as any,
      },
    });
  } catch {
    throw new AppError(409, ERROR_CODES.DEPENDENCY_ALREADY_EXISTS, "Dependency already exists");
  }

  if (actorUserId) {
    await logActivity({
      workspaceId,
      actorId: actorUserId,
      type: "ISSUE_DEPENDENCY_ADDED",
      targetType: "ISSUE",
      targetId: issueId,
      message: `Issue ${source.id} linked to ${target.id}`,
      metadata: buildIssueActivityMetadata(source.id, {
        entityTitle: source.title,
        cycleId: source.cycleId ?? null,
        relation,
        relatedIssue: {
          id: target.id,
          title: target.title,
          status: target.status,
        },
      }),
    });
  }

  return { issueId, relatedId, relation };
}

export async function removeDependency(workspaceId: string, issueId: string, relatedId: string, actorUserId?: string) {
  const [source, target] = await Promise.all([
    prisma.issue.findFirst({ where: { id: issueId, workspaceId }, select: { id: true, title: true, cycleId: true } }),
    prisma.issue.findFirst({ where: { id: relatedId, workspaceId }, select: { id: true, title: true, status: true } }),
  ]);
  if (!source || !target) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }

  const existing = await prisma.issueRelation.findFirst({
    where: {
      issueId,
      relatedId,
      issue: { workspaceId },
    },
    select: { id: true, type: true },
  });
  if (!existing) {
    throw new AppError(404, ERROR_CODES.DEPENDENCY_NOT_FOUND, "Dependency not found");
  }
  await prisma.issueRelation.delete({ where: { id: existing.id } });

  if (actorUserId) {
    const relation =
      existing.type === "BLOCKS" ? "blocks" : existing.type === "BLOCKED_BY" ? "blocked-by" : "related";
    await logActivity({
      workspaceId,
      actorId: actorUserId,
      type: "ISSUE_DEPENDENCY_REMOVED",
      targetType: "ISSUE",
      targetId: issueId,
      message: `Issue ${source.id} unlinked from ${target.id}`,
      metadata: buildIssueActivityMetadata(source.id, {
        entityTitle: source.title,
        cycleId: source.cycleId ?? null,
        relation,
        relatedIssue: {
          id: target.id,
          title: target.title,
          status: target.status,
        },
      }),
    });
  }
}

export async function listWatchers(workspaceId: string, issueId: string) {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: { id: true },
  });
  if (!issue) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }

  return (prisma as any).issueWatcher.findMany({
    where: { issueId },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          avatar: true,
          workspaceMemberships: {
            where: { workspaceId },
            select: { role: true },
            take: 1,
          },
        },
      },
    },
    orderBy: [{ createdAt: "asc" }],
  }).then((rows: any[]) => rows.map((row: any) => ({
    id: row.user.id,
    name: row.user.name,
    email: row.user.email,
    avatar: row.user.avatar,
    role: row.user.workspaceMemberships[0]?.role ?? "MEMBER",
  })));
}

export async function addWatchers(workspaceId: string, issueId: string, userIds: string[], actorUserId?: string) {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: { id: true, title: true, cycleId: true },
  });
  if (!issue) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }

  const uniqueUserIds = [...new Set(userIds)];
  const memberships = await prisma.workspaceMembership.findMany({
    where: { workspaceId, userId: { in: uniqueUserIds } },
    select: { userId: true },
  });
  if (memberships.length !== uniqueUserIds.length) {
    throw new AppError(404, ERROR_CODES.WATCHER_NOT_WORKSPACE_MEMBER, "One or more users are not workspace members");
  }

  await (prisma as any).issueWatcher.createMany({
    data: uniqueUserIds.map((userId) => ({ issueId, userId })),
    skipDuplicates: true,
  });

  if (actorUserId) {
    const watchers = await prisma.user.findMany({
      where: { id: { in: uniqueUserIds } },
      select: { id: true, name: true },
    });
    await logActivity({
      workspaceId,
      actorId: actorUserId,
      type: "ISSUE_WATCHERS_CHANGED",
      targetType: "ISSUE",
      targetId: issueId,
      message: `Issue ${issue.id} watchers updated`,
      metadata: buildIssueActivityMetadata(issue.id, {
        entityTitle: issue.title,
        cycleId: issue.cycleId ?? null,
        action: "added",
        watchers: watchers.map((watcher) => ({
          id: watcher.id,
          name: watcher.name ?? "Unknown",
        })),
      }),
    });
  }

  return { added: uniqueUserIds };
}

export async function removeWatcher(workspaceId: string, issueId: string, userId: string, actorUserId?: string) {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: { id: true, title: true, cycleId: true },
  });
  if (!issue) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }

  const watcher = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true },
  });

  await (prisma as any).issueWatcher.deleteMany({
    where: { issueId, userId },
  });

  if (actorUserId && watcher) {
    await logActivity({
      workspaceId,
      actorId: actorUserId,
      type: "ISSUE_WATCHERS_CHANGED",
      targetType: "ISSUE",
      targetId: issueId,
      message: `Issue ${issue.id} watchers updated`,
      metadata: buildIssueActivityMetadata(issue.id, {
        entityTitle: issue.title,
        cycleId: issue.cycleId ?? null,
        action: "removed",
        watchers: [{ id: watcher.id, name: watcher.name ?? "Unknown" }],
      }),
    });
  }
}

export async function updateIntegrationRefs(workspaceId: string, issueId: string, integrationRefs: any[], actorUserId?: string) {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: { id: true, title: true, cycleId: true, integrationRef: true },
  });
  if (!issue) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }

  const previousRefs = normalizeStoredIntegrationRefs(issue.integrationRef);

  await prisma.issue.update({
    where: { id: issueId },
    data: { integrationRef: (integrationRefs.length > 0 ? integrationRefs : null) as any },
  });

  if (actorUserId) {
    await logActivity({
      workspaceId,
      actorId: actorUserId,
      type: "ISSUE_INTEGRATION_REFS_CHANGED",
      targetType: "ISSUE",
      targetId: issueId,
      message: `Issue ${issue.id} integration references updated`,
      metadata: buildIssueActivityMetadata(issue.id, {
        entityTitle: issue.title,
        cycleId: issue.cycleId ?? null,
        previousRefs,
        integrationRefs,
      }),
    });
  }

  return integrationRefs;
}

export async function addAttachments(workspaceId: string, issueId: string, createdById: string, attachments: any[]) {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: { id: true },
  });
  if (!issue) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }

  await prisma.$transaction(async (tx) => {
    await createIssueAttachments(tx, issueId, workspaceId, createdById, attachments);
  });

  return getIssueById(workspaceId, "MEMBER", "", issueId);
}

export async function removeAttachment(workspaceId: string, issueId: string, attachmentId: string) {
  const attachment = await (prisma as any).issueAttachment.findFirst({
    where: { id: attachmentId, issueId, workspaceId },
    select: { id: true, size: true },
  });
  if (!attachment) {
    throw new AppError(404, ERROR_CODES.ATTACHMENT_NOT_FOUND, "Attachment not found");
  }
  await (prisma as any).issueAttachment.delete({ where: { id: attachmentId } });
  await decrementStorageUsage(workspaceId, attachment.size);
}
