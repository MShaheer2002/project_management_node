import { env } from "../../config/env.js";
import { getQueue } from "../../infra/queue/queues.js";
import { logAiWarn } from "./ai.observability.js";

export const AI_QUEUE_NAMES = {
  issueIntelligence: "ai.issue-intelligence",
  embeddings: "ai.embeddings",
  staleScan: "ai.stale-scan",
  weeklyDigest: "ai.weekly-digest",
  sprintPlanning: "ai.sprint-planning",
  proactiveSummary: "ai.proactive-summary",
} as const;

export type IssueIntelligenceJob = {
  workspaceId: string;
  issueId: string;
  triggeredByUserId?: string | undefined;
  reason: "created" | "updated" | "manual";
};

export type EmbeddingJob = {
  workspaceId: string;
  // Mirrors AiEmbeddingEntityType. COMMENT and DOCUMENT were declared in the
  // schema but missing here and in the worker, so they could never be indexed
  // even though the enum implied otherwise.
  entityType: "ISSUE" | "COMMENT" | "DOCUMENT" | "PROJECT" | "TEAM" | "DEPARTMENT" | "MEMBER" | "CYCLE";
  entityId: string;
  triggeredByUserId?: string | undefined;
  reason: "created" | "updated" | "manual";
};

export type StaleScanJob = {
  workspaceId?: string | undefined;
  triggeredByUserId?: string | undefined;
  reason: "scheduled" | "manual";
};

export type WeeklyDigestJob = {
  workspaceId?: string | undefined;
  triggeredByUserId?: string | undefined;
  reason: "scheduled" | "manual";
};

export type SprintPlanningJob = {
  workspaceId: string;
  cycleId: string;
  triggeredByUserId?: string | undefined;
  reason: "created" | "manual";
};

export type ProactiveSummaryJob = {
  workspaceId: string;
  scope: "project" | "team" | "cycle";
  scopeId: string;
  triggeredByUserId?: string | undefined;
  reason: "created" | "updated" | "manual";
};

async function enqueue<T>(
  queueName: string,
  name: string,
  payload: T,
  options?: { jobId?: string; delay?: number },
) {
  const queue = getQueue(queueName);
  if (!queue) {
    logAiWarn("ai_queue_unavailable", {
      feature: "background",
      success: false,
      metadata: { queueName, jobName: name },
    });
    return null;
  }

  try {
    return await queue.add(name, payload, options);
  } catch (error) {
    logAiWarn("ai_queue_enqueue_failed", {
      feature: "background",
      success: false,
      errorCode: "QUEUE_ENQUEUE_FAILED",
      errorMessage: error instanceof Error ? error.message : "Queue enqueue failed",
      metadata: { queueName, jobName: name },
    });
    return null;
  }
}

export async function enqueueIssueIntelligence(payload: IssueIntelligenceJob) {
  return enqueue(AI_QUEUE_NAMES.issueIntelligence, "issue-intelligence", payload);
}

export async function enqueueEmbedding(payload: EmbeddingJob) {
  return enqueue(AI_QUEUE_NAMES.embeddings, "embedding", payload);
}

export async function enqueueStaleScan(payload: StaleScanJob) {
  return enqueue(AI_QUEUE_NAMES.staleScan, "stale-scan", payload);
}

export async function enqueueWeeklyDigest(payload: WeeklyDigestJob) {
  return enqueue(AI_QUEUE_NAMES.weeklyDigest, "weekly-digest", payload);
}

export async function enqueueSprintPlanning(payload: SprintPlanningJob) {
  return enqueue(AI_QUEUE_NAMES.sprintPlanning, "sprint-planning", payload);
}

/**
 * Debounced: a rapid burst of writes to the same target (e.g. many issue
 * updates in one project within a minute) previously enqueued a full
 * health-summary rebuild job per write. A deterministic jobId plus a short
 * delay collapses that into one job — BullMQ silently keeps the first add's
 * data and drops later adds with the same jobId while it's still delayed
 * (verified directly against this BullMQ version, not assumed from docs),
 * which is safe here because the job recomputes live state at run time; it
 * never depends on which specific trigger's payload "won".
 */
export async function enqueueProactiveSummary(payload: ProactiveSummaryJob) {
  return enqueue(AI_QUEUE_NAMES.proactiveSummary, "proactive-summary", payload, {
    jobId: `proactive-summary:${payload.scope}:${payload.scopeId}`,
    delay: env.AI_PROACTIVE_SUMMARY_DEBOUNCE_MS,
  });
}
