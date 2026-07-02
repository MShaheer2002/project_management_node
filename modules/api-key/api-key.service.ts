/**
 * API Key Module — Service Layer
 *
 * Business logic for API key lifecycle:
 *   - Generate keys with lin_live_ / lin_test_ prefix
 *   - Store SHA-256 hash only (raw key returned once on creation)
 *   - List keys with masked prefixes
 *   - Revoke (delete) keys immediately
 *   - Enforce plan-based key limits
 *   - Authenticate incoming requests via API key
 *
 * Security model:
 *   - Raw key is NEVER stored — only SHA-256 hash
 *   - Lookup by exact hash match (unique index, O(1))
 *   - Creator's workspace membership verified on every API key auth request
 *   - lastUsedAt updated with 5-minute debounce to avoid write contention
 */

import { randomBytes } from "node:crypto";
import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { hashToken } from "../../shared/utils/crypto.js";
import { logActivity } from "../../shared/utils/activity.js";
import { env } from "../../config/env.js";
import type { CreateApiKeyInput } from "./api-key.schemas.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const KEY_PREFIX_LIVE = "lin_live_";
const KEY_PREFIX_TEST = "lin_test_";
const PAYLOAD_BYTES = 24; // 192 bits of entropy
const DISPLAY_PREFIX_LENGTH = 16; // Stored in keyPrefix for list UI

const PLAN_KEY_LIMITS: Record<string, number> = {
  FREE: 2,
  STANDARD: 10,
  PREMIUM: 50,
};

// Debounce lastUsedAt writes — 5 minutes per key
const LAST_USED_DEBOUNCE_MS = 5 * 60 * 1000;
const lastUsedAtCache = new Map<string, number>();

// ─── Key Generation ──────────────────────────────────────────────────────────

function generateApiKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const prefix = env.NODE_ENV === "production" ? KEY_PREFIX_LIVE : KEY_PREFIX_TEST;
  const payload = randomBytes(PAYLOAD_BYTES).toString("hex");
  const rawKey = `${prefix}${payload}`;

  return {
    rawKey,
    keyHash: hashToken(rawKey),
    keyPrefix: rawKey.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

// ─── Plan Enforcement ────────────────────────────────────────────────────────

async function enforceApiKeyLimit(workspaceId: string) {
  const subscription = await prisma.subscription.findUnique({
    where: { workspaceId },
    select: { plan: true, status: true },
  });

  const plan = subscription?.plan ?? "FREE";
  const maxKeys = PLAN_KEY_LIMITS[plan] ?? PLAN_KEY_LIMITS.FREE!;

  const currentCount = await prisma.apiKey.count({ where: { workspaceId } });

  if (currentCount >= maxKeys) {
    throw new AppError(
      409,
      ERROR_CODES.API_KEY_LIMIT_REACHED,
      `Your ${plan.toLowerCase()} plan allows a maximum of ${maxKeys} API key${maxKeys === 1 ? "" : "s"}. Delete unused keys or upgrade your plan.`,
    );
  }
}

// ─── CRUD Operations ─────────────────────────────────────────────────────────

/**
 * Create a new API key.
 * Returns the raw key ONCE — it is never stored or retrievable again.
 */
export async function createApiKey(
  workspaceId: string,
  userId: string,
  input: CreateApiKeyInput,
  options?: { skipLimitCheck?: boolean },
) {
  if (!options?.skipLimitCheck) {
    await enforceApiKeyLimit(workspaceId);
  }

  const { rawKey, keyHash, keyPrefix } = generateApiKey();

  const apiKey = await prisma.apiKey.create({
    data: {
      workspaceId,
      name: input.name,
      keyHash,
      keyPrefix,
      createdById: userId,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      createdAt: true,
      expiresAt: true,
      createdBy: {
        select: { id: true, name: true, email: true },
      },
    },
  });

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "API_KEY_CREATED",
    targetType: "WORKSPACE",
    targetId: apiKey.id,
    message: `API key "${input.name}" created`,
    metadata: { apiKeyId: apiKey.id, apiKeyName: input.name, keyPrefix },
  });

  return {
    id: apiKey.id,
    name: apiKey.name,
    key: rawKey, // Returned ONCE — never stored
    keyPrefix: apiKey.keyPrefix,
    createdAt: apiKey.createdAt,
    expiresAt: apiKey.expiresAt,
    createdBy: apiKey.createdBy,
  };
}

