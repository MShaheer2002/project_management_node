import { prisma } from "../../shared/utils/prisma.js";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/utils/api-error.js";
import { AiSuggestionType } from "../../app/generated/prisma/client.js";
import { runOverdueIssueAutomation } from "../../shared/workflow/workflow-automation-runtime.js";
import { logAiError, logAiInfo, logAiWarn } from "./ai.observability.js";
import { upsertEntityAliases } from "./ai.entity-aliases.js";
import { detectPriority } from "./ai.rules.js";
import {
  buildCycleHealthSummary,
  buildProjectHealthSummary,
  buildTeamHealthSummary,
  buildWorkspaceDigestPayload,
} from "./ai.background-summaries.js";
import {
  enqueueEmbedding,
  enqueueIssueIntelligence,
  enqueueProactiveSummary,
  enqueueSprintPlanning,
  enqueueStaleScan,
  enqueueWeeklyDigest,
  type EmbeddingJob,
  type IssueIntelligenceJob,
  type ProactiveSummaryJob,
  type SprintPlanningJob,
  type StaleScanJob,
  type WeeklyDigestJob,
} from "./ai.jobs.js";
import { buildEmbeddingContent } from "./ai.embedding-content.js";
import {
  findSimilarIssueEmbeddings,
  findSimilarIssuesByText,
  storeEntityEmbedding,
  generateAndStoreIssueEmbedding,
} from "./ai.embeddings.js";

const LABEL_ALIAS_MAP: Record<string, string[]> = {
  authentication: ["auth", "login", "signin", "sign-in", "oauth", "sso"],
  payments: ["payment", "billing", "invoice", "stripe", "checkout"],
  mobile: ["android", "ios", "mobile", "tablet"],
  frontend: ["ui", "frontend", "client", "browser", "react"],
  backend: ["backend", "api", "server", "endpoint", "database"],
  performance: ["slow", "latency", "performance", "timeout", "lag"],
  security: ["security", "vulnerability", "exploit", "breach"],
};

type IssueIntelligenceReason = IssueIntelligenceJob["reason"];
type SuggestionType = typeof AiSuggestionType[keyof typeof AiSuggestionType];
const STALE_SUGGESTION_COOLDOWN_DAYS = 7;
const ISSUE_SUGGESTION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function summarizeError(error: unknown) {
  return error instanceof Error ? error.message : "Unknown background AI failure";
}

async function createJobRun(input: {
  workspaceId?: string | undefined;
  jobName: string;
  jobId?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
}) {
  return (prisma as any).aiJobRun.create({
    data: {
      workspaceId: input.workspaceId ?? null,
      jobName: input.jobName,
      jobId: input.jobId ?? null,
      status: "STARTED",
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
    },
  });
}

async function finishJobRun(id: string, status: "SUCCEEDED" | "FAILED" | "SKIPPED", metadata?: Record<string, unknown>, errorCode?: string, errorMessage?: string) {
  await (prisma as any).aiJobRun.update({
    where: { id },
    data: {
      status,
      metadata: metadata ?? null,
      errorCode: errorCode ?? null,
      errorMessage: errorMessage ?? null,
      finishedAt: new Date(),
    },
  }).catch(() => {});
}

function dedupeVersion(date: Date) {
  return date.toISOString();
}

async function expireOpenSuggestions(workspaceId: string, targetType?: string, targetId?: string) {
  await (prisma as any).aiSuggestion.updateMany({
    where: {
      workspaceId,
      status: "OPEN",
      expiresAt: { lte: new Date() },
      ...(targetType ? { targetType } : {}),
      ...(targetId ? { targetId } : {}),
    },
    data: {
      status: "EXPIRED",
    },
  });
}

async function markSuggestionsSuperseded(workspaceId: string, targetType: string, targetId: string, types: SuggestionType[]) {
  await expireOpenSuggestions(workspaceId, targetType, targetId);
  await (prisma as any).aiSuggestion.updateMany({
    where: {
      workspaceId,
      targetType,
      targetId,
      type: { in: types as any },
      status: "OPEN",
    },
    data: {
      status: "SUPERSEDED",
    },
  });
}

async function upsertSuggestion(input: {
  workspaceId: string;
  type: SuggestionType;
  source: "RULE" | "EMBEDDING" | "AI_MODEL" | "SQL" | "TEMPLATE" | "SYSTEM";
  targetType: string;
  targetId: string;
  title: string;
  message: string;
  confidence?: number | undefined;
  reason?: string | undefined;
  payload: Record<string, unknown>;
  dedupeKey: string;
  model?: string | null | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  createdByUserId?: string | undefined;
  expiresAt?: Date | null | undefined;
}) {
  const payload = {
    ...input.payload,
    anchor: {
      targetType: input.targetType,
      targetId: input.targetId,
      ...((input.payload.anchor ?? {}) as Record<string, unknown>),
    },
    lifecycle: {
      dedupeKey: input.dedupeKey,
      expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
    },
  };

  return (prisma as any).aiSuggestion.upsert({
    where: {
      workspaceId_dedupeKey: {
        workspaceId: input.workspaceId,
        dedupeKey: input.dedupeKey,
      },
    },
    create: {
      workspaceId: input.workspaceId,
      type: input.type,
      status: "OPEN",
      source: input.source,
      targetType: input.targetType,
      targetId: input.targetId,
      title: input.title,
      message: input.message,
      confidence: input.confidence,
      reason: input.reason ?? null,
      payload,
      dedupeKey: input.dedupeKey,
      model: input.model ?? null,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      createdByUserId: input.createdByUserId ?? null,
      expiresAt: input.expiresAt ?? null,
    },
    update: {
      status: "OPEN",
      source: input.source,
      title: input.title,
      message: input.message,
      confidence: input.confidence,
      reason: input.reason ?? null,
      payload,
      model: input.model ?? null,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      createdByUserId: input.createdByUserId ?? null,
      acceptedById: null,
      dismissedById: null,
      acceptedAt: null,
      dismissedAt: null,
      expiresAt: input.expiresAt ?? null,
    },
  });
}

