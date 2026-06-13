/**
 * Figma Integration — Service Layer
 *
 * Read-only integration: connects via personal access token,
 * fetches file metadata + thumbnails from Figma API.
 *
 * No outbound notifications, no webhooks, no dispatcher registration.
 */

import { prisma } from "../../../shared/utils/prisma.js";
import { AppError } from "../../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../../shared/errors/error-codes.js";
import { logActivity } from "../../../shared/utils/activity.js";
import {
  findConnectedIntegration,
  initDefaultSettings,
} from "../integration.service.js";
import {
  extractFigmaFileKey,
  extractFigmaNodeId,
  isFigmaUrl,
  type FigmaFileMetadata,
  type FigmaUserInfo,
} from "./figma.utils.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const FIGMA_API_BASE = "https://api.figma.com/v1";

const DEFAULT_FIGMA_SETTINGS: Record<string, boolean> = {
  showThumbnails: true,
  showLastModified: true,
};

// ─── In-Memory Cache ─────────────────────────────────────────────────────────
// Caches Figma API responses to avoid hitting rate limits on repeated page loads.
// TTL: 10 minutes. Entries evicted on size limit (max 200 entries).

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_ENTRIES = 200;

// Rate limit tracking — if Figma returns 429, don't hit the API again until the cooldown expires
let rateLimitedUntil = 0;

function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T) {
  // Evict oldest entries if cache is full
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── Figma API Helpers ───────────────────────────────────────────────────────

async function figmaGet<T>(token: string, path: string): Promise<T | null> {
  // Check cache first
  const cacheKey = path;
  const cached = getCached<T>(cacheKey);
  if (cached !== undefined) return cached;

  // If rate limited, skip the API call entirely
  if (Date.now() < rateLimitedUntil) {
    console.warn("[Figma] Skipping API call — still rate limited");
    return null;
  }

  try {
    const response = await fetch(`${FIGMA_API_BASE}${path}`, {
      headers: { "X-FIGMA-TOKEN": token },
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const body = await response.text().catch(() => "");
        console.warn(`[Figma] Token invalid or expired (${response.status}):`, body);
        return null;
      }
      if (response.status === 404) {
        return null;
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "300");
        // Cap at 1 hour max to avoid absurdly long lockouts
        const cappedRetry = Math.min(retryAfter, 3600);
        rateLimitedUntil = Date.now() + cappedRetry * 1000;
        console.warn(`[Figma] Rate limited. Blocking API calls for ${cappedRetry}s`);
        return null;
      }
      console.warn(`[Figma] API error (${response.status})`);
      return null;
    }

    const data = (await response.json()) as T;
    setCache(cacheKey, data);
    return data;
  } catch (err) {
    console.warn("[Figma] API request failed");
    return null;
  }
}

// ─── Connect ─────────────────────────────────────────────────────────────────

/**
 * Connect Figma — verify the personal access token and store it.
 */
export async function connectFigma(
  workspaceId: string,
  userId: string,
  accessToken: string,
) {
  // Verify the token by calling /v1/me
  const user = await figmaGet<FigmaUserInfo>(accessToken, "/me");

  if (!user) {
    throw new AppError(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      "Invalid Figma access token. Generate one at figma.com/developers → Personal Access Tokens.",
    );
  }

  const providerMeta = {
    figmaUser: {
      id: user.id,
      handle: user.handle,
      email: user.email,
      imgUrl: user.imgUrl,
    },
  };

  const integration = await prisma.integration.upsert({
    where: { workspaceId_provider: { workspaceId, provider: "FIGMA" } },
    create: {
      workspaceId,
      provider: "FIGMA",
      connected: true,
      accessToken,
      providerMeta: providerMeta as any,
      connectedAt: new Date(),
      connectedById: userId,
    },
    update: {
      connected: true,
      accessToken,
      providerMeta: providerMeta as any,
      connectedAt: new Date(),
      connectedById: userId,
    },
  });

  await initDefaultSettings(integration.id, DEFAULT_FIGMA_SETTINGS);

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "INTEGRATION_CONNECTED",
    targetType: "INTEGRATION",
    targetId: "FIGMA",
    message: `Figma integration connected (${user.handle})`,
    metadata: { provider: "figma", figmaHandle: user.handle },
  });

  return {
    provider: "figma",
    figmaUser: { handle: user.handle, email: user.email },
  };
}

// ─── Preview ─────────────────────────────────────────────────────────────────

/**
 * Fetch Figma file metadata from a URL.
 * Returns name, thumbnail, last modified, and link back to Figma.
 */
export async function previewFigmaFile(workspaceId: string, url: string) {
  if (!isFigmaUrl(url)) {
    throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "Not a valid Figma URL");
  }

  const fileKey = extractFigmaFileKey(url);
  if (!fileKey) {
    throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "Could not extract file key from Figma URL");
  }

  const integration = await findConnectedIntegration(workspaceId, "FIGMA");
  if (!integration?.accessToken) {
    throw new AppError(404, ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Figma is not connected. Connect it in Settings → Integrations.");
  }

  const fileData = await figmaGet<FigmaFileMetadata>(
    integration.accessToken,
    `/files/${fileKey}?depth=1`,
  );

  if (!fileData) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Figma file not found or access denied. Check that the token has access to this file.");
  }

  const nodeId = extractFigmaNodeId(url);

  // Fetch node-specific thumbnail if a node ID is provided
  let thumbnailUrl = fileData.thumbnailUrl;
  if (nodeId) {
    const imageData = await figmaGet<{ images: Record<string, string> }>(
      integration.accessToken,
      `/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=2`,
    );
    if (imageData?.images?.[nodeId]) {
      thumbnailUrl = imageData.images[nodeId];
    }
  }

  return {
    fileKey,
    name: fileData.name,
    thumbnailUrl,
    lastModified: fileData.lastModified,
    version: fileData.version,
    editorType: fileData.editorType,
    nodeId,
    url, // Original URL passed in — for "Open in Figma" button
  };
}

// ─── Batch Preview ───────────────────────────────────────────────────────────

/**
 * Fetch metadata for multiple Figma URLs at once.
 * Used when loading an issue or project page that has multiple linked designs.
 * Deduplicates by file key to avoid redundant API calls.
 */
export async function batchPreviewFigmaFiles(workspaceId: string, urls: string[]) {
  const integration = await findConnectedIntegration(workspaceId, "FIGMA");
  if (!integration?.accessToken) return [];

  const token = integration.accessToken;

  // Deduplicate by file key
  const fileKeys = new Map<string, string[]>(); // fileKey → [urls]
  for (const url of urls) {
    if (!isFigmaUrl(url)) continue;
    const key = extractFigmaFileKey(url);
    if (!key) continue;
    const existing = fileKeys.get(key) ?? [];
    existing.push(url);
    fileKeys.set(key, existing);
  }

  // Fetch all unique files in parallel (deduped by file key)
  const fetchPromises = [...fileKeys.entries()].map(async ([fileKey, fileUrls]) => {
    const fileData = await figmaGet<FigmaFileMetadata>(
      token,
      `/files/${fileKey}?depth=1`,
    );
    if (!fileData) return [];

    return fileUrls.map((url) => ({
      url,
      fileKey,
      name: fileData.name,
      thumbnailUrl: fileData.thumbnailUrl,
      lastModified: fileData.lastModified,
    }));
  });

  const settled = await Promise.allSettled(fetchPromises);
  return settled
    .filter((r): r is PromiseFulfilledResult<typeof r extends PromiseFulfilledResult<infer V> ? V : never> => r.status === "fulfilled")
    .flatMap((r) => r.value);
}
