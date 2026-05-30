import type { WorkspaceRole } from "../../app/generated/prisma/client.js";

import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import { logActivity } from "../../shared/utils/activity.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import { prisma } from "../../shared/utils/prisma.js";
import { getSocketServer } from "../../socket/index.js";
import { createRealtimeEnvelope } from "../../socket/serializers.js";
import { createNotification } from "../notification/notification.service.js";
import type {
  CreateTemplateInput,
  ListActiveTemplatesQuery,
  ListTemplatesQuery,
  UpdateTemplateInput,
} from "./template.schemas.js";

const TEMPLATE_DEFAULTS = {
  categoryOptions: ["Bug", "Feature", "Task", "QA", "Research", "Security", "Release", "Onboarding"],
  priorityOptions: ["low", "medium", "high", "urgent"],
  statusOptions: ["backlog", "todo", "in-progress", "review", "done"],
  labelOptions: ["bug", "feature", "task", "qa", "research", "security", "release", "onboarding", "review", "product"],
};

const scopePrecedence: Record<string, number> = {
  PROJECT: 3,
  TEAM: 2,
  WORKSPACE: 1,
};

function normalizeUnique(values: string[]) {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function issueTypeToDb(type: "task" | "bug" | "issue") {
  return type;
}

function scopeTypeToDb(type: "WORKSPACE" | "TEAM" | "PROJECT") {
  return type;
}

function scopeMatchesTemplate(template: any, scopeType?: string, scopeId?: string | null) {
  if (!scopeType) return true;
  if (scopeType === "WORKSPACE") {
    return template.scopeType === "WORKSPACE";
  }
  return template.scopeType === scopeType && template.scopeId === scopeId;
}

function isPrismaUniqueViolation(error: any) {
  return error?.code === "P2002";
}

function mapTemplate(item: any, application: any | null = null, options: { includeAppliedDraft?: boolean } = {}) {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    name: item.name,
    description: item.description,
    issueType: item.issueType,
    scopeType: item.scopeType,
    scopeId: item.scopeId,
    isDefault: item.isDefault,
    category: item.category,
    customCategory: item.customCategory,
    titleTemplate: item.titleTemplate,
    contentTemplate: item.contentTemplate,
    defaultPriority: item.defaultPriority,
    defaultStatus: item.defaultStatus,
    customStatus: item.customStatus,
    defaultAssigneeType: item.defaultAssigneeType,
    defaultAssigneeId: item.defaultAssigneeId,
    defaultEstimate: item.defaultEstimate,
    defaultDueDateOffset: item.defaultDueDateOffset,
    defaultLabelIds: item.defaultLabelIds,
    defaultSeverity: item.defaultSeverity,
    categoryOptions: item.categoryOptions,
    priorityOptions: item.priorityOptions,
    statusOptions: item.statusOptions,
    labelOptions: item.labelOptions,
    checklistItems: item.checklistItems,
    stepsToReproduceTemplate: item.stepsToReproduceTemplate,
    expectedBehaviorTemplate: item.expectedBehaviorTemplate,
    actualBehaviorTemplate: item.actualBehaviorTemplate,
    acceptanceCriteriaTemplate: item.acceptanceCriteriaTemplate,
    relatedIssueKeysTemplate: item.relatedIssueKeysTemplate,
    notesTemplate: item.notesTemplate,
    lifecycle: item.lifecycle,
    isActive: item.isActive,
    activeVersion: item.activeVersion,
    usageCount: item.usageCount,
    timesApplied: item.timesApplied,
    lastAppliedAt: item.lastAppliedAt,
    appliedByCurrentUser: Boolean(application),
    appliedAt: application?.appliedAt ?? null,
    appliedDraft: options.includeAppliedDraft ? application?.draft ?? null : null,
    createdById: item.createdById,
    updatedById: item.updatedById,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    deletedAt: item.deletedAt,
    creator: item.createdBy ? { id: item.createdBy.id, name: item.createdBy.name, email: item.createdBy.email } : undefined,
    updater: item.updatedBy ? { id: item.updatedBy.id, name: item.updatedBy.name, email: item.updatedBy.email } : undefined,
  };
}

function withCurrentApplicationInclude(userId: string | null | undefined) {
  if (!userId) {
    return {};
  }
  return {
    applications: {
      where: { userId },
      take: 1,
      select: { id: true, appliedAt: true, draft: true },
    },
  };
}

function getCurrentApplicationFromRecord(item: any) {
  return item.applications?.[0] ?? null;
}

