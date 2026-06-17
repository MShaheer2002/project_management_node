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

/* ── defaults ────────────────────────────────────────────────────── */

const TEMPLATE_DEFAULTS = {
  categoryOptions: ["Bug", "Feature", "Task", "QA", "Research", "Security", "Release", "Onboarding"],
  priorityOptions: ["low", "medium", "high", "urgent"],
  statusOptions: ["backlog", "todo", "in-progress", "review", "done"],
  labelOptions: ["bug", "feature", "task", "qa", "research", "security", "release", "onboarding", "review", "product"],
};

/* ── helpers ─────────────────────────────────────────────────────── */

function normalizeUnique(values: string[]) {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
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
  if (!userId) return {};
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

  return { categoryOptions, priorityOptions, statusOptions, labelOptions, defaultPriority, defaultStatus };
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
    metadata: { workspaceId, templateId, ...metadata },
    dedupeKey: `${title}:${templateId}:${recipient.userId}`,
  })));
}

/* ── public API ──────────────────────────────────────────────────── */

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
    ...(query.issueType ? { issueType: query.issueType } : {}),
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

/**
 * Returns at most one active template per issue type for the workspace.
 * Simple: no scope precedence, just workspace-level active templates.
 */
export async function listActiveTemplates(workspaceId: string, userId: string | null, query: ListActiveTemplatesQuery) {
  const items = await (prisma as any).template.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      isActive: true,
      ...(query.issueType ? { issueType: query.issueType } : {}),
    },
    orderBy: [{ issueType: "asc" }, { updatedAt: "desc" }],
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      updatedBy: { select: { id: true, name: true, email: true } },
      ...withCurrentApplicationInclude(userId),
    },
  });

  // Keep only one per issue type (most recently updated wins if somehow multiple active)
  const byType = new Map<string, any>();
  for (const item of items) {
    if (!byType.has(item.issueType)) {
      byType.set(item.issueType, item);
    }
  }

  return {
    items: [...byType.values()].map((item) => mapTemplate(item, getCurrentApplicationFromRecord(item), { includeAppliedDraft: false })),
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
  await assertAssignee(workspaceId, input.defaultAssigneeId);
  await assertLabelIds(workspaceId, input.defaultLabelIds ?? []);

  if (input.issueType === "issue" && !input.acceptanceCriteriaTemplate?.trim()) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "ISSUE type template requires acceptanceCriteriaTemplate");
  }

  let created: any;
  try {
    created = await (prisma as any).template.create({
      data: {
        workspaceId,
        name: input.name,
        description: input.description,
        issueType: input.issueType,
        scopeType: "WORKSPACE",
        scopeId: null,
        isDefault: false,
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
  await assertAssignee(workspaceId, merged.defaultAssigneeId ?? null);
  await assertLabelIds(workspaceId, merged.defaultLabelIds ?? []);

  if ((merged.issueType as string) === "issue" && !(merged.acceptanceCriteriaTemplate ?? "").trim()) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "ISSUE type template requires acceptanceCriteriaTemplate");
  }

  let updated: any;
  try {
    updated = await (prisma as any).template.update({
      where: { id: templateId },
      data: {
        ...("name" in input ? { name: input.name } : {}),
        ...("description" in input ? { description: input.description } : {}),
        ...("issueType" in input ? { issueType: input.issueType } : {}),
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
    await notifyTemplateManagers(workspaceId, actorId, "Template updated", `${updated.name} was updated and is active`, updated.id, { issueType: updated.issueType, action: "updated" });
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
    data: { deletedAt: new Date(), isActive: false, lifecycle: "ARCHIVED", updatedById: actorId },
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

  await notifyTemplateManagers(workspaceId, actorId, "Template deleted", `${existing.name} was deleted`, templateId, { issueType: existing.issueType, action: "deleted" });

  await emitTemplateEvent(workspaceId, "template.deleted", {
    workspaceId,
    templateId,
    issueType: deleted.issueType,
    isActive: false,
    updatedAt: deleted.updatedAt,
  });
}

export async function duplicateTemplate(workspaceId: string, templateId: string, actorId: string, _isActive = false) {
  const src = await assertTemplateInWorkspace(workspaceId, templateId);

  const created = await (prisma as any).template.create({
    data: {
      workspaceId,
      name: `${src.name} (Copy)`,
      description: src.description,
      issueType: src.issueType,
      scopeType: "WORKSPACE",
      scopeId: null,
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
      isActive: false,
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

/**
 * Activate a template for its issue type.
 * Only one active template per (workspaceId, issueType).
 * If another is already active, returns 409 with conflict details.
 */
export async function activateTemplate(workspaceId: string, templateId: string, actorId: string) {
  const candidate = await assertTemplateInWorkspace(workspaceId, templateId);

  const current = await (prisma as any).template.findFirst({
    where: { workspaceId, deletedAt: null, isActive: true, issueType: candidate.issueType, id: { not: candidate.id } },
    select: { id: true, name: true, issueType: true },
  });

  if (current) {
    throw new AppError(
      409,
      "TEMPLATE_ALREADY_ACTIVE",
      `A ${current.issueType} template "${current.name}" is already active. Confirm to swap.`,
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

/**
 * Confirm activation swap: deactivates the current active template for the
 * same issueType and activates this one. Atomic transaction.
 */
export async function confirmActivateTemplate(workspaceId: string, templateId: string, actorId: string) {
  const candidate = await assertTemplateInWorkspace(workspaceId, templateId);

  const result = await prisma.$transaction(async (tx) => {
    await (tx as any).template.updateMany({
      where: { workspaceId, issueType: candidate.issueType, isActive: true, deletedAt: null, id: { not: templateId } },
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
    message: `Template ${result.name} activated (swapped)`,
    metadata: { templateId: result.id, templateName: result.name, issueType: result.issueType, confirmedSwap: true },
  });

  await notifyTemplateManagers(workspaceId, actorId, "Template activated", `${result.name} is now the active ${result.issueType} template`, result.id, { issueType: result.issueType, action: "activated" });

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

/* ── internal ────────────────────────────────────────────────────── */

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

  await notifyTemplateManagers(workspaceId, actorId, "Template activated", `${updated.name} is now the active ${updated.issueType} template`, updated.id, { issueType: updated.issueType, action: "activated" });

  await emitTemplateEvent(workspaceId, "template.activated", {
    workspaceId,
    templateId: updated.id,
    issueType: updated.issueType,
    isActive: true,
    updatedAt: updated.updatedAt,
  });

  return mapTemplate(updated);
}
