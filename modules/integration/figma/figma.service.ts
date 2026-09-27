/**
 * Figma Integration — Service Layer
 *
 * Read-only integration: connects via personal access token,
 * fetches file metadata + thumbnails from Figma API.
 *
 * No outbound notifications, no webhooks, no dispatcher registration.
 */

import { encryptSecret } from "../../../shared/utils/secret-box.js";
import { prisma } from "../../../shared/utils/prisma.js";
import { createHash } from "node:crypto";
import { AppError } from "../../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../../shared/errors/error-codes.js";
import { logActivity } from "../../../shared/utils/activity.js";
import {
  findConnectedIntegration,
  initDefaultSettings,
} from "../integration.service.js";
import {
  extractFigmaFileKey,
  isFigmaUrl,
  type FigmaFileMetadata,
  type FigmaUserInfo,
} from "./figma.utils.js";
import { assertIntegrationAllowedForPlan } from "../../billing/billing.service.js";
import { assertIssueVisible, type Viewer } from "../../../shared/utils/visibility.js";

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

// Rate limit tracking is scoped per token so one workspace cannot block another.
const rateLimitedUntilByToken = new Map<string, number>();

function getTokenCacheKey(token: string, path: string) {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return `${tokenHash}:${path}`;
}

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

async function figmaGet<T>(
  token: string,
  path: string,
  options?: { skipCache?: boolean },
): Promise<T | null> {
  const cacheKey = getTokenCacheKey(token, path);
  if (!options?.skipCache) {
    const cached = getCached<T>(cacheKey);
    if (cached !== undefined) return cached;
  }

  // If this token is rate limited, skip the API call entirely
  const rateLimitedUntil = rateLimitedUntilByToken.get(cacheKey) ?? 0;
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
        rateLimitedUntilByToken.set(cacheKey, Date.now() + cappedRetry * 1000);
        console.warn(`[Figma] Rate limited. Blocking API calls for ${cappedRetry}s`);
        return null;
      }
      console.warn(`[Figma] API error (${response.status})`);
      return null;
    }

    const data = (await response.json()) as T;
    if (!options?.skipCache) {
      setCache(cacheKey, data);
    }
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
  await assertIntegrationAllowedForPlan(workspaceId, "FIGMA");

  // Verify the token by calling /v1/me
  const user = await figmaGet<FigmaUserInfo>(accessToken, "/me", { skipCache: true });

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
      accessToken: encryptSecret(accessToken),
      providerMeta: providerMeta as any,
      connectedAt: new Date(),
      connectedById: userId,
    },
    update: {
      connected: true,
      accessToken: encryptSecret(accessToken),
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

/** Every Figma file key mentioned in some text (issue description HTML, stored links). */
function figmaFileKeysIn(text: string) {
  return new Set([...text.matchAll(/figma\.com\/(?:file|design|proto|board)\/([a-zA-Z0-9]+)/g)].map((match) => match[1]!));
}

/**
 * Preview cards for the Figma links on one issue.
 *
 * The connected token belongs to the admin who connected Figma, so fetching
 * any URL a caller sent let anyone in the workspace (guests included) read
 * the name, thumbnail and date of files only that admin can open (F-41).
 * Now the caller must be able to see the issue, and only links that are
 * actually in that issue (description or attached links) are looked up;
 * anything else is skipped.
 */
export async function batchPreviewFigmaFiles(workspaceId: string, viewer: Viewer, issueId: string, urls: string[]) {
  await assertIssueVisible(workspaceId, issueId, viewer);
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: { description: true, integrationRef: true },
  });
  if (!issue) return [];
  const linkedKeys = figmaFileKeysIn(`${issue.description ?? ""} ${JSON.stringify(issue.integrationRef ?? null)}`);

  const integration = await findConnectedIntegration(workspaceId, "FIGMA");
  if (!integration?.accessToken) return [];

  const token = integration.accessToken;

  // Deduplicate by file key; drop anything not linked from this issue
  const fileKeys = new Map<string, string[]>(); // fileKey → [urls]
  for (const url of urls) {
    if (!isFigmaUrl(url)) continue;
    const key = extractFigmaFileKey(url);
    if (!key || !linkedKeys.has(key)) continue;
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
  return settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
