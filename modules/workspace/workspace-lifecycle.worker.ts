/**
 * Runs the workspace soft-delete lifecycle inside the API server process.
 *
 * Deliberately not in the AI worker: that process is optional and its
 * scheduler is off by default (AI_BACKGROUND_SCHEDULER_ENABLED), and turning
 * off AI jobs must never stop workspaces from being deleted. upsertJobScheduler
 * is idempotent and each job is taken by one worker, so every API replica can
 * start this and the hourly run still happens exactly once.
 */
import { Worker } from "bullmq";

import { env } from "../../config/env.js";
import { getQueue } from "../../infra/queue/queues.js";
import { createWorkerQueueConnection } from "../../infra/queue/redis.js";
import { runWorkspaceLifecycle, sendMemberNotices, setMemberNoticeQueue } from "./workspace-lifecycle.service.js";

const QUEUE_NAME = "workspace-lifecycle";

type LifecycleJob = { workspaceId?: string };

let runningWorker: Worker<LifecycleJob> | null = null;

/**
 * Not awaited by the server: BullMQ waits for Redis indefinitely, and a Redis
 * outage must not stop the API from starting. Failures are logged loudly.
 */
export function startWorkspaceLifecycleWorker() {
  void startWorker().catch((error) => {
    console.error("❌ [Workspace lifecycle] failed to start — reminders and purges are NOT running:", error);
  });
}

/** Lets a running purge finish (it is mid-way through external deletions) before shutdown. */
export async function stopWorkspaceLifecycleWorker() {
  await runningWorker?.close();
  runningWorker = null;
}

async function startWorker() {
  const queue = getQueue(QUEUE_NAME);
  const connection = createWorkerQueueConnection();
  if (!queue || !connection) {
    console.error(
      "❌ [Workspace lifecycle] REDIS_URL is not set. Deactivated workspaces will get NO reminder emails " +
        "and will NOT be deleted after 30 days until it is configured.",
    );
    return;
  }

  await queue.upsertJobScheduler(
    "workspace-lifecycle-hourly",
    { pattern: "0 * * * *", tz: "UTC" },
    { name: "run", data: {} satisfies LifecycleJob },
  );

  // A retry would email every member twice, so notices get one attempt.
  setMemberNoticeQueue(async (workspaceId) => {
    await queue.add("member-notices", { workspaceId } satisfies LifecycleJob, { attempts: 1 });
  });

  const worker = new Worker<LifecycleJob>(
    QUEUE_NAME,
    async (job) => {
      if (job.name === "member-notices") {
        if (job.data.workspaceId) await sendMemberNotices(job.data.workspaceId);
        return;
      }
      const result = await runWorkspaceLifecycle();
      if (result.reminders > 0 || result.purged > 0) {
        console.log(`[Workspace lifecycle] sent ${result.reminders} reminder(s), purged ${result.purged} workspace(s)`);
      }
    },
    {
      connection: connection as any,
      prefix: env.REDIS_QUEUE_PREFIX ?? "trussen",
      concurrency: 1,
      // Same idle-polling budget as the AI workers (see ai.worker.ts).
      drainDelay: 600,
    },
  );

  worker.on("failed", (job, error) => {
    console.error(`[Workspace lifecycle] job ${job?.name ?? "unknown"} failed:`, error);
  });
  worker.on("error", (error) => {
    console.error("[Workspace lifecycle] worker error:", error);
  });

  runningWorker = worker;
  console.log("✅ Workspace lifecycle job scheduled (hourly)");
}