async function notifySuggestionRecipients(input: {
  workspaceId: string;
  suggestionId: string;
  title: string;
  message: string;
  targetType: "issue" | "workspace" | "team" | "project";
  targetId: string;
  targetPublicId?: string | null;
  targetUrl: string;
  recipientUserIds: string[];
  metadata?: Record<string, unknown>;
}) {
  const { createNotification } = await import("../notification/notification.service.js");

  await Promise.all(
    [...new Set(input.recipientUserIds)].map((recipientUserId) =>
      createNotification({
        workspaceId: input.workspaceId,
        recipientUserId,
        actorUserId: null,
        type: "UPDATE",
        category: "update",
        title: input.title,
        message: input.message,
        target: {
          type: input.targetType,
          id: input.targetId,
          publicId: input.targetPublicId ?? null,
          url: input.targetUrl,
        },
        metadata: {
          suggestionId: input.suggestionId,
          ...(input.metadata ?? {}),
        },
        dedupeKey: `ai-suggestion:${input.suggestionId}:${recipientUserId}`,
      }),
    ),
  );
}

function shouldNotifySuggestion(type: SuggestionType) {
  // Inbox should only carry high-signal AI summaries and alerts.
  // Issue-level suggestions belong in issue/create UI, not notifications.
  return [
    "STALE_ISSUE",
    "WEEKLY_DIGEST",
    "SPRINT_PLANNING",
    "PROJECT_HEALTH",
    "TEAM_HEALTH",
    "CYCLE_HEALTH",
  ].includes(type);
}

async function notifySuggestionRecipientsIfRelevant(input: {
  workspaceId: string;
  suggestionId: string;
  suggestionType: SuggestionType;
  title: string;
  message: string;
  targetType: "issue" | "workspace" | "team" | "project";
  targetId: string;
  targetPublicId?: string | null;
  targetUrl: string;
  recipientUserIds: string[];
  metadata?: Record<string, unknown>;
}) {
  if (!shouldNotifySuggestion(input.suggestionType)) {
    return;
  }

  await notifySuggestionRecipients({
    workspaceId: input.workspaceId,
    suggestionId: input.suggestionId,
    title: input.title,
    message: input.message,
    targetType: input.targetType,
    targetId: input.targetId,
    ...(input.targetPublicId !== undefined ? { targetPublicId: input.targetPublicId } : {}),
    targetUrl: input.targetUrl,
    recipientUserIds: input.recipientUserIds,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  });
}

function normalizePriority(priority: string) {
  return priority.toLowerCase();
}

function labelSignals(text: string, labelName: string) {
  const normalizedText = text.toLowerCase();
  const normalizedLabel = labelName.toLowerCase();
  const aliases = LABEL_ALIAS_MAP[normalizedLabel] ?? [];

  if (normalizedText.includes(normalizedLabel)) return 0.9;
  if (aliases.some((alias) => normalizedText.includes(alias))) return 0.7;
  return 0;
}

async function suggestLabelsForIssue(input: {
  workspaceId: string;
  issueId: string;
  title: string;
  description?: string | null | undefined;
  currentLabels: string[];
  updatedAt: Date;
  createdByUserId?: string | undefined;
}) {
  const labels = await prisma.label.findMany({
    where: { workspaceId: input.workspaceId },
    select: { id: true, name: true },
    take: 100,
  });

  const text = `${input.title}\n${input.description ?? ""}`;
  const matches = labels
    .map((label) => ({
      labelId: label.id,
      name: label.name,
      confidence: labelSignals(text, label.name),
    }))
    .filter((label) => label.confidence > 0 && !input.currentLabels.some((current) => current.toLowerCase() === label.name.toLowerCase()))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);

  if (matches.length === 0) return null;

  return upsertSuggestion({
    workspaceId: input.workspaceId,
    type: "LABEL",
    source: "RULE",
    targetType: "issue",
    targetId: input.issueId,
    title: "Suggested labels",
    message: `Suggested ${matches.length} label${matches.length === 1 ? "" : "s"} for this issue.`,
    confidence: matches[0]?.confidence,
    reason: "Matched the issue text against existing workspace label names and aliases.",
    payload: { issueId: input.issueId, labels: matches },
    dedupeKey: `label:issue:${input.issueId}:version:${dedupeVersion(input.updatedAt)}`,
    createdByUserId: input.createdByUserId,
    expiresAt: new Date(Date.now() + ISSUE_SUGGESTION_TTL_MS),
  });
}

async function suggestPriorityForIssue(input: {
  workspaceId: string;
  issueId: string;
  title: string;
  description?: string | null | undefined;
  currentPriority: string;
  updatedAt: Date;
  createdByUserId?: string | undefined;
}) {
  const suggestedPriority = detectPriority(`${input.title}\n${input.description ?? ""}`);
  if (!suggestedPriority) return null;
  if (suggestedPriority === normalizePriority(input.currentPriority)) return null;

  return upsertSuggestion({
    workspaceId: input.workspaceId,
    type: "PRIORITY",
    source: "RULE",
    targetType: "issue",
    targetId: input.issueId,
    title: "Suggested priority change",
    message: `This issue looks more like ${suggestedPriority} priority than ${normalizePriority(input.currentPriority)}.`,
    confidence: suggestedPriority === "urgent" ? 0.95 : 0.8,
    reason: "Matched urgency and severity signals from the issue title and description.",
    payload: {
      issueId: input.issueId,
      currentPriority: normalizePriority(input.currentPriority),
      suggestedPriority,
    },
    dedupeKey: `priority:issue:${input.issueId}:priority:${suggestedPriority}:version:${dedupeVersion(input.updatedAt)}`,
    createdByUserId: input.createdByUserId,
    expiresAt: new Date(Date.now() + ISSUE_SUGGESTION_TTL_MS),
  });
}