function ensureDefaults(input: Partial<CreateTemplateInput>) {
  const categoryOptions = normalizeUnique(input.categoryOptions ?? TEMPLATE_DEFAULTS.categoryOptions);
  const priorityOptions = normalizeUnique(input.priorityOptions ?? TEMPLATE_DEFAULTS.priorityOptions);
  const statusOptions = normalizeUnique(input.statusOptions ?? TEMPLATE_DEFAULTS.statusOptions);
  const labelOptions = normalizeUnique(input.labelOptions ?? TEMPLATE_DEFAULTS.labelOptions);

  const defaultPriority = (input.defaultPriority ?? priorityOptions[0] ?? "medium").trim();
  const defaultStatus = (input.defaultStatus ?? statusOptions[0] ?? "todo").trim();

  if (!priorityOptions.includes(defaultPriority)) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "defaultPriority must be inside priorityOptions");
  }
  if (!statusOptions.includes(defaultStatus)) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "defaultStatus must be inside statusOptions");
  }

  return {
    categoryOptions,
    priorityOptions,
    statusOptions,
    labelOptions,
    defaultPriority,
    defaultStatus,
  };
}

async function assertTemplateInWorkspace(workspaceId: string, templateId: string) {
  const template = await (prisma as any).template.findFirst({ where: { id: templateId, workspaceId, deletedAt: null } });
  if (!template) {
    throw new AppError(404, ERROR_CODES.TEMPLATE_NOT_FOUND, "Template not found");
  }
  return template;
}

async function assertAssignee(workspaceId: string, assigneeId: string | null | undefined) {
  if (!assigneeId) return;
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId: assigneeId, workspaceId } },
    select: { userId: true },
  });
  if (!membership) {
    throw new AppError(404, ERROR_CODES.ASSIGNEE_NOT_WORKSPACE_MEMBER, "Default assignee is not a workspace member");
  }
}

async function assertLabelIds(workspaceId: string, labelIds: string[]) {
  if (labelIds.length === 0) return;
  const count = await prisma.label.count({ where: { workspaceId, id: { in: labelIds } } });
  if (count !== labelIds.length) {
    throw new AppError(404, ERROR_CODES.LABEL_NOT_FOUND, "One or more default labels not found");
  }
}

async function assertScope(workspaceId: string, scopeType: "WORKSPACE" | "TEAM" | "PROJECT", scopeId: string | null | undefined) {
  if (scopeType === "WORKSPACE") {
    if (scopeId !== null && scopeId !== undefined) {
      throw new AppError(422, ERROR_CODES.TEMPLATE_VALIDATION_FAILED, "scopeId must be null for WORKSPACE scope");
    }
    return;
  }

  if (!scopeId) {
    throw new AppError(422, ERROR_CODES.TEMPLATE_VALIDATION_FAILED, "scopeId is required for TEAM and PROJECT scopes");
  }

  if (scopeType === "TEAM") {
    const team = await prisma.team.findFirst({ where: { id: scopeId, workspaceId }, select: { id: true } });
    if (!team) {
      throw new AppError(404, ERROR_CODES.TEAM_NOT_FOUND, "Team not found");
    }
    return;
  }

  const project = await prisma.project.findFirst({ where: { id: scopeId, workspaceId }, select: { id: true } });
  if (!project) {
    throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
  }
}

function scopeScore(scopeType: string) {
  return scopePrecedence[scopeType] ?? 0;
}

async function assertDefaultConflict(workspaceId: string, issueType: string, templateId?: string) {
  const current = await (prisma as any).template.findFirst({
    where: {
      workspaceId,
      issueType,
      scopeType: "WORKSPACE",
      isDefault: true,
      deletedAt: null,
      ...(templateId ? { id: { not: templateId } } : {}),
    },
    select: { id: true, name: true },
  });

  return current;
}

async function emitTemplateEvent(workspaceId: string, type: string, payload: Record<string, unknown>) {
  const io = getSocketServer();
  if (!io) return;
  const envelope = createRealtimeEnvelope({ type, workspaceId, payload });
  io.to(`workspace:${workspaceId}`).emit(type, envelope);
}

async function notifyTemplateManagers(workspaceId: string, actorId: string, title: string, message: string, templateId: string, metadata: Record<string, unknown>) {
  const recipients = await prisma.workspaceMembership.findMany({
    where: { workspaceId, role: { in: ["OWNER", "ADMIN"] }, userId: { not: actorId } },
    select: { userId: true },
  });

  await Promise.all(recipients.map((recipient) => createNotification({
    workspaceId,
    recipientUserId: recipient.userId,
    actorUserId: actorId,
    type: "UPDATE",
    category: "update",
    title,
    message,
    target: {
      type: "workspace",
      id: templateId,
      url: `/templates/${templateId}`,
    },
    metadata: {
      workspaceId,
      templateId,
      ...metadata,
    },
    dedupeKey: `${title}:${templateId}:${recipient.userId}`,
  })));
}

