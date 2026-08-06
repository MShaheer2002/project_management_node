/**
 * Hybrid workspace search — Phase 20L
 *
 * Combines three retrieval strategies because each fails where the others work:
 *
 *   - **Exact key** (`TRU-42`). Someone pasting an issue key wants that issue,
 *     not something semantically near it. Vector search is actively wrong here:
 *     an id is a token, not a meaning.
 *   - **Keyword** (Postgres `ILIKE`). Catches literal strings embeddings blur —
 *     error codes, stack traces, function names, `/notification-count`. Nothing
 *     about "ECONNREFUSED" is semantically meaningful, but it matches exactly.
 *   - **Vector** (pgvector). Catches paraphrase keywords miss entirely: "login
 *     broken" finding "Auth fails on OAuth callback", which share no substring.
 *
 * Results are merged with Reciprocal Rank Fusion rather than by comparing raw
 * scores. Cosine similarity and a keyword match are not on the same scale and
 * cannot be meaningfully averaged; RRF only uses each result's *rank* within its
 * own strategy, which sidesteps the normalization problem entirely and is the
 * standard approach for exactly this.
 *
 * Permission model: this returns entity ids and labels only. Every caller must
 * still enforce visibility — the embeddings table has no notion of private
 * projects or team membership, so treating a search hit as authorization would
 * leak. `filterVisibleHits` applies the per-type rules for all indexed types.
 */

import { prisma } from "../../shared/utils/prisma.js";
import { createEmbedding } from "./ai.provider.js";
import { logAiWarn } from "./ai.observability.js";
import type { IndexableEntityType } from "./ai.embedding-content.js";

/**
 * Rank-fusion constant. 60 is the value from the original RRF paper and the
 * common default; it damps the influence of top ranks enough that a single
 * strategy cannot dominate the merged list.
 */
const RRF_K = 60;

/** Minimum cosine similarity for a vector hit to be considered at all. */
const MIN_VECTOR_SIMILARITY = 0.3;

/** Candidates fetched per strategy before fusion. */
const CANDIDATES_PER_STRATEGY = 25;

/** Matches a workspace issue key such as TRU-42. Prefix is 2-10 uppercase letters. */
const ISSUE_KEY_PATTERN = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/i;

export interface SearchHit {
  entityType: IndexableEntityType;
  entityId: string;
  label: string;
  /** Fused relevance. Comparable within one result set, not across queries. */
  score: number;
  /** Which strategies surfaced this hit — useful for debugging relevance. */
  matchedBy: Array<"exact" | "keyword" | "vector">;
}

export interface SearchOptions {
  workspaceId: string;
  query: string;
  /** Restrict to specific entity types. Omit to search everything indexed. */
  entityTypes?: IndexableEntityType[] | undefined;
  limit?: number | undefined;
  /** Skip the embedding call. Useful when latency matters more than recall. */
  keywordOnly?: boolean | undefined;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Strategies that actually contributed, so callers can explain thin results. */
  strategies: Array<"exact" | "keyword" | "vector">;
  /** True when the vector leg was unavailable and results are keyword-only. */
  degraded: boolean;
}

export async function searchWorkspace(options: SearchOptions): Promise<SearchResult> {
  const query = options.query.trim();
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);

  if (!query) {
    return { hits: [], strategies: [], degraded: false };
  }

  // An exact issue key short-circuits everything. Someone who typed TRU-42 is
  // not looking for issues that resemble TRU-42.
  const exactHit = await findByIssueKey(query, options.workspaceId);
  if (exactHit) {
    return { hits: [exactHit], strategies: ["exact"], degraded: false };
  }

  const [keywordHits, vectorOutcome] = await Promise.all([
    keywordSearch(query, options),
    options.keywordOnly ? Promise.resolve({ hits: [], failed: false }) : vectorSearch(query, options),
  ]);

  const strategies: Array<"exact" | "keyword" | "vector"> = [];
  if (keywordHits.length > 0) strategies.push("keyword");
  if (vectorOutcome.hits.length > 0) strategies.push("vector");

  return {
    hits: fuseByReciprocalRank([
      { strategy: "keyword", results: keywordHits },
      { strategy: "vector", results: vectorOutcome.hits },
    ]).slice(0, limit),
    strategies,
    // Reported so a caller can say "keyword results only" instead of silently
    // presenting degraded recall as if it were complete.
    degraded: vectorOutcome.failed,
  };
}

// ─── Strategies ─────────────────────────────────────────────────────────────

async function findByIssueKey(query: string, workspaceId: string): Promise<SearchHit | null> {
  const match = query.match(ISSUE_KEY_PATTERN);
  if (!match) return null;

  const issue = await prisma.issue.findFirst({
    where: { id: match[0].toUpperCase(), workspaceId },
    select: { id: true, title: true },
  });
  if (!issue) return null;

  return {
    entityType: "ISSUE",
    entityId: issue.id,
    label: `${issue.id} — ${issue.title}`,
    score: 1,
    matchedBy: ["exact"],
  };
}

