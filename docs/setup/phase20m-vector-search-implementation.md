# Phase 20M — Vector Search Implementation

> Implements the fixes identified in [phase20l-vector-search-audit.md](./phase20l-vector-search-audit.md).
> Status: built, backfilled, and verified against the dev database. Not yet committed.

---

## 1. Result

| | Before | After |
|---|---|---|
| Embedding coverage | 37 / 66 entities | **66 / 66** |
| Entity types indexed | 2 of 8 | **8 of 8** |
| Chat search | substring matching only | exact key + keyword + vector |
| Searchable content | issue titles/descriptions | issues, comments, documents, projects, teams, departments, people, cycles |

Measured on the dev workspace. These queries returned **nothing** before:

| Query | Before | After |
|---|---|---|
| "the notification thing that keeps firing" | 0 | 3 issues |
| "login problems" | 0 | finds *"Sign-in fails with server error"* |
| "auth broken" | 0 | 3 |
| "who works on frontend" | 0 | the actual people |
| `/notificaiton-count` | 1 | 3 (keyword **and** vector both matched) |

Row two is the whole point: *"login problems"* and *"Sign-in fails"* share no substring. Keyword search cannot connect them; embeddings can.

---

## 2. `npm run backfill:embeddings` — what it does

### 2.1 The problem it solves

Indexing now happens automatically whenever an entity is written. But that only covers entities written **after** those hooks existed. Everything created before was still invisible to semantic search — which was most of the workspace.

The backfill walks existing rows and fills that gap. It is the bridge between "indexing works from now on" and "indexing covers everything".

### 2.2 What it actually does

For every workspace, and every entity type:

```
find rows (paginated by id)
  → render embedding content            (ai.embedding-content.ts)
  → hash it
  → hash unchanged?  → skip, no API call, no cost
  → hash changed?    → call embedding API, store vector
```

### 2.3 Usage

```bash
npm run backfill:embeddings -- --dry-run        # report only: no API calls, no writes
npm run backfill:embeddings                     # everything, every workspace
npm run backfill:embeddings -- --workspace <id>
npm run backfill:embeddings -- --types ISSUE,COMMENT
npm run backfill:embeddings -- --concurrency 8  # default 4
```

Output distinguishes real work from no-ops:

```
scanned:   66
embedded:  0    (fresh vectors — billed)
unchanged: 66   (content hash matched — no API call)
skipped:   0    (nothing embeddable)
failed:    0
```

That distinction matters: without it a re-run reports "indexed 66" and looks identical to a first run, so you cannot tell whether anything actually happened.

### 2.4 Properties

- **Idempotent.** Safe to run any number of times. Unchanged content is skipped without an API call — a second run over untouched data costs database reads and nothing else. Verified: first run 17.7s, immediate re-run 0.2s with zero API calls.
- **Resumable.** Cursor-paginated by id, never holding a long transaction. Interrupt it and re-run; it picks up cheaply.
- **Fault-tolerant per row.** One malformed entity is logged and skipped rather than aborting a whole workspace.
- **Bounded concurrency** (default 4). Embeddings are a rate-limited external API shared with live traffic; unbounded parallelism would throttle both.
- **Runs outside the queue.** Deliberately not enqueued: pushing tens of thousands of bulk jobs onto the same queue live indexing uses would bury real-time updates behind the backfill.

### 2.5 When to run it

- **Once after deploying this change** — already done on dev.
- **After changing how embedding content is rendered.** This is the important one. Content shape is part of what a vector means, so changing a builder in `ai.embedding-content.ts` invalidates every stored vector of that type. Old and new vectors are not comparable, and similarity silently degrades rather than erroring. Re-run the backfill for the affected types after any such change.
- **After bulk imports** that bypass the service layer.
- **Never needed for normal operation** — on-write hooks handle that.

---

## 3. Is old data embedded?

**Yes. It has already been run on dev, and coverage is complete.**

```
entityType | embedded | oldest entity indexed
-----------+----------+----------------------
ISSUE      |       35 | 2026-06-23
PROJECT    |        8 | 2026-06-28
MEMBER     |        9 | 2026-08-06
COMMENT    |        5 | 2026-08-06
TEAM       |        5 | 2026-08-06
DOCUMENT   |        2 | 2026-08-06
CYCLE      |        1 | 2026-08-06
DEPARTMENT |        1 | 2026-08-06
```

Every entity in the database now has a vector, including issues and projects created back in June. Nothing is left behind.

**On other environments** (staging, production) the backfill has *not* run. Deploying the code alone gets you indexing for new writes only; existing data stays invisible until the command is run there. It is a deploy step, not an automatic migration — because it makes paid API calls and should be a deliberate action.

---

## 4. What changed in the code

### 4.1 Indexing moved to the domain layer — the root fix

Previously, every `enqueueEmbedding` call except issues lived in the AI tool layer. So:

```
AI creates a project via chat      → embedded
A person creates one via the UI    → not embedded
```

That is why PROJECT was at 2/8: those two came from AI testing.

Indexing is a consequence of data changing, so it now lives where data changes. **16 call sites across 8 services**: project, team, department, cycle, comment, documents, workspace membership, team membership.

`ai.indexer.ts` is the single entry point, with three guarantees to callers:

1. **Never throws.** A search index is derived data; failing someone's issue save because Redis is down trades a real feature for a cosmetic one.
2. **Never blocks.** Work goes to a queue. Calling the embedding API inline would add 100–300 ms to every write and tie write availability to OpenRouter's.
3. **Must be called after commit.** Enqueuing inside a transaction can publish a job for a row that then rolls back.

