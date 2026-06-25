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

export function createWorkerQueueConnection() {
  if (!env.REDIS_URL) {
    return null;
  }

  return new RedisCtor(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export async function closeSharedQueueConnection() {
  if (!sharedConnection) return;

  await sharedConnection.quit().catch(async () => {
    sharedConnection?.disconnect();
  });
  sharedConnection = null;
}
