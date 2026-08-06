# Phase 20N — AI System Status: Embedding/Search + Side Panel

> A snapshot, not a plan. Everything below was verified against the running
> dev database and the current code on `feat/ai-agent-redesign` — grepped,
> queried, or exercised live, not recalled from earlier docs. Where something
> couldn't be verified from this repo (the frontend UI), that's stated
> explicitly rather than assumed.
>
> Nothing in this doc has been committed or pushed.

---

## 1. Embedding & vector search — the strong half

### 1.1 What's good

**Coverage is real and workspace-verified**, all 8 entity types:

```
ISSUE       35        TEAM         5
MEMBER       9        COMMENT      5
PROJECT      8        CYCLE        1
DOCUMENT     2        DEPARTMENT   1
```

**It's genuinely semantic, not a claim — demonstrated live.** In this session, the query `"xusignletwo"` (a garbled typo) found the project **USingle2** with zero shared substring between query and title. Confirmed via the actual tool call the model made:

```
projects_search { query: "xusignletwo" }  →  found directly, one call
projects_get    { projectId: ... }        →  pulled details
```

Compare to before the fix: the same lookup (as "UXingle2") took 4 tool calls — search, search again, dump every active project in the workspace, then have the model eyeball the list to spot the likely match. That was brute force succeeding by luck at small scale, not retrieval.

**Indexing lives in the domain layer, not the AI tool layer.** 16 call sites across 8 services (project, team, department, cycle, comment, documents, workspace membership, team membership). This is the fix for the original root cause: embeddings used to fire only when the *AI* created something, so a project made through the UI was invisible to search. That's why project coverage was 2/8 before this work — those two were AI-created during testing.

**Hybrid search (exact key → keyword → vector, merged with Reciprocal Rank Fusion) now backs six tools**, not just issues:

| Tool | Status |
|---|---|
| `issues_search` | hybrid |
| `projects_search` | hybrid |
| `teams_search` | hybrid |
| `departments_search` | hybrid |
| `cycles_search` | hybrid |
| `workspace_search` (cross-entity) | hybrid |

All six verified against the live DB this session — not just unit-tested, actually queried with real free-text and confirmed to return the right entity.

**A real permission leak was found and closed in the process.** `workspace_search` previously filtered only issue results for visibility; comments, documents, projects, teams and cycles were returned with no visibility check at all, because the filter function only ever knew about issues. It's now `filterVisibleHits`, which applies the correct rule per entity type:

| Type | Rule |
|---|---|
| ISSUE | its project is public, led by, or joined by the user |
| COMMENT, DOCUMENT | inherits its parent issue's / project's visibility |
| PROJECT | public, led by, or joined by the user |
| TEAM, DEPARTMENT, CYCLE | GUEST sees public only; everyone else sees all |
| MEMBER | workspace-scoped — anyone in the workspace may see |

Fail-closed: a hit whose parent can't be resolved is dropped, not kept. Verified directly — a synthetic private-team hit was correctly dropped for a GUEST viewer and correctly kept for a MEMBER viewer.

**Infrastructure is production-shaped:** HNSW index (not the untrained IVFFlat it replaced), content-hash dedup so unchanged text costs no API call, idempotent and resumable backfill, cost is a rounding error (~$0.0001 for the full backfill, ~$0.07/month projected at 100x current data).

### 1.2 Gaps — stated plainly

- **Document *contents* are not embedded, only metadata** (filename, mime type, key). A PDF or Word doc's actual text is invisible to search until a per-mime-type extraction pipeline exists. This is the single biggest content gap.
- **No chunking.** Long content truncates at 12,000 characters. The schema's `@@unique([workspaceId, entityType, entityId])` constraint currently allows only one vector per entity, so proper chunking is a schema change, not a tuning change.
- **No monitoring on indexing lag.** If the embedding queue stalls, search coverage silently degrades — no error surfaces, results just quietly stop appearing. Nothing alerts on this today.
- **No content-version stamp.** If `ai.embedding-content.ts` changes shape and the backfill isn't re-run for the affected types, old and new vectors silently disagree — similarity degrades without any warning. Remembering to backfill is currently a human step, not an enforced one.
- **Keyword leg uses `ILIKE`**, not Postgres full-text search (`tsvector`/GIN). Fine at current scale; will want upgrading as data grows, for stemming and ranking quality.
- **Staging and production have not run the backfill.** Only dev has full 8/8 coverage today. This is deliberate — the backfill makes paid API calls, so it's a manual deploy step, not something that runs automatically on migrate.

---

## 2. AI side panel — solid core, real cleanup debt

### 2.1 What's good