async function suggestAssigneeForIssue(input: {
  workspaceId: string;
  issueId: string;
  teamId: string;
  projectId: string;
  updatedAt: Date;
  createdByUserId?: string | undefined;
}) {
  const [project, members, workloads] = await Promise.all([
    prisma.project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: { leadId: true },
    }),
    prisma.teamMembership.findMany({
      where: { teamId: input.teamId },
      select: {
        userId: true,
        user: { select: { name: true } },
      },
      take: 50,
    }),
    prisma.issue.groupBy({
      by: ["assigneeId"],
      where: {
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        status: { notIn: ["done", "DONE"] as any },
      },
      _count: true,
    }),
  ]);

  const workloadMap = new Map(workloads.filter((row) => row.assigneeId).map((row) => [row.assigneeId!, row._count]));

  const candidates = members
    .map((member) => {
      const activeIssueCount = workloadMap.get(member.userId) ?? 0;
      const score = Number((1 - Math.min(activeIssueCount, 8) / 10 + (project?.leadId === member.userId ? 0.25 : 0)).toFixed(3));
      return {
        userId: member.userId,
        name: member.user.name,
        score,
        reasons: [
          ...(project?.leadId === member.userId ? ["Project lead"] : []),
          `${activeIssueCount} active team issue${activeIssueCount === 1 ? "" : "s"}`,
        ],
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, env.AI_BACKGROUND_ASSIGNEE_CANDIDATE_LIMIT);

  if (candidates.length === 0) return null;
  if ((candidates[0]?.score ?? 0) < 0.35) return null;

  return upsertSuggestion({
    workspaceId: input.workspaceId,
    type: "ASSIGNEE",
    source: "RULE",
    targetType: "issue",
    targetId: input.issueId,
    title: "Suggested assignee",
    message: `Suggested ${candidates.length} assignee candidate${candidates.length === 1 ? "" : "s"} for this issue.`,
    confidence: candidates[0]?.score,
    reason: "Ranked project and team members using lead ownership and active workload.",
    payload: {
      issueId: input.issueId,
      candidates,
    },
    dedupeKey: `assignee:issue:${input.issueId}:version:${dedupeVersion(input.updatedAt)}`,
    createdByUserId: input.createdByUserId,
    expiresAt: new Date(Date.now() + ISSUE_SUGGESTION_TTL_MS),
  });
}

async function suggestDuplicatesByText(input: {
  workspaceId: string;
  issueId: string;
  title: string;
  description?: string | null | undefined;
  updatedAt: Date;
  createdByUserId?: string | undefined;
}) {
  const matches = await findSimilarIssuesByText({
    workspaceId: input.workspaceId,
    issueId: input.issueId,
    title: input.title,
    description: input.description,
    limit: 3,
  });

  if (matches.length === 0) return null;

  return upsertSuggestion({
    workspaceId: input.workspaceId,
    type: "DUPLICATE",
    source: "RULE",
    targetType: "issue",
    targetId: input.issueId,
    title: "Possible duplicate issue",
    message: `Found ${matches.length} similar issue${matches.length === 1 ? "" : "s"} using text similarity.`,
    confidence: matches[0]?.similarity,
    reason: "Compared normalized issue title and description against recent issues in the same workspace.",
    payload: {
      issueId: input.issueId,
      matches,
      strategy: "text",
    },
    dedupeKey: `duplicate:issue:${input.issueId}:version:${dedupeVersion(input.updatedAt)}:text`,
    createdByUserId: input.createdByUserId,
    expiresAt: new Date(Date.now() + ISSUE_SUGGESTION_TTL_MS),
  });
}

async function suggestDuplicatesByEmbedding(input: {
  workspaceId: string;
  issueId: string;
  title: string;
  description?: string | null | undefined;
  updatedAt: Date;
  createdByUserId?: string | undefined;
  triggeredByUserId?: string | undefined;
}) {
  const embeddingResult = await generateAndStoreIssueEmbedding({
    workspaceId: input.workspaceId,
    issueId: input.issueId,
    title: input.title,
    description: input.description,
    triggeredByUserId: input.triggeredByUserId,
  });

  if (!embeddingResult?.embedding) {
    return null;
  }

  const similarRows = await findSimilarIssueEmbeddings({
    workspaceId: input.workspaceId,
    issueId: input.issueId,
    embedding: embeddingResult.embedding,
    limit: 3,
  });

  if (similarRows.length === 0) return null;

  const issues = await prisma.issue.findMany({
    where: {
      workspaceId: input.workspaceId,
      id: { in: similarRows.map((row) => row.entityId) },
    },
    select: { id: true, title: true, status: true },
  });
  const issueMap = new Map(issues.map((issue) => [issue.id, issue]));
  const matches = similarRows
    .map((row) => {
      const issue = issueMap.get(row.entityId);
      if (!issue) return null;
      return {
        issueId: issue.id,
        title: issue.title,
        status: issue.status,
        similarity: Number(row.similarity.toFixed(4)),
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));

  if (matches.length === 0) return null;

  return upsertSuggestion({
    workspaceId: input.workspaceId,
    type: "DUPLICATE",
    source: "EMBEDDING",
    targetType: "issue",
    targetId: input.issueId,
    title: "Possible duplicate issue",
    message: `Found ${matches.length} semantically similar issue${matches.length === 1 ? "" : "s"} using embeddings.`,
    confidence: matches[0]?.similarity,
    reason: "Compared this issue embedding against the workspace issue embedding index.",
    payload: {
      issueId: input.issueId,
      matches,
      strategy: "embedding",
    },
    dedupeKey: `duplicate:issue:${input.issueId}:version:${dedupeVersion(input.updatedAt)}:embedding`,
    model: embeddingResult.model,
    inputTokens: embeddingResult.usage?.inputTokens ?? 0,
    outputTokens: 0,
    createdByUserId: input.createdByUserId,
    expiresAt: new Date(Date.now() + ISSUE_SUGGESTION_TTL_MS),
  });
}

async function getIssueSuggestionRecipients(workspaceId: string, issueId: string) {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: {
      creatorId: true,
      assigneeId: true,
      watchers: { select: { userId: true } },
    },
  });

  if (!issue) return [];

  return [...new Set([
    issue.creatorId,
    issue.assigneeId,
    ...issue.watchers.map((watcher) => watcher.userId),
  ].filter(Boolean) as string[])];
}

async function getSprintPlanningRecipientIds(workspaceId: string, teamId: string) {
  const [workspaceLeads, teamMembers] = await Promise.all([
    prisma.workspaceMembership.findMany({
      where: {
        workspaceId,
        role: { in: ["OWNER", "ADMIN"] as any },
      },
      select: { userId: true },
      take: 100,
    }),
    prisma.teamMembership.findMany({
      where: { teamId },
      select: { userId: true },
      take: 100,
    }),
  ]);

  return [...new Set([
    ...workspaceLeads.map((member) => member.userId),
    ...teamMembers.map((member) => member.userId),
  ])];
}