export async function getTemplateDefaults() {
  return TEMPLATE_DEFAULTS;
}

export async function listTemplates(workspaceId: string, userId: string | null, query: ListTemplatesQuery) {
  const limit = clampListLimit(query.limit, 30);
  const where: any = {
    workspaceId,
    deletedAt: null,
    ...(query.q ? { OR: [{ name: { contains: query.q, mode: "insensitive" } }, { description: { contains: query.q, mode: "insensitive" } }] } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(query.issueType ? { issueType: issueTypeToDb(query.issueType) } : {}),
    ...(query.scopeType ? { scopeType: scopeTypeToDb(query.scopeType) } : {}),
    ...(query.scopeId ? { scopeId: query.scopeId } : {}),
    ...(query.creatorId ? { createdById: query.creatorId } : {}),
    ...(query.lifecycle ? { lifecycle: query.lifecycle } : {}),
    ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
  };

  const orderBy = query.sort === "updatedAt:asc"
    ? [{ updatedAt: "asc" }, { id: "asc" }]
    : query.sort === "createdAt:asc"
      ? [{ createdAt: "asc" }, { id: "asc" }]
      : query.sort === "createdAt:desc"
        ? [{ createdAt: "desc" }, { id: "desc" }]
        : query.sort === "name:asc"
          ? [{ name: "asc" }, { id: "asc" }]
          : [{ updatedAt: "desc" }, { id: "desc" }];

  const [total, records] = await Promise.all([
    (prisma as any).template.count({ where }),
    (prisma as any).template.findMany({
      where,
      orderBy,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: limit + 1,
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
        updatedBy: { select: { id: true, name: true, email: true } },
        ...withCurrentApplicationInclude(userId),
      },
    }),
  ]);

  const page = slicePage(records, limit);
  const lastItem = page.items[page.items.length - 1] as any;
  return {
    items: page.items.map((item: any) => mapTemplate(item, getCurrentApplicationFromRecord(item), { includeAppliedDraft: false })),
    meta: { total, cursor: page.hasMore ? lastItem?.id ?? null : null, hasMore: page.hasMore },
  };
}

export async function listActiveTemplates(workspaceId: string, userId: string | null, query: ListActiveTemplatesQuery) {
  let resolvedTeamId = query.teamId ?? null;
  if (query.teamId) {
    const team = await prisma.team.findFirst({
      where: { id: query.teamId, workspaceId },
      select: { id: true },
    });
    if (!team) {
      throw new AppError(404, ERROR_CODES.TEAM_NOT_FOUND, "Team not found");
    }
  }

  if (query.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: query.projectId, workspaceId },
      select: { id: true, teamId: true },
    });
    if (!project) {
      throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
    }
    if (!resolvedTeamId) {
      resolvedTeamId = project.teamId;
    }
  }

  const visibleScopeFilters: any[] = [{ scopeType: "WORKSPACE" }];
  if (resolvedTeamId) {
    visibleScopeFilters.push({ scopeType: "TEAM", scopeId: resolvedTeamId });
  }
  if (query.projectId) {
    visibleScopeFilters.push({ scopeType: "PROJECT", scopeId: query.projectId });
  }

  const items = await (prisma as any).template.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      lifecycle: { not: "ARCHIVED" },
      isActive: true,
      ...(query.issueType ? { issueType: issueTypeToDb(query.issueType) } : {}),
      OR: visibleScopeFilters,
    },
    orderBy: [{ issueType: "asc" }, { updatedAt: "desc" }],
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      updatedBy: { select: { id: true, name: true, email: true } },
      ...withCurrentApplicationInclude(userId),
    },
  });

  const effectiveByIssueType = new Map<string, any>();
  const sortedItems = [...items].sort((a, b) => {
    if (a.issueType !== b.issueType) {
      return String(a.issueType).localeCompare(String(b.issueType));
    }
    const scopeDelta = scopeScore(b.scopeType) - scopeScore(a.scopeType);
    if (scopeDelta !== 0) {
      return scopeDelta;
    }
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  for (const item of sortedItems) {
    const current = effectiveByIssueType.get(item.issueType);
    if (!current) {
      effectiveByIssueType.set(item.issueType, item);
      continue;
    }
    const currentScore = scopeScore(current.scopeType);
    const nextScore = scopeScore(item.scopeType);
    if (nextScore > currentScore || (nextScore === currentScore && new Date(item.updatedAt).getTime() > new Date(current.updatedAt).getTime())) {
      effectiveByIssueType.set(item.issueType, item);
    }
  }

  return {
    items: [...effectiveByIssueType.values()].map((item) => mapTemplate(item, getCurrentApplicationFromRecord(item), { includeAppliedDraft: false })),
  };
}

export async function getTemplateById(workspaceId: string, templateId: string, userId: string | null) {
  const template = await (prisma as any).template.findFirst({
    where: { id: templateId, workspaceId, deletedAt: null },
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      updatedBy: { select: { id: true, name: true, email: true } },
      ...withCurrentApplicationInclude(userId),
    },
  });

  if (!template) {
    throw new AppError(404, ERROR_CODES.TEMPLATE_NOT_FOUND, "Template not found");
  }

  return mapTemplate(template, getCurrentApplicationFromRecord(template), { includeAppliedDraft: true });
}

