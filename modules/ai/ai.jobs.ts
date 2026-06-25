import { getQueue } from "../../infra/queue/queues.js";
import { logAiWarn } from "./ai.observability.js";

export const AI_QUEUE_NAMES = {
  issueIntelligence: "ai.issue-intelligence",
  embeddings: "ai.embeddings",
  staleScan: "ai.stale-scan",
  weeklyDigest: "ai.weekly-digest",
  sprintPlanning: "ai.sprint-planning",
} as const;

export type IssueIntelligenceJob = {
  workspaceId: string;
  issueId: string;
  triggeredByUserId?: string | undefined;
  reason: "created" | "updated" | "manual";
};

export type EmbeddingJob = {
  workspaceId: string;
  entityType: "ISSUE";
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

async function enqueue<T>(queueName: string, name: string, payload: T) {
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
    return await queue.add(name, payload);
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
