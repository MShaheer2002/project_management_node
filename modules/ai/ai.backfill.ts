/**
 * Embedding backfill — Phase 20L
 *
 * Indexing now happens on write, but that only covers entities changed *after*
 * the hooks landed. Everything created before is still invisible to semantic
 * search — which, at the time of writing, is most of the workspace. This walks
 * existing rows and fills the gap.
 *
 * Design constraints that shaped this:
 *
 *   - **Idempotent.** Safe to run repeatedly. The store layer hashes rendered
 *     content and skips the provider call when nothing changed, so a second run
 *     over unchanged data costs database reads and no money.
 *   - **Resumable.** Cursor-paginated by id. A crash halfway through does not
 *     mean starting over, and it never holds a long transaction open.
 *   - **Bounded concurrency.** Embeddings are a rate-limited external API.
 *     Firing thousands of parallel requests would get throttled and would also
 *     compete with live traffic for the same quota.
 *   - **Direct, not queued.** Pushing tens of thousands of jobs onto the same
 *     queue the app uses for live indexing would bury real-time updates behind
 *     a bulk job. Backfill runs in its own process at its own pace.
 */

import { prisma } from "../../shared/utils/prisma.js";
import { buildEmbeddingContent, type IndexableEntityType } from "./ai.embedding-content.js";
import { storeEntityEmbedding } from "./ai.embeddings.js";
import { logAiInfo, logAiWarn } from "./ai.observability.js";

/** Rows fetched per page. Small enough to bound memory, large enough to amortize round-trips. */
const PAGE_SIZE = 200;

/** Concurrent embedding requests. Conservative: the provider rate-limits, and live traffic shares the quota. */
const DEFAULT_CONCURRENCY = 4;

export interface BackfillOptions {
  /** Restrict to one workspace. Omit to process every workspace. */
  workspaceId?: string | undefined;
  /** Restrict to specific entity types. Omit for all. */
  entityTypes?: IndexableEntityType[] | undefined;
  /** Report what would happen without calling the embedding API or writing. */
  dryRun?: boolean | undefined;
  concurrency?: number | undefined;
  /** Invoked after each page so a CLI can show progress on long runs. */
  onProgress?: ((progress: BackfillProgress) => void) | undefined;
}

export interface BackfillProgress {
  entityType: IndexableEntityType;
  workspaceId: string;
  scanned: number;
  /** Rows that produced a fresh embedding (a real provider call). */
  indexed: number;
  /** Rows already up to date — content hash matched, so no provider call. */
  unchanged: number;
  /** Rows with nothing embeddable, or that vanished mid-scan. */
  skipped: number;
  failed: number;
}

export interface BackfillResult {
  scanned: number;
  indexed: number;
  unchanged: number;
  skipped: number;
  failed: number;
  byEntityType: Record<
    string,
    { scanned: number; indexed: number; unchanged: number; skipped: number; failed: number }
  >;
  durationMs: number;
}

/**
 * Locates candidate rows per entity type.
 *
 * Each returns `{ id }` pairs scoped to a workspace, ordered by id so cursor
 * pagination is stable. Comments and documents are the two types that were
 * previously unreachable, so they matter most here.
 */
const ENTITY_SOURCES: Record<
  IndexableEntityType,
  (workspaceId: string, cursor: string | null, take: number) => Promise<Array<{ id: string }>>
