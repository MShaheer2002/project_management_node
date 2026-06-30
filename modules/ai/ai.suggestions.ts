import type { WorkspaceRole } from "../../app/generated/prisma/client.js";

import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import { prisma } from "../../shared/utils/prisma.js";
import type {
  AcceptSuggestionInput,
  DismissSuggestionInput,
  ListSuggestionsInput,
  RunSuggestionsInput,
} from "./ai.schemas.js";
import {
  triggerCycleBackgroundJobs,
  triggerIssueBackgroundJobs,
  triggerProactiveSummary,
  triggerStaleScan,
  triggerWeeklyDigest,
} from "./ai.background.js";
import { updateIssue } from "../issue/issue.service.js";
import { assignIssueToCycle } from "../cycle/cycle.service.js";
import { logActivity } from "../../shared/utils/activity.js";

function isAdminRole(role: WorkspaceRole) {
  return role === "OWNER" || role === "ADMIN";
}

async function expireVisibleSuggestions(workspaceId: string) {
  await (prisma as any).aiSuggestion.updateMany({
    where: {
      workspaceId,
      status: "OPEN",
      expiresAt: { lte: new Date() },
    },
    data: {
      status: "EXPIRED",
    },
  });
}

async function canAccessIssue(workspaceId: string, userId: string, role: WorkspaceRole, issueId: string) {
  const issue = await prisma.issue.findFirst({
    where: {
      id: issueId,
      workspaceId,
      ...(isAdminRole(role)
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
  return Boolean(issue);
}

async function canAccessProject(workspaceId: string, userId: string, role: WorkspaceRole, projectId: string) {
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      workspaceId,
      ...(isAdminRole(role)
        ? {}
        : {
            OR: [
              { visibility: "PUBLIC" },
              { leadId: userId },
              { memberships: { some: { userId } } },
            ],
          }),
    },
    select: { id: true },
  });
  return Boolean(project);
}

async function canAccessTeam(workspaceId: string, userId: string, role: WorkspaceRole, teamId: string) {
  if (isAdminRole(role)) {
    const team = await prisma.team.findFirst({
      where: { id: teamId, workspaceId },
      select: { id: true },
    });
    return Boolean(team);
  }

  const team = await prisma.team.findFirst({
    where: { id: teamId, workspaceId },
    select: { id: true, leadId: true },
  });
  if (!team) return false;

  if (team.leadId === userId) {
    return true;
  }

  const membership = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { userId, teamId } },
    select: { userId: true },
  });
  return Boolean(membership);
}

async function canAccessCycle(workspaceId: string, userId: string, role: WorkspaceRole, cycleId: string) {
  if (isAdminRole(role)) {
    const cycle = await prisma.cycle.findFirst({ where: { id: cycleId, workspaceId }, select: { id: true } });
    return Boolean(cycle);
  }

  const cycle = await prisma.cycle.findFirst({
    where: { id: cycleId, workspaceId },
    select: {
      id: true,
      teamId: true,
    },
  });
  if (!cycle) return false;

  const team = await prisma.team.findFirst({
    where: { id: cycle.teamId, workspaceId },
    select: { leadId: true },
  });
  if (team?.leadId === userId) {
    return true;
  }

  const membership = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { userId, teamId: cycle.teamId } },
    select: { userId: true },
  });
  return Boolean(membership);
}

async function canAccessSuggestion(workspaceId: string, userId: string, role: WorkspaceRole, suggestion: {
  targetType: string;
  targetId: string;
  type: string;
}) {
  const targetType = suggestion.targetType.toLowerCase();

  if (targetType === "issue") {
    return canAccessIssue(workspaceId, userId, role, suggestion.targetId);
  }

  if (targetType === "project") {
    return canAccessProject(workspaceId, userId, role, suggestion.targetId);
  }

  if (targetType === "team") {
    return canAccessTeam(workspaceId, userId, role, suggestion.targetId);
  }

  if (targetType === "cycle") {
    return canAccessCycle(workspaceId, userId, role, suggestion.targetId);
  }

  if (targetType === "workspace") {
    return isAdminRole(role);
  }

  return true;
}