/**
 * Literal matching over the stored embedding content.
 *
 * Runs against `AiEmbedding.content` rather than the source tables so one query
 * covers every entity type, and so keyword and vector legs search exactly the
 * same text — otherwise the two strategies would disagree about what an entity
 * even says.
 */
async function keywordSearch(query: string, options: SearchOptions): Promise<RankedResult[]> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 2)
    .slice(0, 6);

  if (terms.length === 0) return [];

  const rows = await prisma.aiEmbedding.findMany({
    where: {
      workspaceId: options.workspaceId,
      ...(options.entityTypes?.length ? { entityType: { in: options.entityTypes } } : {}),
      // AND across terms: a row mentioning every term beats one mentioning any.
      AND: terms.map((term) => ({ content: { contains: term, mode: "insensitive" as const } })),
    },
    select: { entityType: true, entityId: true, content: true },
    take: CANDIDATES_PER_STRATEGY,
  }).catch(() => []);

  return rows.map((row) => ({
    entityType: row.entityType as IndexableEntityType,
    entityId: row.entityId,
    label: deriveLabel(row.content),
  }));
}

async function vectorSearch(
  query: string,
  options: SearchOptions,
): Promise<{ hits: RankedResult[]; failed: boolean }> {
  try {
    const { embedding } = await createEmbedding(query);

    const typeFilter = options.entityTypes?.length
      ? `AND "entityType" = ANY($3::"AiEmbeddingEntityType"[])`
      : "";

    const params: unknown[] = [
      `[${embedding.map((value) => (Number.isFinite(value) ? value : 0)).join(",")}]`,
      options.workspaceId,
    ];
    if (options.entityTypes?.length) params.push(options.entityTypes);

    const rows = await prisma.$queryRawUnsafe<
      Array<{ entityType: string; entityId: string; content: string; similarity: number }>
    >(
      `SELECT "entityType", "entityId", "content",
              1 - ("embedding" <=> $1::vector) AS similarity
         FROM "AiEmbedding"
        WHERE "workspaceId" = $2
          ${typeFilter}
        ORDER BY "embedding" <=> $1::vector
        LIMIT ${CANDIDATES_PER_STRATEGY}`,
      ...params,
    );

    return {
      hits: rows
        // A vector index always returns *something*; without a floor the least
        // dissimilar row in the workspace comes back as a "match".
        .filter((row) => row.similarity >= MIN_VECTOR_SIMILARITY)
        .map((row) => ({
          entityType: row.entityType as IndexableEntityType,
          entityId: row.entityId,
          label: deriveLabel(row.content),
        })),
      failed: false,
    };
  } catch (error) {
    // Semantic search is an enhancement. If the embedding provider is down,
    // degrade to keyword results rather than failing the user's search.
    logAiWarn("vector_search_failed", {
      workspaceId: options.workspaceId,
      feature: "chat",
      success: false,
      errorMessage: error instanceof Error ? error.message : "Vector search failed",
    });
    return { hits: [], failed: true };
  }
}

// ─── Fusion ─────────────────────────────────────────────────────────────────

interface RankedResult {
  entityType: IndexableEntityType;
  entityId: string;
  label: string;
}

/**
 * Reciprocal Rank Fusion.
 *
 * score(d) = Σ 1 / (k + rank(d))  across strategies that returned d.
 *
 * Uses rank rather than raw score on purpose: cosine similarity and "matched a
 * keyword" are incomparable quantities, and any attempt to normalize them into
 * a shared scale bakes in an arbitrary weighting. Ranks are comparable by
 * construction, and a document found by both strategies naturally outranks one
 * found by either alone.
 */
function fuseByReciprocalRank(
  groups: Array<{ strategy: "keyword" | "vector"; results: RankedResult[] }>,
): SearchHit[] {
  const merged = new Map<string, SearchHit>();

  for (const group of groups) {
    group.results.forEach((result, index) => {
      const key = `${result.entityType}:${result.entityId}`;
      const contribution = 1 / (RRF_K + index + 1);
      const existing = merged.get(key);

      if (existing) {
        existing.score += contribution;
        if (!existing.matchedBy.includes(group.strategy)) {
          existing.matchedBy.push(group.strategy);
        }
        return;
      }

      merged.set(key, {
        entityType: result.entityType,
        entityId: result.entityId,
        label: result.label,
        score: contribution,
        matchedBy: [group.strategy],
      });
    });
  }

  return [...merged.values()].sort((a, b) => b.score - a.score);
}

/**
 * Recovers a display label from stored embedding content.
 *
 * Content builders put the identifying line first ("BUG TRU-14: Sign-in fails"),
 * so the first segment is the label. Cheap, and avoids a second query per hit
 * purely to render results.
 */