### 4.2 One source of truth for embedding content

`ai.embedding-content.ts` answers "what text represents this entity" for all eight types. The worker and the backfill both use it.

This was previously inline in the worker, which meant nothing stopped another path from embedding differently-shaped text for the same entity — and vectors built from different shapes are not comparable, so similarity degrades in ways that are very hard to notice.

Content design is deliberate, not a field dump:
- **Comments** carry their issue's title. A bare *"agreed, let's ship it"* is unsearchable alone.
- **Members** carry designation and team names, which is what makes *"who works on frontend"* resolvable without an exact name match.
- **Issues** carry project and labels, so *"the auth bug in Ridely"* matches on both topic and project.

### 4.3 Two entity types that could never be indexed

`COMMENT` and `DOCUMENT` were declared in the enum but had no worker handler and were not in the job payload type — so the schema advertised support that did not exist. Both now work.

Note on documents: `EntityDocument` is a **file reference** (key, fileName, mimeType), not rich text. Only its metadata is embedded. Extracting text from the file bytes needs a per-mime-type parsing pipeline and is separate work.

### 4.4 Worker refactor

`processEmbeddingJob` went from 275 lines of per-entity inline logic to 126 that delegate to the shared builders. Three functions became dead and were removed. **Net −305 lines.**

### 4.5 HNSW index

```sql
-- was: USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
CREATE INDEX "AiEmbedding_embedding_idx"
  ON "AiEmbedding" USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

The old index had two problems: `lists = 100` assumes ~100k rows (guidance is roughly rows/1000), and IVFFlat fits its centroids from sampled data at build time — but it was built by a migration on an empty table, so they were never fit at all.

HNSW needs no training step and holds recall as rows arrive continuously, which matches how embeddings are actually written here (per write, not one bulk load).

### 4.6 Hybrid search

`ai.search.ts` merges three strategies, because each fails where the others work:

| Strategy | Catches | Fails at |
|---|---|---|
| **Exact key** (`TRU-42`) | someone pasting an id | nothing — it short-circuits |
| **Keyword** | error codes, stack traces, `/notification-count` | paraphrase |
| **Vector** | "login broken" → "Auth fails on OAuth callback" | exact literal tokens |

Merged with **Reciprocal Rank Fusion**: `score = Σ 1/(60 + rank)`.

RRF uses each result's *rank within its own strategy* rather than raw scores, because cosine similarity and "matched a keyword" are not on the same scale — any attempt to normalize them into one number bakes in an arbitrary weighting. A result found by both strategies naturally outranks one found by either alone.

### 4.7 AI tools

- **`issues_search`** now routes free-text queries through hybrid search, then re-reads matched issues so filters and permissions still apply. Structured-only queries ("my urgent bugs") keep the plain filter path — that is a filter, not a search. Falls back to substring matching if hybrid finds nothing.
- **`workspace_search`** (new) searches across every indexed type at once.

---

## 5. Safety properties

**Search is never authorization.** The embeddings table stores text and knows nothing about private projects or team membership. Every issue result passes through `filterVisibleIssues` before being returned. Treating a search hit as permission would leak private work.

**Vector failure degrades, it does not break.** If the embedding provider is unavailable, search returns keyword results with `degraded: true`, so the AI can say "keyword results only" instead of presenting thin recall as complete.

**A similarity floor exists.** A vector index always returns *something* — without `MIN_VECTOR_SIMILARITY` the least-dissimilar row in the workspace comes back as a "match".

**Workspace isolation is enforced in every query** and covered by a test that asserts results never cross a workspace boundary.

---

## 6. Cost

Priced against measured content sizes at $0.02/M tokens (`text-embedding-3-small`):

| | Cost |
|---|---|
| The full backfill just run (66 entities) | **$0.0001** |
| 1,000 entity writes/month | $0.002 |
| 10,000 searches/month | $0.002 |
| At 100× current data size | **~$0.07/month** |

Cost is not a constraint here.

---

## 7. Tests

`ai.search.test.ts` — 11 tests, run against the real database rather than mocks, because the behaviour worth protecting (a paraphrase matching text with no shared substring) only exists when there are real embeddings. Mocking pgvector would test the mock.

Covered: exact-key short-circuit, unknown key falling through, paraphrase matching, cross-entity results, type filtering, keyword+vector agreement, rank-fusion ordering, empty-query safety, workspace isolation, keyword-only mode.

Fixtures are resolved at runtime rather than hardcoded, so the suite survives a reseeded database.

**Full suite: 76 passing.**

---

## 8. Known limitations

- **Document file contents are not embedded** — only metadata. Text extraction needs a per-mime-type pipeline.
- **No chunking.** Long documents are truncated at 12,000 characters. Proper chunking needs multiple vectors per entity, which the `@@unique([workspaceId, entityType, entityId])` constraint currently prevents. A schema change, not a tweak.
- **Keyword leg uses `ILIKE`, not Postgres full-text search.** Adequate at current scale; `tsvector` with a GIN index would be better as data grows, and would add stemming.
- **No monitoring on indexing lag.** If the queue stops, search degrades silently — results simply go missing with no error. Worth alerting on before this matters in production.
- **Changing a content builder silently invalidates existing vectors.** There is no stored content-format version to detect drift; remembering to re-run the backfill is currently a human step.
