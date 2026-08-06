/**
 * Shared free-text search resolution for the consolidated registry.
 *
 * `issues_search` originally had its own private copy of this (Phase 20L). It
 * is pulled out here so projects, teams, departments and cycles get the same
 * semantic-plus-keyword behaviour instead of staying on plain substring
 * matching — the four entity types were embedded from day one of the vector
 * work but nothing was querying those vectors except issues.
 *
 * Each domain tool still does its own re-read through its own service (not
 * this file) so that the service's existing visibility clause, mapping and
 * pagination stay the single source of truth — this only resolves *which*
 * ids are relevant and in what order.
 */

import { filterVisibleHits, searchWorkspace } from "../../ai.search.js";
import type { SearchHit } from "../../ai.search.js";
import type { IndexableEntityType } from "../../ai.embedding-content.js";
import { ok, type RegistryContext } from "./types.js";
import type { AgentToolExecutionResult } from "../../ai.agent.js";

export interface HybridResolution {
  /** Ids in relevance order, already narrowed to what this user may see. */
  rankedIds: string[];
  strategies: Array<"exact" | "keyword" | "vector">;
  degraded: boolean;
}

/**
 * Resolves a free-text query to a ranked, visibility-filtered set of ids for
 * one entity type. Returns null when there is nothing to narrow by — either
 * the query was empty or nothing matched — so callers fall back to their
 * normal filtered list rather than reporting an empty result.
 */
export async function resolveHybridIds(
  entityType: IndexableEntityType,
  query: string,
  ctx: RegistryContext,
  limit: number,
): Promise<HybridResolution | null> {
  const search = await searchWorkspace({
    workspaceId: ctx.workspaceId,
    query,
    entityTypes: [entityType],
    limit: limit * 2, // over-fetch: the caller's own filters will remove some
  }).catch(() => null);

  if (!search || search.hits.length === 0) return null;

  const visible: SearchHit[] = await filterVisibleHits(search.hits, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    role: ctx.userRole,
  });

  if (visible.length === 0) return null;

  return {
    rankedIds: visible.map((hit) => hit.entityId),
    strategies: search.strategies,
    degraded: search.degraded,
  };
}

/** Re-sorts already-fetched rows to match the relevance order hybrid search produced. */
export function sortByRank<T extends { id: string }>(rows: T[], rankedIds: string[]): T[] {
  const rank = new Map(rankedIds.map((id, index) => [id, index]));
  return [...rows].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

/**
 * Full "search tool" shape shared by projects/teams/departments/cycles:
 * resolve ids by relevance, re-read them through the entity's own list
 * function (so its filters/visibility/mapping stay authoritative), restore
 * relevance order, and shape a tool result — or null so the caller falls
 * back to substring search.
 *
 * `listFn` receives the ranked ids and returns whatever that entity's own
 * service returns; callers close over any extra filters (teamId, status)
 * from the tool's own args when building it. `map` is only needed when the
 * raw list-service rows are richer than what should go back to the model.
 */
export async function hybridListSearch<T extends { id: string }, R = T>(
  entityType: IndexableEntityType,
  query: string,
  ctx: RegistryContext,
  limit: number,
  listFn: (rankedIds: string[]) => Promise<{ items: T[] }>,
  map?: (item: T) => R,
): Promise<AgentToolExecutionResult | null> {
  const resolution = await resolveHybridIds(entityType, query, ctx, limit);
  if (!resolution) return null;

  const result = await listFn(resolution.rankedIds);
  if (result.items.length === 0) return null;

  const ranked = sortByRank(result.items, resolution.rankedIds);

  return ok(map ? ranked.map(map) : ranked, {
    count: ranked.length,
    searchStrategies: resolution.strategies,
    semanticSearchDegraded: resolution.degraded,
  });
}
