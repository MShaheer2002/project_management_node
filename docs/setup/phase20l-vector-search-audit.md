# Phase 20L — Vector / Embedding Integration Audit

> **Status: resolved.** Every finding below has been implemented — see
> [current-embedding-state.md](./current-embedding-state.md) for what's actually in
> the database today. Kept as the record of what was wrong and why, since the
> reasoning still explains the design.
>
> Verified against the running dev database and the current code, not inferred from docs.
> Conclusion up front: the embedding *infrastructure* is sound. Its *integration* is not — embeddings are generated from the AI tool path rather than from the domain services, so most of the workspace was never embedded, and the chat panel's search never touches the vector index at all.

---

## 1. What is actually in the database

```
entityType | embedded | total entities | coverage
-----------+----------+----------------+---------
ISSUE      |       35 |             35 | 100%
PROJECT    |        2 |              8 |  25%
COMMENT    |        0 |              5 |   0%
TEAM       |        0 |              5 |   0%
DEPARTMENT |        0 |              1 |   0%
CYCLE      |        0 |              1 |   0%
MEMBER     |        0 |              9 |   0%
DOCUMENT   |        0 |              2 |   0%
```

**37 embeddings for 66 embeddable entities.** One entity type works. The rest are effectively absent.

Vector storage itself is healthy: every row is `text-embedding-3-small` at 1536 dimensions, no mixed models, no dimension mismatches. The `contentHash` short-circuit correctly skips regeneration when title/description haven't changed.

---

## 2. Root cause: embeddings are generated from the wrong layer

Only **one** domain service triggers embedding:

| Service | Triggers embedding? |
|---|---|
| `issue.service.ts` | Yes — `triggerIssueBackgroundJobs` on create and update |
| `project.service.ts` | No |
| `team.service.ts` | No |
| `department.service.ts` | No |
| `cycle.service.ts` | No |
| `comment.service.ts` | No |

Every other `enqueueEmbedding` call site lives in **`tools/tool-executor.ts`** — the AI tool layer.

The consequence:

```
AI creates a project via chat        → embedded
A person creates a project via UI    → not embedded
```

That is exactly why PROJECT sits at 2/8: those two were created by the AI during testing. The other six were made through the app and are invisible to semantic search.

**This is an architectural placement error, not a missing feature.** Embedding is a property of the data changing, so it belongs where the data changes — the domain service — not in one of several callers that happen to change it.

---

## 3. Two entity types can never be embedded

`AiEmbeddingEntityType` declares eight types. `processEmbeddingJob` handles five explicitly (`PROJECT`, `TEAM`, `DEPARTMENT`, `MEMBER`, `CYCLE`) plus `ISSUE`.

**`COMMENT` and `DOCUMENT` have no handler.** Enqueuing one would do nothing. Comments are where most of the actual discussion and diagnosis lives, and documents are the workspace's written knowledge — between them, the richest text in the product is unreachable.

---

## 4. Chat search does not use vectors at all

This is the one that matters most day to day.

| Path | Implementation |
|---|---|
| `issues_search` (registry) | → `list_issues` |
| `list_issues` | `prisma.issue.findMany` with `contains` |
| `search_issues` | `contains` on title / description / id |
| `findSimilarIssuesByText` | **Jaccard token overlap in JavaScript** over up to 75 loaded rows |
| `findSimilarIssueEmbeddings` | Real pgvector query — but only called by duplicate detection |

So the vector index is used by background duplicate detection and nothing else. The AI's primary search is substring matching.

Practical effect: searching *"login broken"* cannot find an issue titled *"Auth fails on OAuth callback"* — no shared substring. That is precisely the case embeddings exist to solve.

Note also that `findSimilarIssuesByText` is **misleadingly named** — nothing about it is vector-based. It loads 75 rows and compares token sets. Worth renaming; right now it reads like semantic search at every call site.

---

## 5. The index is mistuned for the data

```sql
CREATE INDEX "AiEmbedding_embedding_idx"
  ON "AiEmbedding" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
```

Two problems:

1. **`lists = 100` on 37 rows.** IVFFlat partitions vectors into `lists` clusters; the usual guidance is roughly `rows / 1000`. With 37 rows spread over 100 partitions, most are empty and recall degrades badly — the planner may skip the index entirely.
2. **IVFFlat requires training data at build time.** This index was created by a migration on an empty table, so its cluster centroids were never fit to real data. It needs rebuilding after the backfill regardless.

**HNSW is the better default now** — no training step, better recall, and it handles incremental inserts gracefully, which matters because embeddings arrive continuously rather than in one bulk load.

---

## 6. What a production-grade design looks like

### 6.1 Move generation to the domain layer

A single shared hook invoked after commit by each domain service:

```
issue.service      ─┐
project.service    ─┤
team.service       ─┼─→ enqueueEmbedding(entityType, entityId)  ─→ BullMQ ─→ worker
comment.service    ─┤
document.service   ─┘
```

Requirements that are already met and should be preserved: enqueue *after* the transaction commits, never fail the user's write if the queue is down, and keep the `contentHash` skip so unchanged text costs nothing.

### 6.2 Backfill

A one-off job walking every workspace and embedding what is missing. Without it, everything created before this change stays invisible — which today is most of the workspace.

