/**
 * Search indexing hook — Phase 20L
 *
 * The entry point domain services call after changing something that should be
 * findable by meaning.
 *
 * Why this module exists: embedding generation previously lived in the AI tool
 * layer, so an entity was only indexed when the *AI* created it. A project made
 * through the normal UI was never embedded and stayed invisible to semantic
 * search. Indexing is a consequence of data changing, so it belongs where data
 * changes — the domain service — not in one of several callers that happen to
 * change it.
 *
 * Three contracts this module guarantees to its callers:
 *
 *   1. **It never throws.** A search index is derived data. Failing a user's
 *      issue save because Redis is down would trade a real feature for a
 *      cosmetic one.
 *   2. **It never blocks.** Work is handed to a queue; the embedding API call
 *      happens on the worker. Calling the provider inline would add ~100-300ms
 *      of network to every write and couple write availability to OpenRouter's.
 *   3. **It must be called after commit.** Enqueuing inside a transaction can
 *      publish a job for a row that then rolls back, leaving the worker to look
 *      for something that never existed. Callers are responsible for placement.
 *
 * Kept deliberately dependency-light so domain services can import it without
 * pulling in the wider AI stack.
 */

import { enqueueEmbedding } from "./ai.jobs.js";
import { logAiWarn } from "./ai.observability.js";
import { isIndexableEntityType, type IndexableEntityType } from "./ai.embedding-content.js";

export type { IndexableEntityType } from "./ai.embedding-content.js";

export type IndexReason = "created" | "updated" | "manual" | "backfill";

export interface IndexEntityInput {
  workspaceId: string;
  entityType: IndexableEntityType;
  entityId: string;
  reason?: IndexReason | undefined;
  triggeredByUserId?: string | undefined;
}

/**
 * Queues an entity for (re)indexing.
 *
 * Safe to call on every write. The worker hashes the rendered content and skips
 * the embedding API call when nothing meaningful changed, so a status-only edit
 * costs a queue round-trip and no money.
 *
 * Intentionally returns void rather than the job: callers should not be able to
 * accidentally await indexing as if it were part of their write.
 */
export async function indexEntity(input: IndexEntityInput): Promise<void> {
  if (!input.workspaceId || !input.entityId) return;
  if (!isIndexableEntityType(input.entityType)) return;

  try {
    await enqueueEmbedding({
      workspaceId: input.workspaceId,
      entityType: input.entityType,
      entityId: input.entityId,
      reason: normalizeReason(input.reason),
      ...(input.triggeredByUserId ? { triggeredByUserId: input.triggeredByUserId } : {}),
    });
  } catch (error) {
    // enqueueEmbedding already swallows queue failures; this guards against
    // anything unexpected so a caller's write can never fail because of us.
    logAiWarn("index_entity_failed", {
      workspaceId: input.workspaceId,
      feature: "background",
      success: false,
      errorMessage: error instanceof Error ? error.message : "Failed to queue indexing",
      metadata: { entityType: input.entityType, entityId: input.entityId },
    });
  }
}

/**
 * Fire-and-forget form for call sites already inside a response path, where
 * even the queue round-trip is not worth awaiting.
 *
 * Prefer `await indexEntity(...)` where the caller can afford it: awaiting keeps
 * ordering deterministic in tests and surfaces problems in the same tick.
 */
export function indexEntityInBackground(input: IndexEntityInput): void {
  void indexEntity(input);
}

/**
 * Queues several entities of the same type.
 *
 * Used when one change invalidates many descriptions at once — renaming a team,
 * for instance, changes the text of every issue that names it.
 */
export async function indexEntities(
  inputs: ReadonlyArray<IndexEntityInput>,
): Promise<void> {
  await Promise.all(inputs.map((input) => indexEntity(input)));
}

function normalizeReason(reason: IndexReason | undefined): "created" | "updated" | "manual" {
  // The queue payload predates the backfill path and only knows three reasons.
  // Backfill is reported as "manual" rather than widening the job contract for
  // a value nothing branches on.
  if (reason === "created" || reason === "updated") return reason;
  return "manual";
}