/**
 * List all API keys in a workspace.
 * Returns masked prefixes only — NEVER the full key.
 */
export async function listApiKeys(workspaceId: string) {
  const keys = await prisma.apiKey.findMany({
    where: { workspaceId },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      createdBy: {
        select: { id: true, name: true, email: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const now = new Date();
  return keys.map((key) => ({
    ...key,
    isExpired: key.expiresAt ? key.expiresAt < now : false,
  }));
}

/**
 * Get a single API key by ID.
 * Returns masked prefix only — NEVER the full key.
 */
export async function getApiKeyById(workspaceId: string, keyId: string) {
  const key = await prisma.apiKey.findFirst({
    where: { id: keyId, workspaceId },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      createdBy: {
        select: { id: true, name: true, email: true },
      },
    },
  });

  if (!key) {
    throw new AppError(404, ERROR_CODES.API_KEY_NOT_FOUND, "API key not found");
  }

  return {
    ...key,
    isExpired: key.expiresAt ? key.expiresAt < new Date() : false,
  };
}

/**
 * Revoke (delete) an API key.
 * Effect is immediate — the next request using this key will get 401.
 */
export async function revokeApiKey(workspaceId: string, keyId: string, actorId: string) {
  const key = await prisma.apiKey.findFirst({
    where: { id: keyId, workspaceId },
    select: { id: true, name: true, keyPrefix: true },
  });

  if (!key) {
    throw new AppError(404, ERROR_CODES.API_KEY_NOT_FOUND, "API key not found");
  }

  await prisma.apiKey.delete({ where: { id: keyId } });

  // Clear debounce cache entry
  lastUsedAtCache.delete(keyId);

  await logActivity({
    workspaceId,
    actorId,
    type: "API_KEY_REVOKED",
    targetType: "WORKSPACE",
    targetId: key.id,
    message: `API key "${key.name}" revoked`,
    metadata: { apiKeyId: key.id, apiKeyName: key.name, keyPrefix: key.keyPrefix },
  });
}

// ─── API Key Authentication ──────────────────────────────────────────────────

/**
 * Authenticate a request using an API key.
 * Called by the dual-auth middleware when the token looks like an API key.
 *
 * Verifies:
 *   1. Key exists (SHA-256 hash lookup)
 *   2. Key is not expired
 *   3. Creator is still a workspace member (prevents orphaned key access)
 *
 * Returns the resolved user, workspace context, and key metadata.
 */
export async function authenticateWithApiKey(rawKey: string) {
  const keyHash = hashToken(rawKey);

  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
    select: {
      id: true,
      name: true,
      workspaceId: true,
      createdById: true,
      expiresAt: true,
    },
  });

  if (!apiKey) {
    throw new AppError(401, ERROR_CODES.INVALID_API_KEY, "Invalid API key");
  }

  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    throw new AppError(401, ERROR_CODES.API_KEY_EXPIRED, "This API key has expired");
  }

  // Verify creator still has workspace membership
  const membership = await prisma.workspaceMembership.findUnique({
    where: {
      userId_workspaceId: {
        userId: apiKey.createdById,
        workspaceId: apiKey.workspaceId,
      },
    },
    select: { role: true },
  });

  if (!membership) {
    throw new AppError(
      401,
      ERROR_CODES.API_KEY_REVOKED,
      "This API key's creator is no longer a member of the workspace",
    );
  }

  const creator = await prisma.user.findUnique({
    where: { id: apiKey.createdById },
    select: { id: true, email: true, name: true },
  });

  if (!creator) {
    throw new AppError(401, ERROR_CODES.API_KEY_REVOKED, "This API key's creator no longer exists");
  }

  // Debounced lastUsedAt update
  const now = Date.now();
  const lastUpdate = lastUsedAtCache.get(apiKey.id) ?? 0;
  if (now - lastUpdate > LAST_USED_DEBOUNCE_MS) {
    lastUsedAtCache.set(apiKey.id, now);
    prisma.apiKey
      .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {}); // Fire-and-forget, non-critical
  }

  return {
    user: creator,
    workspace: { id: apiKey.workspaceId, role: membership.role },
    apiKey: { id: apiKey.id, name: apiKey.name, workspaceId: apiKey.workspaceId },
  };
}