function getWindowKey(date: Date, days: number) {
  const windowMs = days * 24 * 60 * 60 * 1000;
  return Math.floor(date.getTime() / windowMs);
}

function normalizePriorityScore(priority: string) {
  const normalized = String(priority).toUpperCase();
  if (normalized === "URGENT") return 4;
  if (normalized === "HIGH") return 3;
  if (normalized === "MEDIUM") return 2;
  return 1;
}

function isDoneStatus(status: string) {
  return ["done", "DONE"].includes(status);
}

async function triggerBackgroundSafely(label: string, task: () => Promise<void>) {
  try {
    await task();
  } catch (error) {
    logAiWarn("ai_background_trigger_failed", {
      feature: "background",
      success: false,
      errorCode: `${label.toUpperCase()}_TRIGGER_FAILED`,
      errorMessage: summarizeError(error),
    });
  }
}

export async function triggerLabelRefreshForWorkspace(input: { workspaceId: string; triggeredByUserId?: string }) {
  await triggerBackgroundSafely("label-refresh", async () => {
    const issues = await prisma.issue.findMany({
      where: {
        workspaceId: input.workspaceId,
        completedAt: null,
      },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });

    await Promise.all(
      issues.map((issue) =>
        triggerIssueBackgroundJobs(
          {
            workspaceId: input.workspaceId,
            issueId: issue.id,
            triggeredByUserId: input.triggeredByUserId,
            reason: "updated",
          },
          {
            includeEmbedding: false,
            includeIssueIntelligence: true,
            includeScopeSummaries: false,
          },
        ),
      ),
    );
  });
}

export async function processIssueIntelligenceJob(payload: IssueIntelligenceJob, jobMeta?: { jobId?: string }) {
  const run = await createJobRun({
    workspaceId: payload.workspaceId,
    jobName: "issue-intelligence",
    jobId: jobMeta?.jobId,
    targetType: "issue",
    targetId: payload.issueId,
  });

  try {
    const issue = await prisma.issue.findFirst({
      where: { id: payload.issueId, workspaceId: payload.workspaceId },
      select: {
        id: true,
        internalId: true,
        title: true,
        description: true,
        priority: true,
        assigneeId: true,
        teamId: true,
        projectId: true,
        updatedAt: true,
        labels: { include: { label: { select: { name: true } } } },
      },
    });

    if (!issue) {
      await finishJobRun(run.id, "SKIPPED", { reason: "Issue not found" });
      return;
    }

    await markSuggestionsSuperseded(payload.workspaceId, "issue", issue.id, [
      "ASSIGNEE",
      "LABEL",
      "PRIORITY",
      "DUPLICATE",
      "STALE_ISSUE",
    ]);

    const currentLabels = issue.labels.map((label) => label.label.name);
    const [prioritySuggestion, labelSuggestion, assigneeSuggestion, duplicateSuggestion, recipients] = await Promise.all([
      suggestPriorityForIssue({
        workspaceId: payload.workspaceId,
        issueId: issue.id,
        title: issue.title,
        description: issue.description,
        currentPriority: issue.priority,
        updatedAt: issue.updatedAt,
        createdByUserId: payload.triggeredByUserId,
      }),
      suggestLabelsForIssue({
        workspaceId: payload.workspaceId,
        issueId: issue.id,
        title: issue.title,
        description: issue.description,
        currentLabels,
        updatedAt: issue.updatedAt,
        createdByUserId: payload.triggeredByUserId,
      }),
      issue.assigneeId ? Promise.resolve(null) : suggestAssigneeForIssue({
        workspaceId: payload.workspaceId,
        issueId: issue.id,
        teamId: issue.teamId,
        projectId: issue.projectId,
        updatedAt: issue.updatedAt,
        createdByUserId: payload.triggeredByUserId,
      }),
      suggestDuplicatesByText({
        workspaceId: payload.workspaceId,
        issueId: issue.id,
        title: issue.title,
        description: issue.description,
        updatedAt: issue.updatedAt,
        createdByUserId: payload.triggeredByUserId,
      }),
      getIssueSuggestionRecipients(payload.workspaceId, issue.id),
    ]);

    const suggestions = [prioritySuggestion, labelSuggestion, assigneeSuggestion, duplicateSuggestion].filter(Boolean);

    await Promise.all(
      suggestions
        .map((suggestion) =>
          notifySuggestionRecipientsIfRelevant({
            workspaceId: payload.workspaceId,
            suggestionId: suggestion!.id,
            suggestionType: suggestion!.type,
            title: suggestion!.title,
            message: suggestion!.message,
            targetType: "issue",
            targetId: issue.id,
            targetPublicId: issue.internalId ?? issue.id,
            targetUrl: `/issues/${issue.internalId ?? issue.id}`,
            recipientUserIds: recipients,
            metadata: {
              issueId: issue.id,
              suggestionType: suggestion!.type,
            },
          }),
        ),
    );

    logAiInfo("ai_background_job_succeeded", {
      workspaceId: payload.workspaceId,
      feature: "background",
      success: true,
      metadata: {
        jobName: "issue-intelligence",
        issueId: payload.issueId,
        reason: payload.reason,
        suggestionsCreated: suggestions.length,
      },
    });

    await finishJobRun(run.id, "SUCCEEDED", {
      suggestionsCreated: suggestions.length,
      issueId: payload.issueId,
    });
  } catch (error) {
    logAiError("ai_background_job_failed", {
      workspaceId: payload.workspaceId,
      feature: "background",
      success: false,
      errorCode: "ISSUE_INTELLIGENCE_FAILED",
      errorMessage: summarizeError(error),
      metadata: { issueId: payload.issueId, reason: payload.reason },
    });
    await finishJobRun(run.id, "FAILED", undefined, "ISSUE_INTELLIGENCE_FAILED", summarizeError(error));
    throw error;
  }
}

/**
 * Indexes one entity for semantic search, and — for issues only — checks it
 * against existing work for possible duplicates.
 *
 * Content rendering is delegated to ai.embedding-content.ts so this worker and
 * the backfill job embed identical text for the same entity. They previously
 * diverged: the content shape lived inline here, which meant any other path
 * producing embeddings could quietly build vectors that were not comparable.
 */
