import { Worker, type Job } from "bullmq";

import { env } from "../../config/env.js";
import { closeAllQueues } from "../../infra/queue/queues.js";
import { closeSharedQueueConnection, createWorkerQueueConnection } from "../../infra/queue/redis.js";
import {
  processProactiveSummaryJob,
  processEmbeddingJob,
  processIssueIntelligenceJob,
  processSprintPlanningJob,
  processStaleScanJob,
  processWeeklyDigestJob,
} from "./ai.background.js";
import {
  AI_QUEUE_NAMES,
  type EmbeddingJob,
  type IssueIntelligenceJob,
  type ProactiveSummaryJob,
  type SprintPlanningJob,
  type StaleScanJob,
  type WeeklyDigestJob,
} from "./ai.jobs.js";

type ManagedWorker = {
  label: string;
  worker: Worker;
  connection: ReturnType<typeof createWorkerQueueConnection>;
};

function createAiWorker<T>(queueName: string, label: string, handler: (payload: T, job: Job<T>) => Promise<void>) {
  const connection = createWorkerQueueConnection();
  if (!connection) {
    throw new Error("REDIS_URL is required to start AI background workers");
  }

  const worker = new Worker<T>(
    queueName,
    async (job) => {
      await handler(job.data, job);
    },
    {
      connection: connection as any,
      prefix: env.REDIS_QUEUE_PREFIX ?? "trussen",
      concurrency: 2,
    },
  );

  worker.on("completed", (job) => {
    console.log(`[AI Worker] ${label} completed job ${job.id ?? "unknown"}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`[AI Worker] ${label} failed job ${job?.id ?? "unknown"}:`, error);
  });

  worker.on("error", (error) => {
    console.error(`[AI Worker] ${label} runtime error:`, error);
  });

  return { label, worker, connection };
}

export async function startAiBackgroundWorkers() {
  if (!env.AI_BACKGROUND_WORKERS_ENABLED) {
    console.log("[AI Worker] Background workers disabled by configuration.");
    return;
  }

  const workers: ManagedWorker[] = [
    createAiWorker<IssueIntelligenceJob>(
      AI_QUEUE_NAMES.issueIntelligence,
      "issue-intelligence",
      async (payload, job) => processIssueIntelligenceJob(payload, { jobId: String(job.id ?? "") }),
    ),
    createAiWorker<EmbeddingJob>(
      AI_QUEUE_NAMES.embeddings,
      "embeddings",
      async (payload, job) => processEmbeddingJob(payload, { jobId: String(job.id ?? "") }),
    ),
    createAiWorker<StaleScanJob>(
      AI_QUEUE_NAMES.staleScan,
      "stale-scan",
      async (payload, job) => processStaleScanJob(payload, { jobId: String(job.id ?? "") }),
    ),
    createAiWorker<WeeklyDigestJob>(
      AI_QUEUE_NAMES.weeklyDigest,
      "weekly-digest",
      async (payload, job) => processWeeklyDigestJob(payload, { jobId: String(job.id ?? "") }),
    ),
    createAiWorker<SprintPlanningJob>(
      AI_QUEUE_NAMES.sprintPlanning,
      "sprint-planning",
      async (payload, job) => processSprintPlanningJob(payload, { jobId: String(job.id ?? "") }),
    ),
    createAiWorker<ProactiveSummaryJob>(
      AI_QUEUE_NAMES.proactiveSummary,
      "proactive-summary",
      async (payload, job) => processProactiveSummaryJob(payload, { jobId: String(job.id ?? "") }),
    ),
  ];

  console.log(`[AI Worker] Started ${workers.length} background workers.`);

  const shutdown = async (signal: string) => {
    console.log(`[AI Worker] Received ${signal}. Shutting down workers...`);
    await Promise.all(workers.map(async ({ worker, connection }) => {
      await worker.close().catch(() => {});
      await connection?.quit().catch(async () => {
        await connection?.disconnect();
      });
    }));
    await closeAllQueues().catch(() => {});
    await closeSharedQueueConnection().catch(() => {});
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