**The agent loop does real tool-calling, not keyword or intent matching.** Confirmed live, not asserted: given "tell me about the project xusignletwo," the model chose `projects_search` then `projects_get` on its own — no hardcoded phrase routing involved.

**`/chat` is wired to the new agent runtime, verified by reading the controller directly** (`modules/ai/ai.controller.ts:113`), not by trusting prior notes:

```ts
for await (const event of aiConversation.processConversationTurn({
  conversationId, message, userId, workspaceId, userRole,
  signal: abortController.signal,
})) { ... }
```

Streams via SSE. Stop/interrupt is real infrastructure: the request gets an `AbortController`, the client closing the connection (e.g. pressing Escape) triggers `req.on("close")`, which aborts the signal and propagates into the in-flight model call — the turn actually stops running (and stops costing money) rather than finishing in the background.

**Tool registry consolidation cut real token cost.** 100 legacy tools → 48 consolidated ones, then scoped per-turn rather than sent in full every time. Measured impact: 57–73% token reduction, cache hit rates now visible per turn in logs (0.33–0.76 observed recently), without any documented drop in answer quality.

**Accept/reject is real backend infrastructure**, not just a UI mockup: every mutation is recorded with before/after state, and `POST /ai/mutations/:id/accept` and `POST /ai/mutations/:id/revert` both exist and are routed (`modules/ai/ai.routes.ts:145,153`).

**Search feeding the panel now uses hybrid search**, not `contains`-only matching — this was the single biggest cause of the old "dump the whole list and eyeball it" behavior described in section 1.

### 2.2 Gaps — the longer, honest list

**~3,500 lines of dead code are still in the repository**: `ai.chat.ts`, `ai.intent.ts`, `ai.action-state.ts`, `ai.planner.ts`. Verified this session that they are off the live `/chat` path — only three harmless conversation-CRUD helpers (`listConversations`, `getConversationMessages`, `deleteConversation`) are still imported from `ai.chat.ts`; everything else is unreferenced. But the files are still there, still ship in the build, and `ai.action-state.test.ts` still has 2 failing tests against logic nothing calls anymore. This was flagged as pending work before this session and remains pending — deleting it is a mechanical cleanup, not a design question.

**Several tool-layer correctness issues from the earlier full-registry audit are still open**, confirmed present by direct grep this session, not assumed from memory:

| Issue | Where | Why it matters |
|---|---|---|
| Raw-Prisma bypasses | `update_issue`, `assign_issue`, `add_comment`, `add_label_to_issue`, `update_project` | Skip the domain service layer, so they can silently drift from validation, notifications, or audit logic that lives in the service |
| Hardcoded `"done"` status string | `tool-executor.ts:943, 2265, 3810, 3881` | Breaks for any workspace using custom workflow statuses instead of the default set |
| `update_issue_integration_ref` data loss | `tool-executor.ts:1448` | Confirmed present, not yet re-audited for severity this session |
| `update_workspace_statuses` fragile arg shape | `tool-executor.ts:1888` | Takes a JSON *string* the model must serialize correctly rather than a structured payload — an unnecessary way for a tool call to fail |
| Pagination `hasMore` correctness | registry-wide | Flagged in the original audit, not yet re-verified |
| `activate_template` swap-confirmation | registry | Flagged in the original audit, not yet re-verified |

None of these are exotic — they're the kind of finding a focused pass clears in an afternoon. They remain open because this session's priority was the redesign and the vector/search work, not closing every item from the earlier audit.

**The frontend UI could not be verified from this session.** `project_management_node` is a backend-only repository — there isn't a single `.tsx` file in it. The accept/reject change cards and the ESC-to-interrupt UX described in earlier notes live in a separate frontend repository this session had no access to, and a commit hash referenced in prior notes doesn't resolve against this repo's git history. What's confirmed: the backend infrastructure those features depend on (mutation accept/revert endpoints, abort-on-disconnect) is real and wired. What's **not** confirmed from here: what the rendered UI actually looks like, or how polished the interaction is.

---

## 3. Bottom line

**Embedding and search: good enough to trust now.** The architecture is sound and verified working end-to-end today. What's left is depth, not correctness — document text extraction, chunking, and lag monitoring are missing, but nothing in the current design will hand back a wrong answer, only occasionally miss content it hasn't ingested yet.

**Side panel: the hard problem is solved.** Real tool-calling replaced keyword/intent matching, and that's demonstrated working live, not just claimed. What's left is cleanup debt: ~3,500 lines of dead code not yet deleted, and roughly six tool-layer bugs from the earlier audit that are known, located, and still open.
