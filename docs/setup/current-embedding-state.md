# Current Embedding State (Snapshot)

> **This is a snapshot, not a design doc.** Every number below was queried
> directly from the running dev database and cross-checked against the
> Prisma schema at the time this was written — nothing here is inferred or
> copied from earlier docs.
>
> **Snapshot taken:** 2026-08-07, against database `project_management_dev`.
>
> This doc goes stale the moment new data is written or `ai.embedding-content.ts`
> changes. Treat it as "what was true on the day this was generated," not a
> live dashboard. Re-run the queries in §5 to refresh it.

---

## 1. Coverage, right now — every embeddable type

| Entity type | Prisma model (source of truth) | Total rows | Embedded | Coverage |
|---|---|---:|---:|---:|
| ISSUE | `Issue` | 35 | 35 | **100%** |
| COMMENT | `Comment` | 5 | 5 | **100%** |
| DOCUMENT | `EntityDocument` | 2 | 2 | **100%** |
| PROJECT | `Project` | 8 | 8 | **100%** |
| TEAM | `Team` | 5 | 5 | **100%** |
| DEPARTMENT | `Department` | 1 | 1 | **100%** |
| MEMBER | `WorkspaceMembership` (keyed by `userId`) | 9 | 9 | **100%** |
| CYCLE | `Cycle` | 1 | 1 | **100%** |

**Everything the system currently knows how to embed is embedded.** No gaps within the 8 supported types, in either workspace that exists in this database. This is the result of the backfill run earlier this session — before that, real coverage was 37/66 (see `phase20l-vector-search-audit.md` for the before-state).

This snapshot is only meaningful for this database. As of this writing, **`development` is the only environment that exists for this project** — there's no Dockerfile, no CI/CD config, no second `.env` for staging or production. So "coverage is 100%" is a statement about dev data only; it says nothing about anywhere else, because nowhere else exists yet.

---

## 2. Per-workspace breakdown, with timestamps

Two workspaces exist in this database: **TRU** (Trussen-Dev) and **FIS** (Fission Tech).

| Type | Workspace | Embedded | First embedded | Last embedded | Last content update |
|---|---|---:|---|---|---|
| ISSUE | FIS | 21 | 2026-06-23 23:31 | 2026-07-24 00:08 | 2026-08-06 02:15 |
| ISSUE | TRU | 14 | 2026-07-14 22:42 | 2026-07-22 21:49 | 2026-08-06 02:15 |
| COMMENT | TRU | 5 | 2026-08-06 02:15 | 2026-08-06 02:15 | 2026-08-06 02:15 |
| COMMENT | FIS | 0 | — | — | — (FIS has zero comments in the data) |
| DOCUMENT | FIS | 1 | 2026-08-06 02:15 | 2026-08-06 02:15 | 2026-08-06 02:15 |
| DOCUMENT | TRU | 1 | 2026-08-06 02:15 | 2026-08-06 02:15 | 2026-08-06 02:15 |
| PROJECT | FIS | 6 | 2026-06-28 13:12 | 2026-08-06 02:15 | 2026-08-06 02:15 |
| PROJECT | TRU | 2 | 2026-08-06 02:15 | 2026-08-06 02:15 | 2026-08-06 02:15 |
| TEAM | FIS | 3 | 2026-08-06 02:15 | 2026-08-06 02:15 | 2026-08-06 02:15 |
| TEAM | TRU | 2 | 2026-08-06 02:15 | 2026-08-06 02:15 | 2026-08-06 02:15 |
| DEPARTMENT | FIS | 1 | 2026-08-06 02:15 | 2026-08-06 02:15 | 2026-08-06 02:15 |
| DEPARTMENT | TRU | 0 | — | — | — (TRU has zero departments in the data) |
| MEMBER | FIS | 5 | 2026-08-06 02:15 | 2026-08-06 02:15 | 2026-08-06 02:15 |
| MEMBER | TRU | 4 | 2026-08-06 02:15 | 2026-08-06 02:15 | 2026-08-06 02:15 |
| CYCLE | TRU | 1 | 2026-08-06 02:15 | 2026-08-06 02:15 | 2026-08-06 02:15 |
| CYCLE | FIS | 0 | — | — | — (FIS has zero cycles in the data) |

**Reading the timestamps:** the ISSUE rows are the only ones with a "first embedded" date earlier than 2026-08-06 — those were embedded as data was created, over time, by the automatic on-write hook (issues were the one type that had this hook from the start). Every other type shows the exact same timestamp, `2026-08-06 02:15`, across the board — that's the backfill run, catching up everything that had no on-write hook until this session's work landed. That single timestamp cluster **is** the backfill; it is not a coincidence.