export async function createTemplate(workspaceId: string, actorId: string, input: CreateTemplateInput) {
  const defaults = ensureDefaults(input);
  await assertScope(workspaceId, input.scopeType, input.scopeId ?? null);
  await assertAssignee(workspaceId, input.defaultAssigneeId);
  await assertLabelIds(workspaceId, input.defaultLabelIds ?? []);

  if (input.issueType === "issue" && !input.acceptanceCriteriaTemplate?.trim()) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "ISSUE type template requires acceptanceCriteriaTemplate");
  }

  if (input.isDefault && input.scopeType !== "WORKSPACE") {
    throw new AppError(422, ERROR_CODES.TEMPLATE_VALIDATION_FAILED, "Only WORKSPACE templates can be defaults");
  }

  const conflictingDefault = input.isDefault ? await assertDefaultConflict(workspaceId, input.issueType) : null;
  if (conflictingDefault) {
    throw new AppError(409, ERROR_CODES.TEMPLATE_DEFAULT_CONFLICT, `A workspace default template already exists for ${input.issueType} issues. Do you want to replace it?`, {
      issueType: input.issueType,
      currentDefault: conflictingDefault,
      candidateTemplate: { id: "__new__", name: input.name },
      scopeType: "WORKSPACE",
      requiresConfirmation: true,
    });
  }

  let created: any;
  try {
    created = await (prisma as any).template.create({
      data: {
        workspaceId,
        name: input.name,
        description: input.description,
        issueType: issueTypeToDb(input.issueType),
        scopeType: scopeTypeToDb(input.scopeType),
        scopeId: input.scopeId ?? null,
        isDefault: Boolean(input.isDefault),
        category: input.category,
        customCategory: input.customCategory ?? null,
        titleTemplate: input.titleTemplate,
        contentTemplate: input.contentTemplate,
        defaultPriority: defaults.defaultPriority,
        defaultStatus: defaults.defaultStatus,
        customStatus: input.customStatus ?? null,
        defaultAssigneeType: input.defaultAssigneeType,
        defaultAssigneeId: input.defaultAssigneeId ?? null,
        defaultEstimate: input.defaultEstimate ?? null,
        defaultDueDateOffset: input.defaultDueDateOffset ?? null,
        defaultLabelIds: input.defaultLabelIds ?? [],
        defaultSeverity: input.defaultSeverity ?? null,
        categoryOptions: defaults.categoryOptions,
        priorityOptions: defaults.priorityOptions,
        statusOptions: defaults.statusOptions,
        labelOptions: defaults.labelOptions,
        checklistItems: input.checklistItems ?? [],
        stepsToReproduceTemplate: input.stepsToReproduceTemplate ?? null,
        expectedBehaviorTemplate: input.expectedBehaviorTemplate ?? null,
        actualBehaviorTemplate: input.actualBehaviorTemplate ?? null,
        acceptanceCriteriaTemplate: input.acceptanceCriteriaTemplate ?? null,
        relatedIssueKeysTemplate: input.relatedIssueKeysTemplate ?? null,
        notesTemplate: input.notesTemplate ?? null,
        createdById: actorId,
        updatedById: actorId,
      },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
        updatedBy: { select: { id: true, name: true, email: true } },
      },
    });
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      throw new AppError(409, ERROR_CODES.TEMPLATE_NAME_TAKEN, "Template name already exists in this workspace");
    }
    throw error;
  }

  await logActivity({
    workspaceId,
    actorId,
    type: "TEMPLATE_CREATED",
    targetType: "TEMPLATE",
    targetId: created.id,
    message: `Template ${created.name} created`,
    metadata: { templateId: created.id, templateName: created.name, issueType: created.issueType },
  });

  await emitTemplateEvent(workspaceId, "template.created", {
    workspaceId,
    templateId: created.id,
    issueType: created.issueType,
    isActive: created.isActive,
    updatedAt: created.updatedAt,
  });

  return mapTemplate(created);
}