export async function processEmbeddingJob(payload: EmbeddingJob, jobMeta?: { jobId?: string }) {
  const run = await createJobRun({
    workspaceId: payload.workspaceId,
    jobName: "embedding",
    jobId: jobMeta?.jobId,
    targetType: payload.entityType.toLowerCase(),
    targetId: payload.entityId,
  });

  try {
    const built = await buildEmbeddingContent(
      payload.entityType,
      payload.entityId,
      payload.workspaceId,
    );

    // Entities are routinely deleted between a job being queued and run, and an
    // entity can legitimately have nothing worth embedding (an empty comment).
    // Neither is an error.
    if (!built || !built.content) {
      await finishJobRun(run.id, "SKIPPED", {
        reason: built ? "No embeddable content" : "Entity not found",
        entityType: payload.entityType,
        entityId: payload.entityId,
      });
      return;
    }

    await storeEntityEmbedding({
      workspaceId: payload.workspaceId,
      entityType: payload.entityType,
      entityId: payload.entityId,
      content: built.content,
      triggeredByUserId: payload.triggeredByUserId,
    });

    // Named entities also feed the alias table, which entity resolution uses for
    // exact and fuzzy name lookups independently of vector search.
    await syncEntityAliasesForIndexedEntity(payload, built.label);

    // Duplicate detection is issue-specific and depends on the embedding that
    // was just written, so it runs after the store rather than alongside it.
    const duplicateSuggestionCreated =
      payload.entityType === "ISSUE" ? await runIssueDuplicateDetection(payload) : false;

    await finishJobRun(run.id, "SUCCEEDED", {
      entityType: payload.entityType,
      entityId: payload.entityId,
      ...(payload.entityType === "ISSUE" ? { duplicateSuggestionCreated } : {}),
    });
  } catch (error) {
    logAiWarn("ai_embedding_job_failed", {
      workspaceId: payload.workspaceId,
      feature: "background",
      success: false,
      errorCode: "EMBEDDING_JOB_FAILED",
      errorMessage: summarizeError(error),
      metadata: { entityType: payload.entityType, entityId: payload.entityId },
    });
    await finishJobRun(run.id, "FAILED", undefined, "EMBEDDING_JOB_FAILED", summarizeError(error));
    throw error;
  }
}

/** Entity kinds that participate in name-based resolution. */
const ALIASED_ENTITY_TYPES = new Set(["PROJECT", "TEAM", "DEPARTMENT", "MEMBER", "CYCLE"]);

async function syncEntityAliasesForIndexedEntity(payload: EmbeddingJob, label: string) {
  if (!ALIASED_ENTITY_TYPES.has(payload.entityType) || !label) return;

  await upsertEntityAliases({
    workspaceId: payload.workspaceId,
    entityType: payload.entityType as "PROJECT" | "TEAM" | "DEPARTMENT" | "MEMBER" | "CYCLE",
    entityId: payload.entityId,
    aliases: [label],
  }).catch(() => {
    // Alias upkeep is an optimization for resolution; the embedding itself is
    // already stored and must not be rolled back because this failed.
  });
}

async function runIssueDuplicateDetection(payload: EmbeddingJob): Promise<boolean> {
  const issue = await prisma.issue.findFirst({
    where: { id: payload.entityId, workspaceId: payload.workspaceId },
    select: { id: true, internalId: true, title: true, description: true, updatedAt: true },
  });
  if (!issue) return false;

  const suggestion = await suggestDuplicatesByEmbedding({
    workspaceId: payload.workspaceId,
    issueId: issue.id,
    title: issue.title,
    description: issue.description,
    updatedAt: issue.updatedAt,
    createdByUserId: payload.triggeredByUserId,
    triggeredByUserId: payload.triggeredByUserId,
  });

  if (!suggestion) return false;

  const recipients = await getIssueSuggestionRecipients(payload.workspaceId, issue.id);
  await notifySuggestionRecipientsIfRelevant({
    workspaceId: payload.workspaceId,
    suggestionId: suggestion.id,
    suggestionType: suggestion.type,
    title: suggestion.title,
    message: suggestion.message,
    targetType: "issue",
    targetId: issue.id,
    targetPublicId: issue.internalId ?? issue.id,
    targetUrl: `/issues/${issue.internalId ?? issue.id}`,
    recipientUserIds: recipients,
    metadata: { issueId: issue.id, suggestionType: suggestion.type, strategy: "embedding" },
  });

  return true;
}

const STALE_SCAN_PAGE_SIZE = 250;

/**
 * Cursor-paginates every workspace, or yields the single requested one.
 *
 * Previously a single `take: 500` — workspace 501 onward was silently never
 * scanned, with no error pointing at it. This has no upper bound.
 */
async function* paginateWorkspaces(workspaceId?: string): AsyncGenerator<{ id: string }> {
  if (workspaceId) {
    yield { id: workspaceId };
    return;
  }

  let cursor: string | null = null;
  for (;;) {
    const pageArgs: Parameters<typeof prisma.workspace.findMany>[0] = {
      select: { id: true },
      orderBy: { id: "asc" },
      take: STALE_SCAN_PAGE_SIZE,
    };
    if (cursor) {
      pageArgs.cursor = { id: cursor };
      pageArgs.skip = 1;
    }
    const page: Array<{ id: string }> = await prisma.workspace.findMany(pageArgs);
    if (page.length === 0) return;
    yield* page;
    if (page.length < STALE_SCAN_PAGE_SIZE) return;
    cursor = page[page.length - 1]!.id;
  }
}

/**
 * Cursor-paginates a workspace's in-progress/review issues, one page at a
 * time, rather than the previous single `take: 250` that silently dropped
 * everything past the 250th active issue.
 */
type StaleIssueCandidate = {
  id: string;
  internalId: string | null;
  title: string;
  assigneeId: string | null;
  updatedAt: Date;
  project: { leadId: string | null };
  team: { leadId: string | null };
};

