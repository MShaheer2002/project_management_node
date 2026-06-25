import { Queue, type JobsOptions } from "bullmq";

import { env } from "../../config/env.js";
import { getSharedQueueConnection } from "./redis.js";

const queues = new Map<string, Queue>();

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 604_800, count: 5_000 },
};

export function getQueue(name: string): Queue | null {
  const existing = queues.get(name);
  if (existing) return existing;

  const connection = getSharedQueueConnection();
  if (!connection) return null;

  const queue = new Queue(name, {
    connection: connection as any,
    prefix: env.REDIS_QUEUE_PREFIX ?? "trussen",
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  queues.set(name, queue);
  return queue;
}

export async function closeAllQueues() {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
}