export async function updateTemplate(workspaceId: string, templateId: string, actorId: string, input: UpdateTemplateInput) {
  const current = await assertTemplateInWorkspace(workspaceId, templateId);
  const merged = { ...current, ...input } as any;
  const defaults = ensureDefaults(merged);
  await assertScope(workspaceId, (merged.scopeType ?? current.scopeType) as any, merged.scopeId ?? current.scopeId ?? null);
  await assertAssignee(workspaceId, merged.defaultAssigneeId ?? null);
  await assertLabelIds(workspaceId, merged.defaultLabelIds ?? []);

  if ((merged.issueType as string) === "issue" && !(merged.acceptanceCriteriaTemplate ?? "").trim()) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "ISSUE type template requires acceptanceCriteriaTemplate");
  }

  const nextScopeType = (merged.scopeType ?? current.scopeType) as "WORKSPACE" | "TEAM" | "PROJECT";
  const nextIsDefault = Boolean(merged.isDefault ?? current.isDefault);
  if (nextIsDefault && nextScopeType !== "WORKSPACE") {
    throw new AppError(422, ERROR_CODES.TEMPLATE_VALIDATION_FAILED, "Only WORKSPACE templates can be defaults");
  }

  const conflictingDefault = nextIsDefault
    ? await assertDefaultConflict(workspaceId, merged.issueType ?? current.issueType, templateId)
    : null;
  if (conflictingDefault) {
    throw new AppError(409, ERROR_CODES.TEMPLATE_DEFAULT_CONFLICT, `A workspace default template already exists for ${merged.issueType ?? current.issueType} issues. Do you want to replace it?`, {
      issueType: merged.issueType ?? current.issueType,
      currentDefault: conflictingDefault,
      candidateTemplate: { id: current.id, name: merged.name ?? current.name },
      scopeType: "WORKSPACE",
      requiresConfirmation: true,
    });
  }

  let updated: any;
  try {
    updated = await (prisma as any).template.update({
      where: { id: templateId },
      data: {
        ...("name" in input ? { name: input.name } : {}),
        ...("description" in input ? { description: input.description } : {}),
        ...("issueType" in input ? { issueType: input.issueType } : {}),
        ...("scopeType" in input ? { scopeType: input.scopeType } : {}),
        ...("scopeId" in input ? { scopeId: input.scopeId ?? null } : {}),
        ...("isDefault" in input ? { isDefault: Boolean(input.isDefault) } : {}),
        ...("category" in input ? { category: input.category } : {}),
        ...("customCategory" in input ? { customCategory: input.customCategory ?? null } : {}),
        ...("titleTemplate" in input ? { titleTemplate: input.titleTemplate } : {}),
        ...("contentTemplate" in input ? { contentTemplate: input.contentTemplate } : {}),
        ...("customStatus" in input ? { customStatus: input.customStatus ?? null } : {}),
        ...("defaultAssigneeType" in input ? { defaultAssigneeType: input.defaultAssigneeType } : {}),
        ...("defaultAssigneeId" in input ? { defaultAssigneeId: input.defaultAssigneeId ?? null } : {}),
        ...("defaultEstimate" in input ? { defaultEstimate: input.defaultEstimate ?? null } : {}),
        ...("defaultDueDateOffset" in input ? { defaultDueDateOffset: input.defaultDueDateOffset ?? null } : {}),
        ...("defaultLabelIds" in input ? { defaultLabelIds: input.defaultLabelIds ?? [] } : {}),
        ...("defaultSeverity" in input ? { defaultSeverity: input.defaultSeverity ?? null } : {}),
        ...("categoryOptions" in input ? { categoryOptions: defaults.categoryOptions } : {}),
        ...("priorityOptions" in input ? { priorityOptions: defaults.priorityOptions } : {}),
        ...("statusOptions" in input ? { statusOptions: defaults.statusOptions } : {}),
        ...("labelOptions" in input ? { labelOptions: defaults.labelOptions } : {}),
        ...("checklistItems" in input ? { checklistItems: input.checklistItems ?? [] } : {}),
        ...("stepsToReproduceTemplate" in input ? { stepsToReproduceTemplate: input.stepsToReproduceTemplate ?? null } : {}),
        ...("expectedBehaviorTemplate" in input ? { expectedBehaviorTemplate: input.expectedBehaviorTemplate ?? null } : {}),
        ...("actualBehaviorTemplate" in input ? { actualBehaviorTemplate: input.actualBehaviorTemplate ?? null } : {}),
        ...("acceptanceCriteriaTemplate" in input ? { acceptanceCriteriaTemplate: input.acceptanceCriteriaTemplate ?? null } : {}),
        ...("relatedIssueKeysTemplate" in input ? { relatedIssueKeysTemplate: input.relatedIssueKeysTemplate ?? null } : {}),
        ...("notesTemplate" in input ? { notesTemplate: input.notesTemplate ?? null } : {}),
        defaultPriority: defaults.defaultPriority,
        defaultStatus: defaults.defaultStatus,
        activeVersion: { increment: 1 },
        updatedById: actorId,
      },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
        updatedBy: { select: { id: true, name: true, email: true } },
      },
    });
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      throw new AppError(409, ERROR_CODES.TEMPLATE_NAME_TAKEN, "Template name already exists in this workspace");
    }
    throw error;
  }

  await logActivity({
    workspaceId,
    actorId,
    type: "TEMPLATE_UPDATED",
    targetType: "TEMPLATE",
    targetId: updated.id,
    message: `Template ${updated.name} updated`,
    metadata: { templateId: updated.id, templateName: updated.name, issueType: updated.issueType },
  });

  if (updated.isActive) {
    await notifyTemplateManagers(
      workspaceId,
      actorId,
      "Template updated",
      `${updated.name} was updated and is active`,
      updated.id,
      { issueType: updated.issueType, action: "updated" },
    );
  }

  await emitTemplateEvent(workspaceId, "template.updated", {
    workspaceId,
    templateId: updated.id,
    issueType: updated.issueType,
    isActive: updated.isActive,
    updatedAt: updated.updatedAt,
  });

  return mapTemplate(updated);
}

