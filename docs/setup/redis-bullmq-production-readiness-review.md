# Redis & BullMQ Worker System — Production Readiness Review

> Every finding below was verified directly — against the running code, the
> live Redis instance, and actual job records pulled from Redis — not
> inferred or assumed. Where a claim couldn't be verified, that's stated
> explicitly rather than guessed.
>
> **Reviewed:** 2026-08-07, against `feat/ai-agent-redesign`, dev environment.
> **Bottom line up front:** the queue *architecture* is sound and will scale
> from 1 to 50 worker replicas without code changes. But there is one active,
> severe bug running right now — not hypothetical — that must be fixed before
> trusting anything the worker process does. See §1.

---

## 1. Critical — active right now, not hypothetical

### 1.1 `npm run worker` is running code from three weeks before this session's work

```
dist/workers/ai-background.worker.js   last built: Jul 17
modules/ai/ai.background.ts            last edited: Aug 6
```

Confirmed by direct inspection, not just timestamps: `dist/modules/ai/ai.background.js` contains **zero** references to `COMMENT`, `DOCUMENT`, `buildEmbeddingContent`, or `storeEntityEmbedding`. The compiled worker doesn't have this session's embedding work in it at all. Worse — `ai.indexer.js`, `ai.embedding-content.js`, and `ai.search.js` (three files this session created) **don't exist anywhere in `dist/`**, because `npm run build` has never been run since they were written.

**What this means concretely:** the API server (`npm run dev`, runs via `tsx` against live source) has been enqueueing jobs shaped by the *new* code all session. The worker process consuming those jobs (`npm run worker`, runs compiled `dist/`) has been processing them with the *old* code — pre-domain-layer-indexing, pre-COMMENT/DOCUMENT-support, pre-shared-content-builder. Every embedding coverage number verified this session (100% across 8 types) came from either the live API-server-triggered path (fresh code, via `tsx`) or the `backfill:embeddings` script (also `tsx`, bypasses the worker entirely) — **never from the actual `npm run worker` process running compiled code.** The real end-to-end path — UI write → domain service → queue → `npm run worker` → embedding stored — has not actually been exercised with current code this whole session.

**Fix:** `npm run build` before `npm run worker`, always. There is currently no `prebuild`/`prestart` hook enforcing this — confirmed by reading `package.json` directly, no such hook exists. This needs either a hook, or a documented, enforced deploy step. This is the single highest-priority item in this whole report.

### 1.2 Two Redis instances currently both bound to port 6379

Covered in the prior turn, restated for completeness of this report: a Homebrew-managed instance (PID 503, running since login) and a manually-started one (PID 15027) are both listening on `:6379` right now. Only 503 has active connections. Kill 15027 (`kill 15027`) — two servers claiming the same port is exactly the setup that causes a connection to silently land on the wrong instance later.

---

## 2. What's actually implemented — the baseline

Six BullMQ queues, one worker process (`ai-background.worker.ts`), one separate cron process (`ai-background.scheduler.ts`):

| Queue | Concurrency | Trigger | Calls an LLM? |
|---|---:|---|---|
| `ai.embeddings` | 2 | every write to 8 entity types | embedding API only |
| `ai.issue-intelligence` | 2 | every issue create/update | no — rules/heuristics |
| `ai.proactive-summary` | 2 | every issue write (×2: project+team scope), every cycle write | no — SQL/rules |
| `ai.sprint-planning` | 2 | every cycle create/update | not verified this pass |
| `ai.stale-scan` | 2 | daily cron 08:00 UTC (currently **disabled**: `AI_BACKGROUND_SCHEDULER_ENABLED=false`) | no |
| `ai.weekly-digest` | 2 | weekly cron, Monday 09:00 UTC (currently **disabled**) | no |

