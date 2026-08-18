import http from "node:http";

import { Worker, type Job } from "bullmq";

import { env } from "../../config/env.js";
import { startBullBoard } from "../../infra/queue/dashboard.js";
import { closeAllQueues, getQueue } from "../../infra/queue/queues.js";
import {
  closeSharedQueueConnection,
  closeSharedWorkerConnection,
  createWorkerQueueConnection,
} from "../../infra/queue/redis.js";
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
};

type CreateAiWorkerOptions = {
  concurrency: number;
  /** Only embeddings needs this — a rate-limited external API call per job. */
  limiter?: { max: number; duration: number };
};

function createAiWorker<T>(
  queueName: string,
  label: string,
  handler: (payload: T, job: Job<T>) => Promise<void>,
  options: CreateAiWorkerOptions,
) {
  // One Redis connection shared by every worker in this process (see
  // infra/queue/redis.ts) — previously each of the 6 queues opened its own,
  // so connection count scaled 6x with every horizontally-scaled replica.
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
      concurrency: options.concurrency,
      ...(options.limiter ? { limiter: options.limiter } : {}),
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

  return { label, worker };
}

/**
 * Registers the daily/weekly cron-style triggers as BullMQ job schedulers
 * instead of node-cron.
 *
 * This replaces a real gap: node-cron ran inside a standalone scheduler
 * process, and nothing stopped someone from accidentally running more than
 * one replica of it — each would independently fire the same daily/weekly
 * job, N times over. `upsertJobScheduler` is idempotent by design (it's an
 * upsert): calling it from every worker replica at startup is safe and
 * produces exactly one schedule, no distributed lock required.
 */
async function registerScheduledJobs() {
  if (!env.AI_BACKGROUND_SCHEDULER_ENABLED) {
    console.log("[AI Worker] Scheduled jobs (stale-scan, weekly-digest) disabled by configuration.");
    return;
  }

  const staleScanQueue = getQueue(AI_QUEUE_NAMES.staleScan);
  const weeklyDigestQueue = getQueue(AI_QUEUE_NAMES.weeklyDigest);
  if (!staleScanQueue || !weeklyDigestQueue) {
    console.warn("[AI Worker] Could not register scheduled jobs — queue infrastructure unavailable.");
    return;
  }

  await staleScanQueue.upsertJobScheduler(
    "stale-scan-daily",
    { pattern: "0 8 * * *", tz: "UTC" },
    { name: "scheduled-stale-scan", data: { reason: "scheduled" } satisfies StaleScanJob },
  );

  await weeklyDigestQueue.upsertJobScheduler(
    "weekly-digest-weekly",
    { pattern: "0 9 * * 1", tz: "UTC" },
    { name: "scheduled-weekly-digest", data: { reason: "scheduled" } satisfies WeeklyDigestJob },
  );

  console.log("[AI Worker] Registered scheduled jobs: stale scan (daily 08:00 UTC), weekly digest (Monday 09:00 UTC).");
}

/**
 * Minimal liveness endpoint so an orchestrator can tell "crashed" apart from
 * "hung" — there was previously no external signal at all for this process.
 * Deliberately not Express: one route, no reason to pull in a framework for it.
 */
function startHealthServer(workers: ManagedWorker[]) {
  if (env.AI_WORKER_HEALTH_PORT === 0) return null;

  const server = http.createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }

    const runningCount = workers.filter((managed) => !managed.worker.closing).length;
    const healthy = runningCount === workers.length;

    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ healthy, workers: runningCount, expected: workers.length }));
  });

  server.listen(env.AI_WORKER_HEALTH_PORT, () => {
    console.log(`[AI Worker] Health endpoint listening on :${env.AI_WORKER_HEALTH_PORT}/health`);
  });

  server.on("error", (error) => {
    console.error("[AI Worker] Health server error:", error);
  });

  return server;
}

export async function startAiBackgroundWorkers() {
  if (!env.AI_BACKGROUND_WORKERS_ENABLED) {
    console.log("[AI Worker] Background workers disabled by configuration.");
    return;
  }

  const concurrency = env.AI_WORKER_CONCURRENCY;

  const workers: ManagedWorker[] = [
    createAiWorker<IssueIntelligenceJob>(
      AI_QUEUE_NAMES.issueIntelligence,
      "issue-intelligence",
      async (payload, job) => processIssueIntelligenceJob(payload, { jobId: String(job.id ?? "") }),
      { concurrency },
    ),
    createAiWorker<EmbeddingJob>(
      AI_QUEUE_NAMES.embeddings,
      "embeddings",
      async (payload, job) => processEmbeddingJob(payload, { jobId: String(job.id ?? "") }),
      {
        concurrency: env.AI_EMBEDDINGS_WORKER_CONCURRENCY,
        // Concurrency alone bounds parallel jobs, not rate — a burst (bulk
        // import, several replicas draining a backlog at once) had nothing
        // stopping it from exceeding the embedding provider's real rate
        // limit and causing a synchronized retry storm.
        limiter: {
          max: env.AI_EMBEDDINGS_RATE_LIMIT_MAX,
          duration: env.AI_EMBEDDINGS_RATE_LIMIT_DURATION_MS,
        },
      },
    ),
    createAiWorker<StaleScanJob>(
      AI_QUEUE_NAMES.staleScan,
      "stale-scan",
      async (payload, job) => processStaleScanJob(payload, { jobId: String(job.id ?? "") }),
      { concurrency },
    ),
    createAiWorker<WeeklyDigestJob>(
      AI_QUEUE_NAMES.weeklyDigest,
      "weekly-digest",
      async (payload, job) => processWeeklyDigestJob(payload, { jobId: String(job.id ?? "") }),
      { concurrency },
    ),
    createAiWorker<SprintPlanningJob>(
      AI_QUEUE_NAMES.sprintPlanning,
      "sprint-planning",
      async (payload, job) => processSprintPlanningJob(payload, { jobId: String(job.id ?? "") }),
      { concurrency },
    ),
    createAiWorker<ProactiveSummaryJob>(
      AI_QUEUE_NAMES.proactiveSummary,
      "proactive-summary",
      async (payload, job) => processProactiveSummaryJob(payload, { jobId: String(job.id ?? "") }),
      { concurrency },
    ),
  ];

  console.log(`[AI Worker] Started ${workers.length} background workers.`);

  await registerScheduledJobs();
  const healthServer = startHealthServer(workers);
  const bullBoardServer = startBullBoard();

  const shutdown = async (signal: string) => {
    console.log(`[AI Worker] Received ${signal}. Shutting down workers...`);
    await Promise.all(workers.map(({ worker }) => worker.close().catch(() => {})));
    await new Promise<void>((resolve) => (healthServer ? healthServer.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (bullBoardServer ? bullBoardServer.close(() => resolve()) : resolve()));
    await closeAllQueues().catch(() => {});
    await closeSharedQueueConnection().catch(() => {});
    // All 6 workers share this one connection now — close it once, after
    // every worker has finished closing, not once per worker.
    await closeSharedWorkerConnection().catch(() => {});
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