export async function deleteTemplate(workspaceId: string, templateId: string, actorId: string) {
  const existing = await assertTemplateInWorkspace(workspaceId, templateId);

  const deleted = await (prisma as any).template.update({
    where: { id: templateId },
    data: {
      deletedAt: new Date(),
      isActive: false,
      lifecycle: "ARCHIVED",
      updatedById: actorId,
    },
  });

  await logActivity({
    workspaceId,
    actorId,
    type: "TEMPLATE_DELETED",
    targetType: "TEMPLATE",
    targetId: templateId,
    message: `Template ${existing.name} deleted`,
    metadata: { templateId, templateName: existing.name, issueType: existing.issueType },
  });

  await notifyTemplateManagers(
    workspaceId,
    actorId,
    "Template deleted",
    `${existing.name} was deleted`,
    templateId,
    { issueType: existing.issueType, action: "deleted" },
  );

  await emitTemplateEvent(workspaceId, "template.deleted", {
    workspaceId,
    templateId,
    issueType: deleted.issueType,
    isActive: false,
    updatedAt: deleted.updatedAt,
  });
}

export async function duplicateTemplate(workspaceId: string, templateId: string, actorId: string, isActive = false) {
  const src = await assertTemplateInWorkspace(workspaceId, templateId);

  const created = await (prisma as any).template.create({
    data: {
      workspaceId,
      name: `${src.name} (Copy)`,
      description: src.description,
      issueType: src.issueType,
      scopeType: src.scopeType,
      scopeId: src.scopeId,
      isDefault: false,
      category: src.category,
      customCategory: src.customCategory,
      titleTemplate: src.titleTemplate,
      contentTemplate: src.contentTemplate,
      defaultPriority: src.defaultPriority,
      defaultStatus: src.defaultStatus,
      customStatus: src.customStatus,
      defaultAssigneeType: src.defaultAssigneeType,
      defaultAssigneeId: src.defaultAssigneeId,
      defaultEstimate: src.defaultEstimate,
      defaultDueDateOffset: src.defaultDueDateOffset,
      defaultLabelIds: src.defaultLabelIds,
      defaultSeverity: src.defaultSeverity,
      categoryOptions: src.categoryOptions,
      priorityOptions: src.priorityOptions,
      statusOptions: src.statusOptions,
      labelOptions: src.labelOptions,
      checklistItems: src.checklistItems,
      stepsToReproduceTemplate: src.stepsToReproduceTemplate,
      expectedBehaviorTemplate: src.expectedBehaviorTemplate,
      actualBehaviorTemplate: src.actualBehaviorTemplate,
      acceptanceCriteriaTemplate: src.acceptanceCriteriaTemplate,
      relatedIssueKeysTemplate: src.relatedIssueKeysTemplate,
      notesTemplate: src.notesTemplate,
      lifecycle: "INACTIVE",
      isActive,
      usageCount: 0,
      timesApplied: 0,
      lastAppliedAt: null,
      createdById: actorId,
      updatedById: actorId,
    },
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      updatedBy: { select: { id: true, name: true, email: true } },
    },
  });

  await logActivity({
    workspaceId,
    actorId,
    type: "TEMPLATE_CREATED",
    targetType: "TEMPLATE",
    targetId: created.id,
    message: `Template duplicated from ${src.name}`,
    metadata: { templateId: created.id, sourceTemplateId: src.id, issueType: created.issueType },
  });

  await emitTemplateEvent(workspaceId, "template.created", {
    workspaceId,
    templateId: created.id,
    issueType: created.issueType,
    isActive: created.isActive,
    updatedAt: created.updatedAt,
  });

  return mapTemplate(created);
}