> = {
  ISSUE: (workspaceId, cursor, take) =>
    prisma.issue.findMany({
      where: { workspaceId },
      select: { id: true },
      orderBy: { id: "asc" },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  COMMENT: (workspaceId, cursor, take) =>
    prisma.comment.findMany({
      // Comments have no workspaceId of their own; scope comes via the issue.
      where: { issue: { workspaceId } },
      select: { id: true },
      orderBy: { id: "asc" },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  DOCUMENT: (workspaceId, cursor, take) =>
    prisma.entityDocument.findMany({
      where: { workspaceId },
      select: { id: true },
      orderBy: { id: "asc" },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  PROJECT: (workspaceId, cursor, take) =>
    prisma.project.findMany({
      where: { workspaceId },
      select: { id: true },
      orderBy: { id: "asc" },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  TEAM: (workspaceId, cursor, take) =>
    prisma.team.findMany({
      where: { workspaceId },
      select: { id: true },
      orderBy: { id: "asc" },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  DEPARTMENT: (workspaceId, cursor, take) =>
    prisma.department.findMany({
      where: { workspaceId },
      select: { id: true },
      orderBy: { id: "asc" },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  MEMBER: async (workspaceId, cursor, take) => {
    // Keyed by userId, since that is what MEMBER embeddings are stored under.
    const rows = await prisma.workspaceMembership.findMany({
      where: { workspaceId },
      select: { userId: true },
      orderBy: { userId: "asc" },
      take,
      ...(cursor ? { cursor: { userId_workspaceId: { userId: cursor, workspaceId } }, skip: 1 } : {}),
    });
    return rows.map((row) => ({ id: row.userId }));
  },

  CYCLE: (workspaceId, cursor, take) =>
    prisma.cycle.findMany({
      where: { workspaceId },
      select: { id: true },
      orderBy: { id: "asc" },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
};

const ALL_ENTITY_TYPES = Object.keys(ENTITY_SOURCES) as IndexableEntityType[];

export async function runEmbeddingBackfill(options: BackfillOptions = {}): Promise<BackfillResult> {
  const startedAt = Date.now();
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, 16));
  const entityTypes = options.entityTypes?.length ? options.entityTypes : ALL_ENTITY_TYPES;

  const workspaces = options.workspaceId
    ? [{ id: options.workspaceId }]
    : await prisma.workspace.findMany({ select: { id: true }, orderBy: { id: "asc" } });

  const totals: BackfillResult = {
    scanned: 0,
    indexed: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    byEntityType: {},
    durationMs: 0,
  };

  for (const workspace of workspaces) {
    for (const entityType of entityTypes) {
      const stats = await backfillEntityType({
        workspaceId: workspace.id,
        entityType,
        concurrency,
        dryRun: options.dryRun === true,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      });

      const bucket = totals.byEntityType[entityType]
        ?? { scanned: 0, indexed: 0, unchanged: 0, skipped: 0, failed: 0 };
      bucket.scanned += stats.scanned;
      bucket.indexed += stats.indexed;
      bucket.unchanged += stats.unchanged;
      bucket.skipped += stats.skipped;
      bucket.failed += stats.failed;
      totals.byEntityType[entityType] = bucket;

      totals.scanned += stats.scanned;
      totals.indexed += stats.indexed;
      totals.unchanged += stats.unchanged;
      totals.skipped += stats.skipped;
      totals.failed += stats.failed;
    }
  }

  totals.durationMs = Date.now() - startedAt;

  logAiInfo("embedding_backfill_completed", {
    feature: "background",
    success: true,
    metadata: {
      workspaces: workspaces.length,
      dryRun: options.dryRun === true,
      ...totals,
    },
  });

  return totals;
}

async function backfillEntityType(input: {
  workspaceId: string;
  entityType: IndexableEntityType;
  concurrency: number;
  dryRun: boolean;
  onProgress?: ((progress: BackfillProgress) => void) | undefined;
}) {
  const source = ENTITY_SOURCES[input.entityType];
  const stats = { scanned: 0, indexed: 0, unchanged: 0, skipped: 0, failed: 0 };

  let cursor: string | null = null;

  for (;;) {
    const rows: Array<{ id: string }> = await source(input.workspaceId, cursor, PAGE_SIZE);
    if (rows.length === 0) break;

    await forEachWithConcurrency(rows, input.concurrency, async (row) => {
      stats.scanned += 1;
      try {
        const built = await buildEmbeddingContent(input.entityType, row.id, input.workspaceId);

        // No content is a legitimate outcome (an empty comment, a deleted row
        // mid-scan) rather than a failure.
        if (!built?.content) {
          stats.skipped += 1;
          return;
        }

        if (input.dryRun) {
          stats.indexed += 1;
          return;
        }

        const stored = await storeEntityEmbedding({
          workspaceId: input.workspaceId,
          entityType: input.entityType,
          entityId: row.id,
          content: built.content,
        });

        // A null model means the content hash matched and the stored vector was
        // left alone — no provider call was made. Counting that as "indexed"
        // would make a no-op re-run look identical to a real one.
        if (stored && stored.model === null) stats.unchanged += 1;
        else stats.indexed += 1;
      } catch (error) {
        // One bad row must not abort the run — log it and keep going, so a
        // single malformed entity cannot block indexing an entire workspace.
        stats.failed += 1;
        logAiWarn("embedding_backfill_row_failed", {
          workspaceId: input.workspaceId,
          feature: "background",
          success: false,
          errorMessage: error instanceof Error ? error.message : "Backfill row failed",
          metadata: { entityType: input.entityType, entityId: row.id },
        });
      }
    });

    input.onProgress?.({
      entityType: input.entityType,
      workspaceId: input.workspaceId,
      ...stats,
    });

    if (rows.length < PAGE_SIZE) break;
    cursor = rows[rows.length - 1]?.id ?? null;
    if (!cursor) break;
  }

  return stats;
}

/**
 * Runs `worker` over `items` with at most `limit` in flight.
 *
 * A plain `Promise.all` over the page would issue 200 simultaneous embedding
 * requests and get rate-limited; awaiting each in turn would make a large
 * backfill take hours. This keeps a fixed number in flight.
 */
async function forEachWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  });

  await Promise.all(runners);
}