### 6.3 Add the missing handlers

`COMMENT` and `DOCUMENT`, with sensible content construction (comment body plus its issue's title for context; document title plus body, chunked if long).

### 6.4 Hybrid search, not vector-only

Vector search is the wrong tool for exact identifiers. `TRU-42` should be an exact lookup; *"the login thing that keeps failing"* should be semantic. The right shape:

```
query
  ├─ looks like an issue key (TRU-42)? → direct lookup, return immediately
  ├─ keyword match  (Postgres full-text / trigram)  ─┐
  └─ vector match   (pgvector)                      ─┴─→ merge + rank → results
```

Merging both beats either alone: keyword catches exact error strings and stack traces that embeddings blur, vector catches paraphrase that keywords miss.

### 6.5 Expose it to the model

`issues_search` should use the hybrid path. Cross-entity search (`search_workspace`) becomes possible once other entity types are actually embedded — "find everything about authentication" spanning issues, comments and docs.

---

## 7. In plain words: what changes, what you gain, what it costs

### 7.1 What actually changes

**Today**, when the AI searches, it looks for issues whose text literally contains the words you typed. Nothing more.

**After**, it also finds things that *mean* the same thing, even with no words in common — and it can search comments, documents, projects and teams, not just issues.

Three concrete examples from your own workspace:

| You ask | Today | After |
|---|---|---|
| "the notification thing that keeps firing" | Nothing — TRU-1 says "polling", not "firing" | Finds TRU-1 |
| "anything about login problems" | Only issues with the literal word "login" | Also finds OAuth, auth, sign-in issues |
| "where did we discuss the settings move" | Nothing — comments and docs aren't searchable at all | Finds the comment thread and the doc |

The second column is not a hypothetical weakness. It is what your AI does right now.

### 7.2 What you gain

- **Questions phrased in your own words work.** You stop having to guess the exact wording someone used when they wrote the issue.
- **Search covers the whole workspace, not one table.** Comments and documents hold most of the actual reasoning in a project; today none of it is findable.
- **Duplicate detection gets sharper.** It currently compares word overlap, so it catches obvious repeats and misses reworded ones — the same bug described two different ways reads as two different bugs.
- **The AI needs fewer attempts.** When the first search returns the right thing, the model answers immediately instead of trying three phrasings. Each avoided attempt is a real model call, so this shows up as a faster, cheaper answer.

### 7.3 What it costs

**Money: almost nothing.** Measured against your actual data at $0.02 per million tokens:

| | Cost |
|---|---|
| Embedding your entire workspace as it stands today | **$0.0001**, once |
| 1,000 issue writes in a month | $0.002 |
| 10,000 searches in a month | $0.002 |
| At 100× your current size | **~$0.07/month** |

Backfilling everything costs a hundredth of a cent. Cost is not a reason to hesitate here.

**Time: this is the real price.** The work is moving embedding generation into every domain service, writing a backfill job, adding two missing handlers, rebuilding the index, and building hybrid search. That is engineering days, not hours.

**Complexity: a second thing that can be wrong.** Right now search either matches or it doesn't, and you can reason about why. Semantic search returns things that are *nearly* right, and tuning what counts as "near enough" is ongoing judgment, not a setting you get correct once.

### 7.4 The tradeoffs worth knowing before agreeing

- **It is not faster.** Semantic search adds a network call (~100–300 ms) to generate the query vector, on top of the database lookup. Substring search is 10–40 ms with no network call. Per query, this is a step backwards on latency.
- **But search latency is not where your time goes.** Measured on this workspace: database work is 2–58 ms, while each model call is 3,000–9,000 ms and full turns run 6.5–12.8 s. Search is under 1% of a turn. The speed benefit is indirect — fewer model retries, which saves seconds.
- **New failure mode: confidently wrong matches.** Keyword search fails visibly (no results). Semantic search fails quietly by returning something plausible but unrelated. Hybrid search and a similarity threshold mitigate this; they do not eliminate it.
- **Embeddings go stale if generation breaks.** If the queue stops, search silently degrades rather than erroring — data is simply missing from results with no obvious symptom. This needs monitoring, which does not exist today.
- **Switching embedding model later means re-embedding everything.** Vectors from different models are not comparable. It is cheap at your scale, but it is a migration, not a config change.

### 7.5 The honest summary

This is an **accuracy** improvement, not a speed or cost one. It makes the AI find things it currently cannot find, across data it currently cannot see. The money cost is negligible and the latency cost is real but irrelevant next to model call time.

The genuine cost is engineering time and one more subsystem whose failure is quiet rather than loud.

---

## 8. Recommended order

1. **Move embedding generation into the domain services** — without this, everything else compounds on incomplete data.
2. **Backfill existing entities.**
3. **Rebuild the index as HNSW** after the backfill, when there is real data to index.
4. **Add `COMMENT` / `DOCUMENT` handlers** — the richest text in the product.
5. **Build hybrid search** and route `issues_search` through it.
6. **Add cross-entity search** once coverage is real.
7. **Rename `findSimilarIssuesByText`** to reflect that it is lexical, not semantic.

Steps 1–2 are the ones that unlock everything else; 5–6 are what the user actually experiences.