export async function applyTemplate(workspaceId: string, templateId: string, actorId: string) {
  const template = await assertTemplateInWorkspace(workspaceId, templateId);

  const appliedAt = new Date();
  const draft = {
    templateId: template.id,
    title: template.titleTemplate,
    description: template.contentTemplate,
    issueType: template.issueType,
    scopeType: template.scopeType,
    scopeId: template.scopeId,
    isDefault: template.isDefault,
    priority: template.defaultPriority,
    status: template.defaultStatus,
    customStatus: template.customStatus,
    assigneeType: template.defaultAssigneeType,
    assigneeId: template.defaultAssigneeId,
    estimate: template.defaultEstimate,
    dueDateOffset: template.defaultDueDateOffset,
    labels: template.defaultLabelIds,
    subtasks: template.checklistItems,
    severity: template.defaultSeverity,
    stepsToReproduce: template.stepsToReproduceTemplate,
    expectedBehavior: template.expectedBehaviorTemplate,
    actualBehavior: template.actualBehaviorTemplate,
    acceptanceCriteria: template.acceptanceCriteriaTemplate,
    relatedIssueKeys: template.relatedIssueKeysTemplate,
    notes: template.notesTemplate,
  };

  await (prisma as any).template.update({
    where: { id: templateId },
    data: {
      timesApplied: { increment: 1 },
      usageCount: { increment: 1 },
      lastAppliedAt: appliedAt,
      updatedById: actorId,
    },
  });

  await (prisma as any).templateApplication.upsert({
    where: {
      workspaceId_templateId_userId: {
        workspaceId,
        templateId: template.id,
        userId: actorId,
      },
    },
    create: {
      workspaceId,
      templateId: template.id,
      userId: actorId,
      draft: draft as any,
      appliedAt,
    },
    update: {
      draft: draft as any,
      appliedAt,
    },
  });

  await logActivity({
    workspaceId,
    actorId,
    type: "TEMPLATE_APPLIED",
    targetType: "TEMPLATE",
    targetId: template.id,
    message: `Template ${template.name} applied`,
    metadata: { templateId: template.id, templateName: template.name, issueType: template.issueType },
  });

  return {
    draft,
    appliedByCurrentUser: true,
    appliedAt,
    templateId: template.id,
    scopeType: template.scopeType,
    scopeId: template.scopeId,
    appliedDraft: draft,
  };
}

export async function confirmDefaultTemplate(workspaceId: string, templateId: string, actorId: string) {
  const candidate = await assertTemplateInWorkspace(workspaceId, templateId);
  if (candidate.scopeType !== "WORKSPACE") {
    throw new AppError(422, ERROR_CODES.TEMPLATE_VALIDATION_FAILED, "Only WORKSPACE templates can be defaults");
  }

  const result = await prisma.$transaction(async (tx) => {
    const current = await (tx as any).template.findFirst({
      where: {
        workspaceId,
        issueType: candidate.issueType,
        scopeType: "WORKSPACE",
        isDefault: true,
        deletedAt: null,
        id: { not: templateId },
      },
      select: { id: true, name: true, issueType: true },
    });

    if (current) {
      await (tx as any).template.update({
        where: { id: current.id },
        data: { isDefault: false, updatedById: actorId },
      });
    }

    const promoted = await (tx as any).template.update({
      where: { id: templateId },
      data: { isDefault: true, updatedById: actorId },
    });

    return { current, promoted };
  });

  if (result.current) {
    await logActivity({
      workspaceId,
      actorId,
      type: "TEMPLATE_UPDATED",
      targetType: "TEMPLATE",
      targetId: result.current.id,
      message: `Workspace default removed from ${result.current.name}`,
      metadata: { templateId: result.current.id, templateName: result.current.name, issueType: result.current.issueType, isDefault: false },
    });
  }

  await logActivity({
    workspaceId,
    actorId,
    type: "TEMPLATE_UPDATED",
    targetType: "TEMPLATE",
    targetId: result.promoted.id,
    message: `Workspace default set to ${result.promoted.name}`,
    metadata: { templateId: result.promoted.id, templateName: result.promoted.name, issueType: result.promoted.issueType, isDefault: true },
  });

  await emitTemplateEvent(workspaceId, "template.updated", {
    workspaceId,
    templateId: result.promoted.id,
    issueType: result.promoted.issueType,
    isActive: result.promoted.isActive,
    updatedAt: result.promoted.updatedAt,
  });

  if (result.current) {
    await emitTemplateEvent(workspaceId, "template.updated", {
      workspaceId,
      templateId: result.current.id,
      issueType: result.current.issueType,
      isActive: false,
      updatedAt: new Date().toISOString(),
    });
  }

  return mapTemplate(result.promoted);
}

