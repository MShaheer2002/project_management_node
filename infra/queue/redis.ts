import RedisModule from "ioredis";

import { env } from "../../config/env.js";

type RedisConnection = {
  quit: () => Promise<unknown>;
  disconnect: () => void;
};

const RedisCtor = RedisModule as unknown as new (
  url: string,
  options: { maxRetriesPerRequest: null; enableReadyCheck: boolean },
) => RedisConnection;

let sharedConnection: RedisConnection | null = null;
let sharedWorkerConnection: RedisConnection | null = null;
let warnedMissingRedis = false;

export function isQueueInfrastructureEnabled() {
  return Boolean(env.REDIS_URL);
}

export function getSharedQueueConnection(): RedisConnection | null {
  if (!env.REDIS_URL) {
    if (!warnedMissingRedis) {
      warnedMissingRedis = true;
      console.warn("[AI Queue] REDIS_URL is not configured. Background queue infrastructure is disabled.");
    }
    return null;
  }

  if (!sharedConnection) {
    sharedConnection = new RedisCtor(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  }

  return sharedConnection;
}

/**
 * One Redis connection per worker *process*, shared by every BullMQ Worker
 * in it. Previously each of the 6 queues opened its own connection via a
 * non-singleton version of this function — 6 connections per process, which
 * multiplies with every horizontally-scaled replica for no benefit; BullMQ's
 * own docs recommend sharing one connection across Workers in a process.
 */
export function createWorkerQueueConnection() {
  if (!env.REDIS_URL) {
    return null;
  }

  if (!sharedWorkerConnection) {
    sharedWorkerConnection = new RedisCtor(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  }

  return sharedWorkerConnection;
}

export async function closeSharedQueueConnection() {
  if (!sharedConnection) return;

  await sharedConnection.quit().catch(async () => {
    sharedConnection?.disconnect();
  });
  sharedConnection = null;
}

export async function closeSharedWorkerConnection() {
  if (!sharedWorkerConnection) return;

  await sharedWorkerConnection.quit().catch(async () => {
    sharedWorkerConnection?.disconnect();
  });
  sharedWorkerConnection = null;
}
