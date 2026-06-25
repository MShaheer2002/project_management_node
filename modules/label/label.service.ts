import type { WorkspaceRole } from "../../app/generated/prisma/client.js";

import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import { prisma } from "../../shared/utils/prisma.js";
import { logActivity } from "../../shared/utils/activity.js";
import { resolveIssueRouteId } from "../issue/issue.service.js";
import { triggerLabelRefreshForWorkspace } from "../ai/ai.background.js";
import type {
  AttachIssueLabelsInput,
  CreateLabelInput,
  ListLabelsQuery,
  UpdateLabelInput,
} from "./label.schemas.js";

const MAX_LABELS_PER_ISSUE = 20;

function normalizeLabelName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeLabelKey(value: string) {
  return normalizeLabelName(value).toLowerCase();
}

function mapLabel(label: any) {
  return {
    id: label.id,
    workspaceId: label.workspaceId,
    name: label.name,
    color: label.color,
    description: label.description,
    issueCount: label._count?.issues ?? undefined,
    createdAt: label.createdAt,
    updatedAt: label.updatedAt,
  };
}

async function assertLabelExistsInWorkspace(workspaceId: string, labelId: string) {
  const label = await prisma.label.findFirst({
    where: { id: labelId, workspaceId },
    select: { id: true },
  });
  if (!label) {
    throw new AppError(404, ERROR_CODES.LABEL_NOT_FOUND, "Label not found");
  }
}

async function assertIssueLabelWriteAccess(workspaceId: string, workspaceRole: WorkspaceRole, userId: string, issueId: string) {
  const issue = await prisma.issue.findFirst({
    where: {
      id: issueId,
      workspaceId,
      ...(workspaceRole === "OWNER" || workspaceRole === "ADMIN"
        ? {}
        : {
            OR: [
              { project: { leadId: userId } },
              { project: { memberships: { some: { userId } } } },
            ],
          }),
    },
    select: { id: true },
  });

  if (!issue) {
    const exists = await prisma.issue.findFirst({ where: { id: issueId, workspaceId }, select: { id: true } });
    if (!exists) {
      throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
    }
    throw new AppError(403, ERROR_CODES.FORBIDDEN, "You cannot modify labels for this issue");
  }
}