Job defaults (`infra/queue/queues.ts`): 3 retry attempts, exponential backoff from 5s, completed jobs kept 1 day/1000 count, failed jobs kept 7 days/5000 count. All standard BullMQ defaults otherwise — no custom `lockDuration` or `stalledInterval` set anywhere, so BullMQ's defaults apply (30s lock, 30s stalled check, 1 stalled retry).

Redis connection model: the API server side is a genuine singleton (`getSharedQueueConnection()` — one connection, module-level, reused for all 6 queues). The **worker** side is not: `createWorkerQueueConnection()` opens a brand-new `ioredis` connection every time it's called, and it's called once per queue inside `createAiWorker()` — **6 separate Redis connections per worker process.**

---

## 3. What's genuinely good, verified

- **Horizontal scaling of the worker process is architecturally correct today, no changes needed.** BullMQ workers claim jobs from Redis atomically; running 50 copies of `npm run worker` would just mean 50 processes cooperatively draining the same 6 queues, exactly as BullMQ is designed for. I didn't just assume this — I checked the one place a race could plausibly cause a duplicate: suggestion writes. `upsertSuggestion` does a real Postgres `upsert` on a unique `(workspaceId, dedupeKey)` constraint — two workers processing the same target concurrently cannot produce a duplicate row; the database enforces it, not application logic.
- **Embedding idempotency holds under retries and duplicates**, verified this session directly: content-hash means a re-processed or duplicate job for unchanged content costs zero API calls and writes nothing new.
- **Graceful shutdown is implemented correctly**: SIGTERM/SIGINT closes each of the 6 workers (which lets BullMQ finish in-flight jobs before exiting), then closes queues, then closes the Redis connection. No abrupt `process.exit()` cutting off active work.
- **The scheduler is already architecturally separate from the worker process** (`ai-background.scheduler.ts` vs `ai-background.worker.ts`, two different npm scripts). This is the *correct* design — scaling worker replicas does not, by itself, multiply cron firings. See §4.3 for the caveat.

---

## 4. Gaps and edge cases — ranked by what actually breaks first

### 4.1 Stale-scan silently drops data past a hard cap (confirmed bug, not speculation)

```ts
const issues = await prisma.issue.findMany({ ..., take: 250 });
const workspaces = ... : await prisma.workspace.findMany({ ..., take: 500 });
```

Both are single queries with a hard `take`, no pagination loop. A workspace with more than 250 active issues has the rest **never checked for staleness**, silently, forever — no error, no log entry pointing at it. Same for the 500-workspace cap on the global nightly sweep once you exceed 500 workspaces. This is currently inert only because the scheduler is disabled in dev; it will start silently under-covering the moment either cap is crossed in a real environment.

### 4.2 No request coalescing — `proactive-summary` fires 2x per issue write, every time

Every issue create/update enqueues a proactive-summary job for its project scope *and* its team scope, unconditionally, with no debounce. A project getting edited rapidly (a burst of updates, a bulk operation, an import) fires a full summary-rebuild job pair for every single write. At 1000x write volume this is real, avoidable queue and DB load — a short coalescing window (debounce by target, ~30s) would collapse a burst of writes into one rebuild instead of N.

### 4.3 Nothing stops someone from accidentally running more than one scheduler replica

The scheduler being a separate process from the worker is correct, but it's a *convention*, not an enforced constraint. Nothing in the code prevents someone from naively scaling "all services ×N" in an orchestrator and ending up with N copies of `ai-background.scheduler.ts`, each independently firing the same `node-cron` schedule — N duplicate daily/weekly sweeps at the same moment. A more robust replacement: use BullMQ's own `repeat` job option instead of `node-cron` in a bespoke process. Repeatable jobs are deduplicated at the Redis level regardless of how many processes are watching, which makes "exactly one scheduler" self-enforcing instead of an operational rule someone has to remember.

### 4.4 Worker-side connections multiply linearly with replicas, with no upper bound

6 connections per worker process (see §2) means 50 replicas = 300 dedicated Redis connections from workers alone, before counting API server replicas. Not fatal at Redis's default connection ceiling, but worth knowing when sizing `maxclients`, and it's the kind of number that should be watched, not assumed.