export async function activateTemplate(workspaceId: string, templateId: string, actorId: string) {
  const candidate = await assertTemplateInWorkspace(workspaceId, templateId);

  const current = await (prisma as any).template.findFirst({
    where: {
      workspaceId,
      deletedAt: null,
      isActive: true,
      issueType: candidate.issueType,
      id: { not: candidate.id },
    },
    select: { id: true, name: true, issueType: true },
  });

  if (current) {
    throw new AppError(
      409,
      "TEMPLATE_ALREADY_ACTIVE",
      `A ${current.issueType} template is already active. Use /templates/${candidate.id}/activate/confirm to swap.`,
      {
        issueType: current.issueType,
        activeTemplate: { id: current.id, name: current.name },
        candidateTemplate: { id: candidate.id, name: candidate.name },
        requiresConfirmation: true,
      },
    );
  }

  return activateTemplateDirect(workspaceId, templateId, actorId);
}

async function activateTemplateDirect(workspaceId: string, templateId: string, actorId: string) {
  const updated = await (prisma as any).template.update({
    where: { id: templateId },
    data: { isActive: true, lifecycle: "ACTIVE", updatedById: actorId },
  });

  await logActivity({
    workspaceId,
    actorId,
    type: "TEMPLATE_ACTIVATED",
    targetType: "TEMPLATE",
    targetId: updated.id,
    message: `Template ${updated.name} activated`,
    metadata: { templateId: updated.id, templateName: updated.name, issueType: updated.issueType },
  });

  await notifyTemplateManagers(
    workspaceId,
    actorId,
    "Template activated",
    `${updated.name} is now active`,
    updated.id,
    { issueType: updated.issueType, action: "activated" },
  );

  await emitTemplateEvent(workspaceId, "template.activated", {
    workspaceId,
    templateId: updated.id,
    issueType: updated.issueType,
    isActive: true,
    updatedAt: updated.updatedAt,
  });

  return mapTemplate(updated);
}

export async function confirmActivateTemplate(workspaceId: string, templateId: string, actorId: string) {
  const candidate = await assertTemplateInWorkspace(workspaceId, templateId);

  const result = await prisma.$transaction(async (tx) => {
    await (tx as any).template.updateMany({
      where: {
        workspaceId,
        issueType: candidate.issueType,
        isActive: true,
        deletedAt: null,
        id: { not: templateId },
      },
      data: { isActive: false, lifecycle: "INACTIVE", updatedById: actorId },
    });

    return (tx as any).template.update({
      where: { id: templateId },
      data: { isActive: true, lifecycle: "ACTIVE", updatedById: actorId },
    });
  });

  await logActivity({
    workspaceId,
    actorId,
    type: "TEMPLATE_ACTIVATED",
    targetType: "TEMPLATE",
    targetId: result.id,
    message: `Template ${result.name} activated by confirmation`,
    metadata: { templateId: result.id, templateName: result.name, issueType: result.issueType, confirmedSwap: true },
  });

  await emitTemplateEvent(workspaceId, "template.activated", {
    workspaceId,
    templateId: result.id,
    issueType: result.issueType,
    isActive: true,
    updatedAt: result.updatedAt,
  });

  return mapTemplate(result);
}

export async function deactivateTemplate(workspaceId: string, templateId: string, actorId: string) {
  const existing = await assertTemplateInWorkspace(workspaceId, templateId);
  const updated = await (prisma as any).template.update({
    where: { id: templateId },
    data: { isActive: false, lifecycle: "INACTIVE", updatedById: actorId },
  });

  await logActivity({
    workspaceId,
    actorId,
    type: "TEMPLATE_DEACTIVATED",
    targetType: "TEMPLATE",
    targetId: updated.id,
    message: `Template ${existing.name} deactivated`,
    metadata: { templateId: updated.id, templateName: existing.name, issueType: updated.issueType },
  });

  await emitTemplateEvent(workspaceId, "template.deactivated", {
    workspaceId,
    templateId: updated.id,
    issueType: updated.issueType,
    isActive: false,
    updatedAt: updated.updatedAt,
  });

  return mapTemplate(updated);
}