function mapSuggestion(item: any) {
  return {
    id: item.id,
    type: item.type,
    status: item.status,
    source: item.source,
    targetType: item.targetType,
    targetId: item.targetId,
    title: item.title,
    message: item.message,
    confidence: item.confidence,
    reason: item.reason,
    payload: item.payload,
    model: item.model,
    createdByUserId: item.createdByUserId,
    acceptedById: item.acceptedById,
    dismissedById: item.dismissedById,
    acceptedAt: item.acceptedAt,
    dismissedAt: item.dismissedAt,
    expiresAt: item.expiresAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export async function listSuggestions(workspaceId: string, userId: string, role: WorkspaceRole, query: ListSuggestionsInput) {
  await expireVisibleSuggestions(workspaceId);
  const limit = clampListLimit(query.limit, 20);

  const records = await (prisma as any).aiSuggestion.findMany({
    where: {
      workspaceId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    take: limit + 20,
  });

  const visible: typeof records = [];
  for (const record of records) {
    if (await canAccessSuggestion(workspaceId, userId, role, record)) {
      visible.push(record);
    }
    if (visible.length >= limit + 1) break;
  }

  const page = slicePage(visible, limit);
  return {
    items: page.items.map(mapSuggestion),
    meta: {
      total: page.items.length,
      cursor: page.hasMore ? ((page.items[page.items.length - 1] as any)?.id ?? null) : null,
      hasMore: page.hasMore,
    },
  };
}

async function getOpenSuggestionOrThrow(id: string, workspaceId: string) {
  await expireVisibleSuggestions(workspaceId);
  const suggestion = await (prisma as any).aiSuggestion.findFirst({
    where: { id, workspaceId },
  });

  if (!suggestion) {
    throw new AppError(404, ERROR_CODES.AI_SUGGESTION_NOT_FOUND, "Suggestion not found");
  }
  if (suggestion.status !== "OPEN") {
    throw new AppError(409, ERROR_CODES.AI_SUGGESTION_NOT_OPEN, "Suggestion is no longer open");
  }

  return suggestion;
}

async function claimSuggestionAcceptance(id: string, workspaceId: string, userId: string) {
  const now = new Date();
  const result = await (prisma as any).aiSuggestion.updateMany({
    where: { id, workspaceId, status: "OPEN" },
    data: {
      status: "ACCEPTED",
      acceptedById: userId,
      acceptedAt: now,
      dismissedById: null,
      dismissedAt: null,
    },
  });

  if (result.count !== 1) {
    throw new AppError(409, ERROR_CODES.AI_SUGGESTION_NOT_OPEN, "Suggestion is no longer open");
  }

  return now;
}

async function rollbackAcceptedSuggestion(id: string, workspaceId: string) {
  await (prisma as any).aiSuggestion.updateMany({
    where: { id, workspaceId, status: "ACCEPTED" },
    data: {
      status: "OPEN",
      acceptedById: null,
      acceptedAt: null,
    },
  }).catch(() => {});
}

export async function acceptSuggestion(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
  id: string,
  input: AcceptSuggestionInput,
) {
  const suggestion = await getOpenSuggestionOrThrow(id, workspaceId);
  const allowed = await canAccessSuggestion(workspaceId, userId, role, suggestion);
  if (!allowed) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, "You do not have access to this suggestion");
  }

  if (!["ASSIGNEE", "PRIORITY", "LABEL", "SPRINT_PLANNING"].includes(suggestion.type)) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "This suggestion is informational only and cannot be applied");
  }

  const payload = (suggestion.payload ?? {}) as Record<string, unknown>;
  await claimSuggestionAcceptance(suggestion.id, workspaceId, userId);

  try {
    if (suggestion.type === "ASSIGNEE") {
      const candidates = Array.isArray(payload.candidates) ? payload.candidates as Array<Record<string, unknown>> : [];
      const selectedUserId = input.selectedIds?.[0] ?? (typeof candidates[0]?.userId === "string" ? candidates[0].userId : undefined);
      if (!selectedUserId) {
        throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "No assignee candidate selected");
      }
      await updateIssue(workspaceId, suggestion.targetId, userId, { assigneeId: selectedUserId });
    } else if (suggestion.type === "PRIORITY") {
      const selectedPriority = typeof payload.suggestedPriority === "string" ? payload.suggestedPriority : undefined;
      if (!selectedPriority || !["low", "medium", "high", "urgent"].includes(selectedPriority)) {
        throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "Invalid suggested priority");
      }
      await updateIssue(workspaceId, suggestion.targetId, userId, { priority: selectedPriority as any });
    } else if (suggestion.type === "LABEL") {
      const currentIssue = await prisma.issue.findFirst({
        where: { id: suggestion.targetId, workspaceId },
        select: {
          labels: { include: { label: { select: { id: true, name: true } } } },
        },
      });
      if (!currentIssue) {
        throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
      }
      const suggestedLabels = Array.isArray(payload.labels) ? payload.labels as Array<Record<string, unknown>> : [];
      const selectedIds = input.selectedIds && input.selectedIds.length > 0
        ? new Set(input.selectedIds)
        : new Set(suggestedLabels.map((label) => String(label.labelId)));
      const selectedNames = suggestedLabels
        .filter((label) => selectedIds.has(String(label.labelId)))
        .map((label) => String(label.name))
        .filter(Boolean);

      await updateIssue(workspaceId, suggestion.targetId, userId, {
        labels: [
          ...new Set([
            ...currentIssue.labels.map((label) => label.label.name),
            ...selectedNames,
          ]),
        ],
      });
    } else if (suggestion.type === "SPRINT_PLANNING") {
      const candidates = Array.isArray(payload.candidates) ? payload.candidates as Array<Record<string, unknown>> : [];
      const cycleId = typeof payload.cycleId === "string" ? payload.cycleId : suggestion.targetId;
      const selectedIssueIds = input.selectedIds && input.selectedIds.length > 0
        ? input.selectedIds
        : candidates.map((candidate) => String(candidate.issueId)).filter(Boolean);

      for (const issueId of selectedIssueIds) {
        await assignIssueToCycle(workspaceId, issueId, userId, role, { cycleId });
      }
    }
  } catch (error) {
    await rollbackAcceptedSuggestion(suggestion.id, workspaceId);
    throw error;
  }

  const updated = await (prisma as any).aiSuggestion.findFirst({
    where: { id: suggestion.id, workspaceId },
  });
  if (!updated) {
    throw new AppError(404, ERROR_CODES.AI_SUGGESTION_NOT_FOUND, "Suggestion not found");
  }

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "AI_ACTION_EXECUTED",
    targetType: "WORKSPACE",
    targetId: suggestion.targetId,
    message: `Accepted AI suggestion ${suggestion.id}`,
    metadata: {
      suggestionId: suggestion.id,
      suggestionType: suggestion.type,
      targetType: suggestion.targetType,
      entityId: suggestion.targetId,
    },
  });

  return mapSuggestion(updated);
}

