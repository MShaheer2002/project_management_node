/**
 * AI Context Builder — Minimal Workspace Context for AI Calls
 *
 * Fetches ONLY the data the AI needs for a specific task — never the full workspace state.
 * This is the RAG layer: real data from DB → injected into AI prompt.
 *
 * Context is cached in-memory for 5 minutes to avoid redundant DB queries.
 */

import { prisma } from "../../shared/utils/prisma.js";

// ─── In-Memory Cache ────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Sentinel value to distinguish "cached null" from "cache miss"
const CACHE_NULL = Symbol("CACHE_NULL");

const contextCache = new Map<string, { data: unknown; expiresAt: number }>();

function getCached<T>(key: string): { hit: true; data: T } | { hit: false } {
  const entry = contextCache.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    contextCache.delete(key);
    return { hit: false };
  }
  return { hit: true, data: (entry.data === CACHE_NULL ? null : entry.data) as T };
}

function setCache(key: string, data: unknown): void {
  contextCache.set(key, { data: data ?? CACHE_NULL, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Invalidate cached context for a workspace.
 * Call this when workspace members, labels, projects, or templates change.
 */
export function invalidateContextCache(workspaceId?: string): void {
  if (!workspaceId) {
    contextCache.clear();
    return;
  }
  for (const key of contextCache.keys()) {
    if (key.includes(workspaceId)) {
      contextCache.delete(key);
    }
  }
}

// ─── Context Fetchers ───────────────────────────────────────────────────────

/**
 * Get compact project list: [{id, name}]
 * ~200 tokens for 20 projects.
 */
export async function getProjectNames(workspaceId: string): Promise<Array<{ id: string; name: string }>> {
  const cacheKey = `projects:${workspaceId}`;
  const cached = getCached<Array<{ id: string; name: string }>>(cacheKey);
  if (cached.hit) return cached.data;

  const projects = await prisma.project.findMany({
    where: { workspaceId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 50,
  });

  setCache(cacheKey, projects);
  return projects;
}

/**
 * Get compact member list: [{id, name}]
 * ~200 tokens for 20 members.
 */
export async function getMemberNames(workspaceId: string): Promise<Array<{ id: string; name: string }>> {
  const cacheKey = `members:${workspaceId}`;
  const cached = getCached<Array<{ id: string; name: string }>>(cacheKey);
  if (cached.hit) return cached.data;

  const memberships = await prisma.workspaceMembership.findMany({
    where: { workspaceId },
    select: {
      user: { select: { id: true, name: true } },
    },
    take: 100,
  });

  const members = memberships.map((m) => ({ id: m.user.id, name: m.user.name }));
  setCache(cacheKey, members);
  return members;
}

/**
 * Get label names: ["bug", "frontend", "urgent", ...]
 * ~100 tokens for 30 labels.
 */
export async function getLabelNames(workspaceId: string): Promise<string[]> {
  const cacheKey = `labels:${workspaceId}`;
  const cached = getCached<string[]>(cacheKey);
  if (cached.hit) return cached.data;

  const labels = await prisma.label.findMany({
    where: { workspaceId },
    select: { name: true },
    orderBy: { name: "asc" },
    take: 100,
  });

  const names = labels.map((l) => l.name);
  setCache(cacheKey, names);
  return names;
}

/**
 * Get active template for a specific issue type.
 * Returns null if no active template exists for that type.
 */
export async function getActiveTemplate(
  workspaceId: string,
  issueType: string,
): Promise<{
  id: string;
  name: string;
  titleTemplate: string | null;
  contentTemplate: string | null;
  stepsToReproduceTemplate: string | null;
  expectedBehaviorTemplate: string | null;
  actualBehaviorTemplate: string | null;
  acceptanceCriteriaTemplate: string | null;
  notesTemplate: string | null;
  defaultPriority: string | null;
  defaultStatus: string | null;
  defaultSeverity: string | null;
  defaultAssigneeId: string | null;
  defaultLabelIds: unknown;
  checklistItems: unknown;
} | null> {
  // Templates change less frequently — cache for longer
  const cacheKey = `template:${workspaceId}:${issueType}`;
  const cached = getCached<Awaited<ReturnType<typeof getActiveTemplate>>>(cacheKey);
  if (cached.hit) return cached.data;

  const template = await prisma.template.findFirst({
    where: {
      workspaceId,
      issueType,
      isActive: true,
      lifecycle: "ACTIVE",
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      titleTemplate: true,
      contentTemplate: true,
      stepsToReproduceTemplate: true,
      expectedBehaviorTemplate: true,
      actualBehaviorTemplate: true,
      acceptanceCriteriaTemplate: true,
      notesTemplate: true,
      defaultPriority: true,
      defaultStatus: true,
      defaultSeverity: true,
      defaultAssigneeId: true,
      defaultLabelIds: true,
      checklistItems: true,
    },
  });

  setCache(cacheKey, template);
  return template;
}

/**
 * Resolve @mention strings to user IDs.
 * Matches by name (case-insensitive, partial match).
 *
 * e.g., ["sarah", "john"] → { "sarah": "user_abc", "john": "user_def" }
 */
export async function resolveMentions(
  workspaceId: string,
  mentions: string[],
): Promise<Record<string, string>> {
  if (mentions.length === 0) return {};

  const members = await getMemberNames(workspaceId);
  const resolved: Record<string, string> = {};

  for (const mention of mentions) {
    const lower = mention.toLowerCase();
    // Exact match first, then partial
    const exact = members.find((m) => m.name.toLowerCase() === lower);
    if (exact) {
      resolved[mention] = exact.id;
      continue;
    }

    const partial = members.find((m) => m.name.toLowerCase().includes(lower));
    if (partial) {
      resolved[mention] = partial.id;
    }
  }

  return resolved;
}

/**
 * Build the full context object for issue generation.
 * This is everything the AI needs — nothing more.
 *
 * Total: ~600-800 tokens for a typical workspace.
 */
export async function buildIssueGenerationContext(workspaceId: string, issueType?: string) {
  const [projects, members, labels, template] = await Promise.all([
    getProjectNames(workspaceId),
    getMemberNames(workspaceId),
    getLabelNames(workspaceId),
    issueType ? getActiveTemplate(workspaceId, issueType) : Promise.resolve(null),
  ]);

  return { projects, members, labels, template };
}