async function* paginateStaleIssueCandidates(workspaceId: string): AsyncGenerator<StaleIssueCandidate[]> {
  let cursor: string | null = null;
  for (;;) {
    const pageArgs: Parameters<typeof prisma.issue.findMany>[0] = {
      where: {
        workspaceId,
        status: { in: ["in-progress", "review"] as any },
        completedAt: null,
      },
      select: {
        id: true,
        internalId: true,
        title: true,
        assigneeId: true,
        updatedAt: true,
        project: { select: { leadId: true } },
        team: { select: { leadId: true } },
      },
      orderBy: { id: "asc" },
      take: STALE_SCAN_PAGE_SIZE,
    };
    if (cursor) {
      pageArgs.cursor = { id: cursor };
      pageArgs.skip = 1;
    }
    const page = (await prisma.issue.findMany(pageArgs)) as unknown as StaleIssueCandidate[];
    if (page.length === 0) return;
    yield page;
    if (page.length < STALE_SCAN_PAGE_SIZE) return;
    cursor = page[page.length - 1]!.id;
  }
}

export async function processStaleScanJob(payload: StaleScanJob, jobMeta?: { jobId?: string }) {
  const run = await createJobRun({
    workspaceId: payload.workspaceId,
    jobName: "stale-scan",
    jobId: jobMeta?.jobId,
    targetType: "workspace",
    targetId: payload.workspaceId,
  });

  try {
    const staleCutoff = new Date(Date.now() - env.AI_STALE_ISSUE_DAYS * 24 * 60 * 60 * 1000);
    const staleCooldownWindow = getWindowKey(new Date(), STALE_SUGGESTION_COOLDOWN_DAYS);

    let suggestionsCreated = 0;
    let workspaceCount = 0;

    for await (const workspace of paginateWorkspaces(payload.workspaceId)) {
      workspaceCount += 1;
      await runOverdueIssueAutomation(workspace.id);

      for await (const issuePage of paginateStaleIssueCandidates(workspace.id)) {
        const issueIds = issuePage.map((issue) => issue.id);
        const [comments, activities] = await Promise.all([
          issueIds.length > 0
            ? prisma.comment.groupBy({
                by: ["issueId"],
                where: { issueId: { in: issueIds } },
                _max: { updatedAt: true },
              })
            : Promise.resolve([]),
          issueIds.length > 0
            ? prisma.activity.groupBy({
                by: ["targetId"],
                where: {
                  workspaceId: workspace.id,
                  targetType: "ISSUE" as any,
                  targetId: { in: issueIds },
                },
                _max: { createdAt: true },
              })
            : Promise.resolve([]),
        ]);

        const commentMap = new Map(comments.map((row) => [row.issueId, row._max.updatedAt ?? null]));
        const activityMap = new Map(activities.map((row) => [row.targetId, row._max.createdAt ?? null]));

        for (const issue of issuePage) {
          const lastTouch = [issue.updatedAt, commentMap.get(issue.id), activityMap.get(issue.id)]
            .filter((value): value is Date => value instanceof Date)
            .sort((a, b) => b.getTime() - a.getTime())[0] ?? issue.updatedAt;

          if (lastTouch > staleCutoff) {
            continue;
          }

          const suggestion = await upsertSuggestion({
            workspaceId: workspace.id,
            type: "STALE_ISSUE",
            source: "SQL",
            targetType: "issue",
            targetId: issue.id,
            title: "Stale issue detected",
            message: `This issue has not been updated for at least ${env.AI_STALE_ISSUE_DAYS} days.`,
            confidence: 0.75,
            reason: "Issue remained in an active workflow state without recent updates.",
            payload: {
              issueId: issue.id,
              staleDays: env.AI_STALE_ISSUE_DAYS,
              lastActivityAt: lastTouch,
            },
            dedupeKey: `stale:issue:${issue.id}:window:${staleCooldownWindow}`,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          });

          suggestionsCreated += 1;
          await notifySuggestionRecipientsIfRelevant({
            workspaceId: workspace.id,
            suggestionId: suggestion.id,
            suggestionType: suggestion.type,
            title: suggestion.title,
            message: suggestion.message,
            targetType: "issue",
            targetId: issue.id,
            targetPublicId: issue.internalId ?? issue.id,
            targetUrl: `/issues/${issue.internalId ?? issue.id}`,
            recipientUserIds: [...new Set([
              issue.assigneeId,
              issue.project.leadId,
              issue.team.leadId,
            ].filter(Boolean) as string[])],
            metadata: {
              issueId: issue.id,
              suggestionType: suggestion.type,
            },
          });
        }
      }
    }

    await finishJobRun(run.id, "SUCCEEDED", { suggestionsCreated, workspaceCount });
  } catch (error) {
    await finishJobRun(run.id, "FAILED", undefined, "STALE_SCAN_FAILED", summarizeError(error));
    throw error;
  }
}

export async function processWeeklyDigestJob(payload: WeeklyDigestJob, jobMeta?: { jobId?: string }) {
  const run = await createJobRun({
    workspaceId: payload.workspaceId,
    jobName: "weekly-digest",
    jobId: jobMeta?.jobId,
    targetType: "workspace",
    targetId: payload.workspaceId,
  });

  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    let workspaceCount = 0;

    for await (const workspace of paginateWorkspaces(payload.workspaceId)) {
      workspaceCount += 1;
      const digest = await buildWorkspaceDigestPayload(workspace.id);
      await markSuggestionsSuperseded(workspace.id, "workspace", workspace.id, ["WEEKLY_DIGEST"]);

      const suggestion = await upsertSuggestion({
        workspaceId: workspace.id,
        type: "WEEKLY_DIGEST",
        source: "SQL",
        targetType: "workspace",
        targetId: workspace.id,
        title: digest.title,
        message: digest.message,
        confidence: digest.confidence,
        reason: digest.reason,
        payload: digest.payload,
        dedupeKey: `weekly-digest:workspace:${workspace.id}:week:${since.toISOString().slice(0, 10)}`,
        expiresAt: digest.expiresAt,
      });

      await notifySuggestionRecipientsIfRelevant({
        workspaceId: workspace.id,
        suggestionId: suggestion.id,
        suggestionType: suggestion.type,
        title: suggestion.title,
        message: suggestion.message,
        targetType: "workspace",
        targetId: workspace.id,
        targetUrl: "/dashboard",
        recipientUserIds: digest.recipientUserIds,
        metadata: {
          suggestionType: suggestion.type,
        },
      });
    }

    await finishJobRun(run.id, "SUCCEEDED", { workspaceCount });
  } catch (error) {
    await finishJobRun(run.id, "FAILED", undefined, "WEEKLY_DIGEST_FAILED", summarizeError(error));
    throw error;
  }
}