function deriveLabel(content: string): string {
  const firstLine = content.split("\n")[0]?.trim() ?? content;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

// ─── Visibility ─────────────────────────────────────────────────────────────

export interface SearchViewer {
  workspaceId: string;
  userId: string;
  /** Workspace role — GUEST sees only public teams and departments. */
  role: string;
}

/**
 * Narrows search hits to what a specific user may see.
 *
 * The embeddings table is deliberately permission-blind — it stores text, not
 * access rules — so search results are candidates, never authorization. Every
 * caller returning hits to a user must pass them through here.
 *
 * Rules mirror the domain services rather than inventing a second policy:
 *
 * | Type              | Rule                                                  |
 * |-------------------|-------------------------------------------------------|
 * | ISSUE             | its project is public, led by, or joined by the user   |
 * | COMMENT, DOCUMENT | inherits its parent issue's / project's visibility     |
 * | PROJECT           | public, led by, or joined by the user                  |
 * | TEAM, DEPARTMENT  | GUEST sees public only; everyone else sees all         |
 * | CYCLE             | inherits its team's visibility                         |
 * | MEMBER            | workspace-scoped — anyone in the workspace may see     |
 *
 * Comments and documents are the ones easy to get wrong: their own row carries
 * no visibility, so without the parent lookup a comment on a private project's
 * issue would be freely searchable. Filtering is fail-closed — a hit whose
 * parent cannot be resolved is dropped, not kept.
 */
export async function filterVisibleHits(
  hits: SearchHit[],
  viewer: SearchViewer,
): Promise<SearchHit[]> {
  if (hits.length === 0) return hits;
  if (viewer.role === "OWNER" || viewer.role === "ADMIN") return hits;

  const idsOf = (type: IndexableEntityType) =>
    hits.filter((hit) => hit.entityType === type).map((hit) => hit.entityId);

  const { workspaceId, userId, role } = viewer;
  // Teams, departments and cycles: only GUEST is restricted (to public),
  // matching `buildTeamWhere` / `buildDepartmentWhere`. Everyone else sees
  // all, so the query is skipped entirely rather than run and discarded.
  const isGuest = role === "GUEST";

  const issueIds = idsOf("ISSUE");
  const commentIds = idsOf("COMMENT");
  const documentIds = idsOf("DOCUMENT");
  const projectIds = idsOf("PROJECT");
  const teamIds = idsOf("TEAM");
  const departmentIds = idsOf("DEPARTMENT");
  const cycleIds = idsOf("CYCLE");

  const [issues, comments, documents, projects, teams, departments, cycles] = await Promise.all([
    allowedIds(prisma.issue, issueIds, { workspaceId, id: { in: issueIds }, project: visibleProjectWhere(userId) }),
    allowedIds(prisma.comment, commentIds, {
      id: { in: commentIds },
      issue: { workspaceId, project: visibleProjectWhere(userId) },
    }),
    allowedIds(prisma.entityDocument, documentIds, {
      workspaceId,
      id: { in: documentIds },
      OR: [{ projectId: null }, { project: visibleProjectWhere(userId) }],
    }),
    allowedIds(prisma.project, projectIds, { workspaceId, id: { in: projectIds }, ...visibleProjectWhere(userId) }),
    isGuest
      ? allowedIds(prisma.team, teamIds, { workspaceId, id: { in: teamIds }, visibility: "PUBLIC" })
      : Promise.resolve(null),
    isGuest
      ? allowedIds(prisma.department, departmentIds, {
          workspaceId,
          id: { in: departmentIds },
          visibility: "PUBLIC",
        })
      : Promise.resolve(null),
    isGuest
      ? allowedIds(prisma.cycle, cycleIds, { workspaceId, id: { in: cycleIds }, team: { visibility: "PUBLIC" } })
      : Promise.resolve(null),
  ]);

  const allowed: Record<string, Set<string> | null> = {
    ISSUE: issues,
    COMMENT: comments,
    DOCUMENT: documents,
    PROJECT: projects,
    TEAM: teams,
    DEPARTMENT: departments,
    CYCLE: cycles,
    MEMBER: null, // workspace scope is the only rule
  };

  return hits.filter((hit) => {
    const permitted = allowed[hit.entityType];
    return permitted === null || permitted === undefined || permitted.has(hit.entityId);
  });
}

/** Projects this user may see, as a reusable `where` fragment. */
function visibleProjectWhere(userId: string) {
  return {
    OR: [
      { visibility: "PUBLIC" as const },
      { leadId: userId },
      { memberships: { some: { userId } } },
    ],
  };
}

/**
 * Resolves which of `ids` this viewer may see for one entity type, given the
 * type's visibility rule as a Prisma `where` fragment. Every `allowed*Ids`
 * check above was this same shape with a different model and rule.
 */
async function allowedIds(
  delegate: { findMany: (args: { where: object; select: { id: true } }) => Promise<Array<{ id: string }>> },
  ids: string[],
  where: object,
): Promise<Set<string> | null> {
  if (ids.length === 0) return null;

  const rows = await delegate.findMany({ where, select: { id: true } });
  return new Set(rows.map((row) => row.id));
}