Rows showing "—" aren't gaps — they're types with zero rows to begin with in that workspace (e.g. FIS genuinely has no comments; TRU genuinely has no departments).

---

## 3. What text actually gets embedded, per type

This is what's stored in `AiEmbedding.content` — the exact composition, from `ai.embedding-content.ts`, as of this snapshot:

| Type | Composed from |
|---|---|
| **ISSUE** | `{type} {id}: {title}` + description + `Project: {name}` + `Labels: {…}` |
| **COMMENT** | `Comment on {issueId}: {issueTitle}` + `By {authorName}` + comment body |
| **DOCUMENT** | `Document: {name}` + description + `File: {fileName}` (if different) + `Project: {name}` + `Team: {name}` — **metadata only, not file contents** |
| **PROJECT** | `Project: {name}` + description + `Owned by team {name}` + `Status: {status}` |
| **TEAM** | `Team: {name}` + description + `Led by {name}` + `Department: {name}` |
| **DEPARTMENT** | `Department: {name}` + description + `Headed by {name}` + `Teams: {…}` |
| **MEMBER** | `Person: {name}` + designation + `Role: {role}` + `Teams: {…}` + `Departments: {…}` |
| **CYCLE** | `Cycle: {name}` + `Goal: {goal}` + description + `Team: {name}` |

Design note worth keeping in mind: a comment's own text carries the issue title, and a member's own text carries their teams and designation. That's deliberate — a bare "agreed, let's ship it" or a name with nothing else attached is not searchable on its own. Change this composition and the stored vectors for that type stop matching what the code now claims they represent, until backfill runs again for that type (see §6).

---

## 4. Technical health check

| Check | Result |
|---|---|
| Embedding model | `text-embedding-3-small`, uniformly — no mixed models |
| Vector dimensions | 1536, uniformly — no mismatches |
| Rows with a NULL embedding or empty content | **0** |
| Vector index | `hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)` — live, 536 kB |

Everything currently stored is internally consistent. There is no drift *within* the current data — the risk described in §6 is about **future** code changes, not the state today.

---

## 5. What's NOT embedded — and the two different reasons why

There are two separate reasons something might not show up in search, and they matter differently:

### 5a. Within the 8 supported types: nothing missing

Confirmed by §1 — every row of every supported type has a vector. There is no backlog right now.

### 5b. Outside the 8 supported types: real content the system has never indexed

The Prisma schema has other models carrying genuine searchable text that were never part of the embeddable set at all — not a coverage gap, a **scope** gap:

| Model | Rows in DB | What it holds | Worth embedding? |
|---|---:|---|---|
| `IssueSubtask` | **92** | subtask `title` text | Likely yes — 92 rows is real content, and subtasks often contain the specific detail a broader issue description doesn't |
| `Template` | 1 | `name` + `description` of issue templates | Possibly — "which template should I use for a bug report" is a plausible query |
| `ProjectMilestone` | 0 | `name` + `description` | No urgency — no data yet |
| `ProjectDependency` | 0 | free-text `note` | No urgency — no data yet |

`IssueSubtask` is the one worth flagging: 92 rows of real, specific text that a search like "find the subtask about the login redirect" simply cannot reach today, because the entity type doesn't exist in `INDEXABLE_ENTITY_TYPES` at all. This is a scope decision, not a bug — but it's the largest actual body of un-indexed text in the database right now.

Also still true from the implementation doc, restated here for completeness: **document *file contents*** (the bytes behind `EntityDocument`) are not embedded — only the metadata row shown in §3. That gap is about depth within an existing type, not a missing type.

---

## 6. The one thing that can make this doc wrong later

Nothing in this snapshot is at risk from normal use — new issues, new comments, edited projects all get embedded automatically as they happen. The only way coverage silently drops below 100% again is:

1. Someone edits `ai.embedding-content.ts` (changes what text a type is built from), **and**
2. Nobody runs `npm run backfill:embeddings -- --types <TYPE>` for the affected type afterward.

When that happens, nothing errors. The row count stays the same, coverage still reads "100%" by the count in §1 — but the *content* no longer matches what the code claims it represents. This doc's numbers would look identical to today's even though the underlying text had gone stale. There is currently no automated way to detect that from the outside; it would need a fresh content-comparison query like the ones used to build this doc, or a stored content-format version (not built yet).