export async function processSprintPlanningJob(payload: SprintPlanningJob, jobMeta?: { jobId?: string }) {
  const run = await createJobRun({
    workspaceId: payload.workspaceId,
    jobName: "sprint-planning",
    jobId: jobMeta?.jobId,
    targetType: "cycle",
    targetId: payload.cycleId,
  });

  try {
    const cycle = await prisma.cycle.findFirst({
      where: { id: payload.cycleId, workspaceId: payload.workspaceId },
      select: { id: true, name: true, teamId: true, updatedAt: true },
    });
    if (!cycle) {
      await finishJobRun(run.id, "SKIPPED", { reason: "Cycle not found" });
      return;
    }

    const issues = await prisma.issue.findMany({
      where: {
        workspaceId: payload.workspaceId,
        teamId: cycle.teamId,
        cycleId: null,
        status: { in: ["backlog", "todo", "review", "in-progress"] as any },
      },
      select: {
        id: true,
        title: true,
        priority: true,
        updatedAt: true,
        createdAt: true,
        dueDate: true,
        assigneeId: true,
        projectId: true,
        relationsFrom: { select: { type: true } },
        relationsTo: { select: { type: true } },
      },
      take: 40,
    });

    const workloadRows = await prisma.issue.groupBy({
      by: ["assigneeId"],
      where: {
        workspaceId: payload.workspaceId,
        teamId: cycle.teamId,
        completedAt: null,
      },
      _count: true,
    });
    const workloadMap = new Map(
      workloadRows
        .filter((row) => row.assigneeId)
        .map((row) => [row.assigneeId!, row._count]),
    );

    const now = Date.now();
    const ranked = issues.map((issue) => {
      const ageDays = Math.max(0, Math.floor((now - issue.createdAt.getTime()) / (24 * 60 * 60 * 1000)));
      const isOverdue = issue.dueDate ? issue.dueDate.getTime() < now : false;
      const hasBlockingDependency =
        issue.relationsFrom.some((relation) => relation.type === "BLOCKED_BY") ||
        issue.relationsTo.some((relation) => relation.type === "BLOCKS");
      const assigneeLoad = issue.assigneeId ? workloadMap.get(issue.assigneeId) ?? 0 : 0;

      let score = normalizePriorityScore(issue.priority) * 10;
      if (isOverdue) score += 12;
      if (!hasBlockingDependency) score += 6;
      score += Math.min(ageDays, 14);
      score -= Math.min(assigneeLoad, 10);

      const reasons = [
        `${String(issue.priority).toLowerCase()} priority`,
        ...(isOverdue ? ["overdue"] : []),
        ...(!hasBlockingDependency ? ["no blockers"] : ["has blockers"]),
        ...(ageDays > 0 ? [`${ageDays} day${ageDays === 1 ? "" : "s"} old`] : []),
        ...(issue.assigneeId ? [`assignee has ${assigneeLoad} active issue${assigneeLoad === 1 ? "" : "s"}`] : ["currently unassigned"]),
      ];

      return {
        issueId: issue.id,
        title: issue.title,
        priority: issue.priority,
        score,
        reasons,
      };
    });

    const candidates = ranked
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((issue, index) => ({
        issueId: issue.issueId,
        title: issue.title,
        priority: issue.priority,
        score: Number(issue.score.toFixed(2)),
        reasons: issue.reasons,
        rank: index + 1,
      }));

    if (candidates.length === 0) {
      await finishJobRun(run.id, "SKIPPED", { reason: "No cycle candidates found" });
      return;
    }

    const suggestion = await upsertSuggestion({
      workspaceId: payload.workspaceId,
      type: "SPRINT_PLANNING",
      source: "RULE",
      targetType: "cycle",
      targetId: cycle.id,
      title: "Sprint planning suggestions ready",
      message: `Prepared ${candidates.length} candidate issue${candidates.length === 1 ? "" : "s"} for ${cycle.name}.`,
      confidence: 0.65,
      reason: "Ranked unplanned team issues by urgency and recency.",
      payload: {
        cycleId: cycle.id,
        candidates,
      },
      dedupeKey: `sprint-planning:cycle:${cycle.id}:version:${dedupeVersion(cycle.updatedAt)}`,
      createdByUserId: payload.triggeredByUserId,
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });

    const recipients = await getSprintPlanningRecipientIds(payload.workspaceId, cycle.teamId);

    await notifySuggestionRecipientsIfRelevant({
      workspaceId: payload.workspaceId,
      suggestionId: suggestion.id,
      suggestionType: suggestion.type,
      title: suggestion.title,
      message: suggestion.message,
      targetType: "team",
      targetId: cycle.teamId,
      targetUrl: `/cycles/${cycle.id}`,
      recipientUserIds: recipients,
      metadata: {
        cycleId: cycle.id,
        suggestionType: suggestion.type,
      },
    });

    await finishJobRun(run.id, "SUCCEEDED", { candidateCount: candidates.length, cycleId: cycle.id });
  } catch (error) {
    await finishJobRun(run.id, "FAILED", undefined, "SPRINT_PLANNING_FAILED", summarizeError(error));
    throw error;
  }
}