export async function dismissSuggestion(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
  id: string,
  input: DismissSuggestionInput,
) {
  const suggestion = await getOpenSuggestionOrThrow(id, workspaceId);
  const allowed = await canAccessSuggestion(workspaceId, userId, role, suggestion);
  if (!allowed) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, "You do not have access to this suggestion");
  }

  const result = await (prisma as any).aiSuggestion.updateMany({
    where: { id: suggestion.id, workspaceId, status: "OPEN" },
    data: {
      status: "DISMISSED",
      dismissedById: userId,
      dismissedAt: new Date(),
      acceptedById: null,
      acceptedAt: null,
      reason: input.reason ?? suggestion.reason,
    },
  });

  if (result.count !== 1) {
    throw new AppError(409, ERROR_CODES.AI_SUGGESTION_NOT_OPEN, "Suggestion is no longer open");
  }

  const updated = await (prisma as any).aiSuggestion.findFirst({
    where: { id: suggestion.id, workspaceId },
  });
  if (!updated) {
    throw new AppError(404, ERROR_CODES.AI_SUGGESTION_NOT_FOUND, "Suggestion not found");
  }

  return mapSuggestion(updated);
}

export async function runSuggestionJobs(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
  input: RunSuggestionsInput,
) {
  if (!isAdminRole(role)) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, "Only admins and owners can rerun background AI jobs");
  }

  let queuedAny = false;

  if (input.targetType === "issue") {
    const includeEmbedding = input.jobs.includes("embedding") || input.jobs.includes("duplicate");
    const includeIssueIntelligence = input.jobs.some((job) =>
      ["labels", "priority", "duplicate", "assignee"].includes(job),
    );

    if (includeEmbedding || includeIssueIntelligence) {
      await triggerIssueBackgroundJobs(
        {
          workspaceId,
          issueId: input.targetId,
          triggeredByUserId: userId,
          reason: "manual",
        },
        {
          includeEmbedding,
          includeIssueIntelligence,
          includeScopeSummaries: false,
        },
      );
      queuedAny = true;
    }
  } else if (input.targetType === "cycle") {
    const includeSprintPlanning = input.jobs.includes("sprint-planning");
    const includeHealthSummary = input.jobs.includes("cycle-health");
    if (includeSprintPlanning || includeHealthSummary) {
      await triggerCycleBackgroundJobs({
        workspaceId,
        cycleId: input.targetId,
        triggeredByUserId: userId,
        reason: "manual",
      }, {
        includeSprintPlanning,
        includeHealthSummary,
      });
      queuedAny = true;
    }
  } else if (input.targetType === "project") {
    if (input.jobs.includes("project-health")) {
      await triggerProactiveSummary({
        workspaceId,
        scope: "project",
        scopeId: input.targetId,
        triggeredByUserId: userId,
        reason: "manual",
      });
      queuedAny = true;
    }
  } else if (input.targetType === "team") {
    if (input.jobs.includes("team-health")) {
      await triggerProactiveSummary({
        workspaceId,
        scope: "team",
        scopeId: input.targetId,
        triggeredByUserId: userId,
        reason: "manual",
      });
      queuedAny = true;
    }
  } else if (input.targetType === "workspace") {
    if (input.jobs.includes("stale-scan")) {
      await triggerStaleScan({ workspaceId, triggeredByUserId: userId, reason: "manual" });
      queuedAny = true;
    }
    if (input.jobs.includes("weekly-digest")) {
      await triggerWeeklyDigest({ workspaceId, triggeredByUserId: userId, reason: "manual" });
      queuedAny = true;
    }
  }

  if (!queuedAny) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "No supported background jobs were selected for this target type");
  }

  return {
    status: "queued",
    targetType: input.targetType,
    targetId: input.targetId,
    jobs: input.jobs,
  };
}