### 4.5 No rate limiter on the embeddings queue against the actual provider limit

`concurrency: 2` bounds *parallel* jobs, not *rate*. A burst — a bulk import, or 10+ worker replicas all picking up a backlog simultaneously — has nothing stopping it from exceeding OpenRouter's real rate limit and triggering a synchronized retry storm across every replica at once. BullMQ supports a `limiter: { max, duration }` option per worker for exactly this; not configured anywhere today.

### 4.6 No liveness signal for either background process

Neither the worker nor the scheduler exposes an HTTP endpoint or any external liveness check — confirmed, grepped for `http`/`listen`/`express` in both entry files, found nothing. An orchestrator (Kubernetes, ECS) can tell if the process crashed outright, but not if it's hung — and given `maxRetriesPerRequest: null` on every Redis connection here (a correct BullMQ setting, but one that means a command genuinely waits forever rather than failing fast if Redis becomes unreachable without a client-visible error), a hung-but-alive worker is a real, not theoretical, failure mode to be blind to.

### 4.7 No monitoring or alerting on queue depth or failures — proven, not assumed

I checked Redis directly rather than taking this as a guess. Right now, sitting in the `ai.proactive-summary` failed set, are **18 failed jobs from 2026-06-26** — a real incident, roughly a 3-hour window, caused by the `AiSuggestionType` Prisma enum not matching the generated client at the time (`TEAM_HEALTH` wasn't recognized). The enum is present in the current generated client, so this specific cause is resolved — but the point stands regardless of root cause: **that incident sat completely unnoticed in Redis for over a month.** Nothing surfaced it. Nobody would know it happened without manually inspecting Redis, which is what just revealed it. This is the same category of blind spot as §1.1 — a build/generation mismatch causing silent failures — just from six weeks earlier, still undetected until this review.

### 4.8 The `runDetached` inline fallback gets worse, not better, with more replicas

Covered from a different angle earlier this session: if a queue enqueue fails, the job runs inline inside whatever process made the write, via `setImmediate`. At low replica count this is a reasonable safety net. At high replica count, a real Redis outage means **every** app-server replica simultaneously starts doing background AI work synchronously inside its own request-handling process — a queue outage becomes a fleet-wide response-time degradation instead of a contained, visible queue backlog. Worth knowing this is the actual failure shape before it happens, not after.

---

## 5. Direct answer: scaling from 1 → 5 → 10 → 50 worker replicas

**Will it work, mechanically?** Yes. Nothing found in this review makes horizontal scaling of the worker process unsafe — job claiming is atomic via Redis, suggestion writes are upsert-safe via a real DB constraint, and embedding writes are idempotent via content hash. This was the main thing worth verifying and it holds.

**Will it work *well*, unattended, at 50x?** Not yet, for reasons that have nothing to do with the scaling mechanism itself:

1. It would be scaling stale code (§1.1) unless the build step is fixed first — this has to be first regardless of everything else.
2. At 50 replicas, connection count (§4.4), rate-limiting (§4.5), and the scheduler-duplication risk (§4.3) go from "theoretical" to "will actually happen" — these are exactly the kind of thing that's invisible at 1 replica and obvious at 50.
3. There is currently no way to *know* it's working at 50x, because there's no monitoring (§4.7) — and §4.7 already proved, with a real 6-week-old incident, that failures here go unnoticed by default.

**Recommended order, cheapest and most load-bearing first:**
`npm run build` before `npm run worker` (§1.1, fix now, unblocks trusting anything else) → kill the duplicate Redis (§1.2) → stale-scan pagination (§4.1) → basic queue/failure monitoring, e.g. Bull Board (§4.7) → per-queue rate limiter on embeddings (§4.5) → debounce proactive-summary (§4.2) → replace the cron scheduler with BullMQ repeatable jobs (§4.3) → then scale replica count with actual confidence.
