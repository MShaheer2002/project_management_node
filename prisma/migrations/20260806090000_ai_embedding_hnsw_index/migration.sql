-- Replace the IVFFlat vector index with HNSW.
--
-- The original index was created as:
--   USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100)
--
-- Two problems with that here:
--
--   1. IVFFlat partitions vectors into `lists` clusters and picks centroids by
--      sampling existing rows at build time. This index was built by a migration
--      on an empty table, so its centroids were never fit to real data. Recall
--      degrades badly and rebuilding is required regardless.
--
--   2. `lists = 100` assumes roughly 100k rows (guidance is about rows/1000).
--      At realistic workspace sizes most partitions sit empty, and the planner
--      may skip the index entirely.
--
-- HNSW suits this workload better: it needs no training step, keeps good recall
-- as rows are inserted continuously (embeddings arrive per write, not in one
-- bulk load), and is not sensitive to a row-count-derived parameter that goes
-- stale as the workspace grows.
--
-- Parameters are pgvector defaults: m = 16 (edges per node), ef_construction = 64
-- (candidate list size while building). They trade a little build time for
-- recall and are the recommended starting point.

DROP INDEX IF EXISTS "AiEmbedding_embedding_idx";

CREATE INDEX "AiEmbedding_embedding_idx"
  ON "AiEmbedding"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- No additional btree index is added here: the schema's @@index([workspaceId,
-- entityType]) already covers the pre-filter every search applies, and a second
-- identical index would only cost write throughput.