export async function processProactiveSummaryJob(payload: ProactiveSummaryJob, jobMeta?: { jobId?: string }) {
  const run = await createJobRun({
    workspaceId: payload.workspaceId,
    jobName: "proactive-summary",
    jobId: jobMeta?.jobId,
    targetType: payload.scope,
    targetId: payload.scopeId,
  });

  try {
    let summary;
    try {
      summary = payload.scope === "project"
        ? await buildProjectHealthSummary(payload.workspaceId, payload.scopeId)
        : payload.scope === "team"
          ? await buildTeamHealthSummary(payload.workspaceId, payload.scopeId)
          : await buildCycleHealthSummary(payload.workspaceId, payload.scopeId);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 404) {
        await finishJobRun(run.id, "SKIPPED", {
          scope: payload.scope,
          scopeId: payload.scopeId,
          reason: error.message,
        });
        return;
      }
      throw error;
    }

    if (!summary || summary.recipientUserIds.length === 0) {
      await finishJobRun(run.id, "SKIPPED", {
        scope: payload.scope,
        scopeId: payload.scopeId,
        reason: "No proactive summary was warranted for the current scope state",
      });
      return;
    }

    await markSuggestionsSuperseded(payload.workspaceId, summary.targetType, summary.targetId, [summary.type]);

    const suggestion = await upsertSuggestion({
      workspaceId: payload.workspaceId,
      type: summary.type,
      source: "SQL",
      targetType: summary.targetType,
      targetId: summary.targetId,
      title: summary.title,
      message: summary.message,
      confidence: summary.confidence,
      reason: summary.reason,
      payload: summary.payload,
      dedupeKey: `${summary.targetType}-health:${summary.targetId}:${summary.dedupeSuffix}`,
      createdByUserId: payload.triggeredByUserId,
      expiresAt: summary.expiresAt,
    });

    await notifySuggestionRecipientsIfRelevant({
      workspaceId: payload.workspaceId,
      suggestionId: suggestion.id,
      suggestionType: suggestion.type,
      title: suggestion.title,
      message: suggestion.message,
      targetType: summary.notificationTargetType ?? "workspace",
      targetId: summary.notificationTargetId ?? summary.targetId,
      targetUrl: summary.notificationUrl ?? `/${summary.targetType}s/${summary.targetId}`,
      recipientUserIds: summary.recipientUserIds,
      metadata: {
        suggestionType: suggestion.type,
        scope: payload.scope,
        scopeId: payload.scopeId,
      },
    });

    await finishJobRun(run.id, "SUCCEEDED", {
      scope: payload.scope,
      scopeId: payload.scopeId,
      suggestionId: suggestion.id,
      suggestionType: suggestion.type,
    });
  } catch (error) {
    await finishJobRun(run.id, "FAILED", undefined, "PROACTIVE_SUMMARY_FAILED", summarizeError(error));
    throw error;
  }
}

function runDetached(label: string, task: () => Promise<void>) {
  setImmediate(() => {
    task().catch((error) => {
      logAiWarn("ai_background_inline_fallback_failed", {
        feature: "background",
        success: false,
        errorCode: `${label.toUpperCase()}_INLINE_FAILED`,
        errorMessage: summarizeError(error),
      });
    });
  });
}

export async function triggerIssueBackgroundJobs(
  input: { workspaceId: string; issueId: string; triggeredByUserId?: string | undefined; reason: IssueIntelligenceReason },
  options?: { includeIssueIntelligence?: boolean; includeEmbedding?: boolean; includeScopeSummaries?: boolean },
) {
  await triggerBackgroundSafely("issue-background", async () => {
    const includeIssueIntelligence = options?.includeIssueIntelligence ?? true;
    const includeEmbedding = options?.includeEmbedding ?? true;
    const includeScopeSummaries = options?.includeScopeSummaries ?? true;

    const [issueJob, embeddingJob] = await Promise.all([
      includeIssueIntelligence ? enqueueIssueIntelligence(input) : Promise.resolve(null),
      includeEmbedding
        ? enqueueEmbedding({
            workspaceId: input.workspaceId,
            entityType: "ISSUE",
            entityId: input.issueId,
            triggeredByUserId: input.triggeredByUserId,
            reason: input.reason,
          })
        : Promise.resolve(null),
    ]);

    if (includeIssueIntelligence && !issueJob) {
      runDetached("issue-intelligence", () => processIssueIntelligenceJob(input));
    }
    if (includeEmbedding && !embeddingJob) {
      runDetached("embedding", () => processEmbeddingJob({
        workspaceId: input.workspaceId,
        entityType: "ISSUE",
        entityId: input.issueId,
        triggeredByUserId: input.triggeredByUserId,
        reason: input.reason,
      }));
    }

    if (includeScopeSummaries) {
      const issue = await prisma.issue.findFirst({
        where: { id: input.issueId, workspaceId: input.workspaceId },
        select: { projectId: true, teamId: true },
      });

      if (issue?.projectId) {
        await triggerProactiveSummary({
          workspaceId: input.workspaceId,
          scope: "project",
          scopeId: issue.projectId,
          triggeredByUserId: input.triggeredByUserId,
          reason: input.reason,
        });
      }

      if (issue?.teamId) {
        await triggerProactiveSummary({
          workspaceId: input.workspaceId,
          scope: "team",
          scopeId: issue.teamId,
          triggeredByUserId: input.triggeredByUserId,
          reason: input.reason,
        });
      }
    }
  });
}

export async function triggerCycleBackgroundJobs(
  input: { workspaceId: string; cycleId: string; triggeredByUserId?: string | undefined; reason: SprintPlanningJob["reason"] },
  options?: { includeSprintPlanning?: boolean; includeHealthSummary?: boolean },
) {
  await triggerBackgroundSafely("cycle-background", async () => {
    const includeSprintPlanning = options?.includeSprintPlanning ?? true;
    const includeHealthSummary = options?.includeHealthSummary ?? true;

    const job = includeSprintPlanning ? await enqueueSprintPlanning(input) : null;
    if (includeSprintPlanning && !job) {
      runDetached("sprint-planning", () => processSprintPlanningJob(input));
    }

    if (includeHealthSummary) {
      await triggerProactiveSummary({
        workspaceId: input.workspaceId,
        scope: "cycle",
        scopeId: input.cycleId,
        triggeredByUserId: input.triggeredByUserId,
        reason: input.reason,
      });
    }
  });
}

export async function triggerStaleScan(input: StaleScanJob) {
  await triggerBackgroundSafely("stale-scan", async () => {
    const job = await enqueueStaleScan(input);
    if (!job) {
      runDetached("stale-scan", () => processStaleScanJob(input));
    }
  });
}

export async function triggerWeeklyDigest(input: WeeklyDigestJob) {
  await triggerBackgroundSafely("weekly-digest", async () => {
    const job = await enqueueWeeklyDigest(input);
    if (!job) {
      runDetached("weekly-digest", () => processWeeklyDigestJob(input));
    }
  });
}

export async function triggerProactiveSummary(input: ProactiveSummaryJob) {
  await triggerBackgroundSafely("proactive-summary", async () => {
    const job = await enqueueProactiveSummary(input);
    if (!job) {
      runDetached("proactive-summary", () => processProactiveSummaryJob(input));
    }
  });
}