export async function createLabel(workspaceId: string, actorId: string, input: CreateLabelInput) {
  const name = normalizeLabelName(input.name);
  const normalizedName = normalizeLabelKey(name);

  const existing = await prisma.label.findFirst({
    where: { workspaceId, normalizedName },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(409, ERROR_CODES.LABEL_ALREADY_EXISTS, "Label already exists");
  }

  const label = await prisma.label.create({
    data: {
      workspaceId,
      name,
      normalizedName,
      color: input.color,
      description: input.description ?? null,
    },
    include: { _count: { select: { issues: true } } },
  });

  await logActivity({
    workspaceId,
    actorId,
    type: "LABEL_CREATED",
    targetType: "LABEL",
    targetId: label.id,
    message: `${label.name} label created`,
    metadata: { labelId: label.id, labelName: label.name, color: label.color },
  });

  await triggerLabelRefreshForWorkspace({ workspaceId, triggeredByUserId: actorId });
  return mapLabel(label);
}

export async function listLabels(workspaceId: string, query: ListLabelsQuery) {
  const limit = clampListLimit(query.limit, 50);
  const where: any = {
    workspaceId,
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: "insensitive" } },
            { description: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const orderBy = query.sort === "usage:desc"
    ? [{ issues: { _count: "desc" } }, { name: "asc" }, { id: "asc" }]
    : [{ name: "asc" }, { id: "asc" }];

  const [total, records] = await Promise.all([
    prisma.label.count({ where }),
    prisma.label.findMany({
      where,
      orderBy: orderBy as any,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: limit + 1,
      include: { _count: { select: { issues: true } } },
    }),
  ]);

  const page = slicePage(records, limit);
  return {
    items: page.items.map(mapLabel),
    meta: {
      total,
      cursor: page.hasMore ? page.items[page.items.length - 1]?.id ?? null : null,
      hasMore: page.hasMore,
    },
  };
}

export async function updateLabel(workspaceId: string, actorId: string, labelId: string, input: UpdateLabelInput) {
  const current = await prisma.label.findFirst({ where: { id: labelId, workspaceId } }) as any;
  if (!current) {
    throw new AppError(404, ERROR_CODES.LABEL_NOT_FOUND, "Label not found");
  }

  const nextName = input.name !== undefined ? normalizeLabelName(input.name) : current.name;
  const nextNormalizedName = input.name !== undefined ? normalizeLabelKey(input.name) : current.normalizedName;

  if (nextNormalizedName !== current.normalizedName) {
    const duplicate = await prisma.label.findFirst({
      where: {
        workspaceId,
        normalizedName: nextNormalizedName,
        id: { not: labelId },
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new AppError(409, ERROR_CODES.LABEL_ALREADY_EXISTS, "Label already exists");
    }
  }

  const updated = await prisma.label.update({
    where: { id: labelId },
    data: {
      ...(input.name !== undefined ? { name: nextName, normalizedName: nextNormalizedName } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    },
    include: { _count: { select: { issues: true } } },
  });

  await logActivity({
    workspaceId,
    actorId,
    type: "LABEL_UPDATED",
    targetType: "LABEL",
    targetId: updated.id,
    message: `${updated.name} label updated`,
    metadata: { labelId: updated.id, labelName: updated.name, color: updated.color },
  });

  await triggerLabelRefreshForWorkspace({ workspaceId, triggeredByUserId: actorId });
  return mapLabel(updated);
}

export async function deleteLabel(workspaceId: string, actorId: string, labelId: string) {
  await assertLabelExistsInWorkspace(workspaceId, labelId);
  await prisma.label.delete({ where: { id: labelId } });
  await logActivity({
    workspaceId,
    actorId,
    type: "LABEL_DELETED",
    targetType: "LABEL",
    targetId: labelId,
    message: "Label deleted",
    metadata: { labelId },
  });

  await triggerLabelRefreshForWorkspace({ workspaceId, triggeredByUserId: actorId });
}

export async function attachIssueLabels(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  userId: string,
  issueIdentifier: string,
  input: AttachIssueLabelsInput,
) {
  const issueId = await resolveIssueRouteId(workspaceId, issueIdentifier);
  await assertIssueLabelWriteAccess(workspaceId, workspaceRole, userId, issueId);

  const dedupedLabelIds = [...new Set(input.labelIds)];
  const labels = await prisma.label.findMany({
    where: { id: { in: dedupedLabelIds }, workspaceId },
    select: { id: true },
  });
  if (labels.length !== dedupedLabelIds.length) {
    throw new AppError(404, ERROR_CODES.LABEL_NOT_FOUND, "One or more labels not found");
  }

  const currentCount = await prisma.issueLabel.count({ where: { issueId } });
  const existingRows = await prisma.issueLabel.findMany({
    where: { issueId, labelId: { in: dedupedLabelIds } },
    select: { labelId: true },
  });
  const existingSet = new Set(existingRows.map((row) => row.labelId));
  const toAdd = dedupedLabelIds.filter((labelId) => !existingSet.has(labelId));
  if (currentCount + toAdd.length > MAX_LABELS_PER_ISSUE) {
    throw new AppError(409, ERROR_CODES.ISSUE_LABEL_LIMIT_REACHED, "Issue label limit reached");
  }

  if (toAdd.length > 0) {
    await prisma.issueLabel.createMany({
      data: toAdd.map((labelId) => ({ issueId, labelId })),
      skipDuplicates: true,
    });
  }

  const issueLabels = await prisma.issueLabel.findMany({
    where: { issueId },
    include: { label: true } as any,
    orderBy: [{ label: { name: "asc" } }],
  }) as any[];

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "ISSUE_LABEL_ADDED",
    targetType: "ISSUE",
    targetId: issueId,
    message: "Labels added to issue",
    metadata: { issueId, labelIds: toAdd },
  });
  return {
    issueId,
    labels: issueLabels.map((row) => ({
      id: row.label!.id,
      workspaceId: row.label!.workspaceId,
      name: row.label!.name,
      color: row.label!.color,
      description: row.label!.description,
      createdAt: row.label!.createdAt,
      updatedAt: row.label!.updatedAt,
    })),
  };
}

export async function removeIssueLabel(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  userId: string,
  issueIdentifier: string,
  labelId: string,
) {
  const issueId = await resolveIssueRouteId(workspaceId, issueIdentifier);
  await assertIssueLabelWriteAccess(workspaceId, workspaceRole, userId, issueId);
  await assertLabelExistsInWorkspace(workspaceId, labelId);

  await prisma.issueLabel.deleteMany({ where: { issueId, labelId } });

  const issueLabels = await prisma.issueLabel.findMany({
    where: { issueId },
    include: { label: true } as any,
    orderBy: [{ label: { name: "asc" } }],
  }) as any[];

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "ISSUE_LABEL_REMOVED",
    targetType: "ISSUE",
    targetId: issueId,
    message: "Label removed from issue",
    metadata: { issueId, labelId },
  });
  return {
    issueId,
    labels: issueLabels.map((row) => ({
      id: row.label!.id,
      workspaceId: row.label!.workspaceId,
      name: row.label!.name,
      color: row.label!.color,
      description: row.label!.description,
      createdAt: row.label!.createdAt,
      updatedAt: row.label!.updatedAt,
    })),
  };
}
