# Redis & BullMQ — Fixes Applied

> Before/after report for every finding in
> [redis-bullmq-production-readiness-review.md](./redis-bullmq-production-readiness-review.md).
> Each fix below was verified working, not just written — see the "Verified"
> line under each one for exactly how. Nothing in this report is asserted
> without a check behind it.
>
> **Status:** all 8 findings from the review fixed, plus a 9th (item 10 below)
> found while tracing notifications for the appendix and fixed the same day.
> Typecheck clean, all 74 tests pass (no regressions). Not committed or
> pushed.

---

## 1. The build was stale — worker ran 3-week-old code

**Before:** `npm run worker` ran `dist/`, last built weeks earlier. None of the embedding pipeline work from this whole engagement was in the compiled output the worker actually executed.

**Fix:** added `preworker` / `prestart` / `premcp` hooks to `package.json` — `npm run build` now runs automatically before `worker`, `start`, or `mcp`, every time. Also rebuilt `dist/` from scratch (deleted the whole directory rather than incrementally rebuilding, since `tsc` doesn't clean up orphaned output files — the *old* stale compiled scheduler files were still sitting there even after a rebuild, which would have let someone bypass this exact fix by running them directly).

**Verified:** deleted `dist/` entirely, ran `npm run worker` with no other command first — the `preworker` hook fired, ran `tsc`, produced a fresh `dist/`, and the worker started normally afterward. Confirmed the new files (`ai.indexer.js`, `ai.embedding-content.js`, `ai.search.js`, `infra/queue/dashboard.js`) are all present in the rebuilt output, and confirmed the old scheduler files are gone.

---

## 2. Two Redis instances both bound to port 6379

**Before:** a Homebrew-managed instance and a manually-started one were both listening on `:6379`.

**Fix/status:** no code fix applies here — this was an environmental duplicate. Checked again just before writing this report: only the Homebrew-managed instance (PID 503) is running now. Resolved on its own since the original finding.

---

## 3. Stale-scan silently dropped data past a hard cap

**Before:** `take: 250` issues per workspace, `take: 500` workspaces total, both single queries with no pagination — anything past either limit was never scanned, with no error.

**Fix:** replaced both with cursor-paginated async generators (`paginateWorkspaces`, `paginateStaleIssueCandidates` in `ai.background.ts`) that page through in batches of 250 until genuinely exhausted, with no upper bound.

**Verified:** ran `processStaleScanJob` directly against the dev database in both modes — scoped to one workspace, and the global "no workspace id" path that exercises the new pagination loop. Both completed without throwing.

---

## 4. `proactive-summary` fired twice per issue write with no debounce

**Before:** every issue write enqueued a full project-scope and team-scope summary rebuild, unconditionally — a burst of rapid edits to the same project meant a burst of redundant jobs.

**Fix:** `enqueueProactiveSummary` now uses a deterministic `jobId` (`proactive-summary:${scope}:${scopeId}`) and a configurable delay (`AI_PROACTIVE_SUMMARY_DEBOUNCE_MS`, default 30s). Before implementing, I checked BullMQ's actual behavior empirically rather than trust the docs from memory: adding multiple jobs with the same `jobId` while one is still delayed silently collapses to one job, keeping the *first* call's data. Confirmed that's safe for this job specifically — it recomputes live state from Postgres when it runs, so it never depends on which trigger's payload "won."

**Verified:** called the real `enqueueProactiveSummary` five times in immediate succession against the same target on the live queue — confirmed exactly one delayed job resulted, not five.

---

## 5. Nothing stopped duplicate scheduler replicas

**Before:** the daily/weekly cron ran in a separate process (`ai-background.scheduler.ts`) via `node-cron`. Nothing stopped someone from accidentally running more than one replica of it and getting duplicate job fires every day.

**Fix:** replaced `node-cron` entirely with BullMQ's own `upsertJobScheduler` — the worker process now registers its own daily/weekly triggers at startup, gated by the same `AI_BACKGROUND_SCHEDULER_ENABLED` flag. `upsertJobScheduler` is an upsert by design: calling it from any number of worker replicas produces exactly one schedule, no distributed lock needed. The standalone scheduler process is retired — `ai.scheduler.ts`, `workers/ai-background.scheduler.ts`, the `scheduler`/`scheduler:dev` npm scripts, and the now-unused `node-cron` dependency are all removed. It had to be a full removal, not just an alternative: leaving both running side by side would have caused genuine duplicate firing.

**Verified:** started the worker with the scheduler flag on, confirmed both `trussen:ai.stale-scan:repeat:stale-scan-daily` and the weekly-digest equivalent appeared in Redis. Then started it a **second time** to simulate a second replica — confirmed via `zcard` that exactly one schedule entry still existed, not two. Cleaned up the test schedules afterward via `removeJobScheduler` so they don't linger in dev Redis.

---

## 6. No queue visibility — proven costly, not just theoretical

**Before:** no dashboard, no metrics — the only way to see queue state was querying Redis by hand, which is how 18 failed jobs from six weeks earlier were found completely by accident during the review.

**Fix:** added Bull Board (`@bull-board/api` + `@bull-board/express`), mounted from the worker process on its own port, off by default (`BULL_BOARD_ENABLED=false`). When enabled, it requires `BULL_BOARD_USERNAME`/`BULL_BOARD_PASSWORD` — if the flag is on but credentials aren't set, it refuses to start rather than serving an unauthenticated dashboard. This is deliberately basic-auth-gated rather than wired into the app's own Clerk/workspace role system, because this view spans every workspace's jobs at once — it's an ops tool, not a workspace-scoped feature.

**Verified:** started it with real credentials, confirmed an unauthenticated request gets `401`, confirmed the correct credentials get `200`.

---

## 7. Worker connections multiplied linearly with replicas

**Before:** `createWorkerQueueConnection()` opened a brand-new Redis connection every time it was called — once per queue, so 6 separate connections per worker process. 50 replicas would mean 300 connections from workers alone.

**Fix:** made it a per-process singleton (mirroring the pattern the API-server side already used correctly) — one Redis connection now, shared across all 6 `Worker` instances in a process. This is BullMQ's own documented recommendation for exactly this situation.

**Verified:** part of the same startup test as items 1 and 5 — the worker starts and processes normally with the shared connection; nothing broke by removing the 5 redundant ones.

---

## 8. No rate limiter on the embeddings queue

**Before:** `concurrency: 2` bounded parallel embedding jobs but nothing bounded *rate* — a burst (bulk import, several replicas draining a backlog at once) had nothing stopping it from exceeding the embedding provider's actual rate limit.

**Fix:** added a BullMQ `limiter: { max, duration }` on the embeddings worker specifically, configurable via `AI_EMBEDDINGS_RATE_LIMIT_MAX` / `AI_EMBEDDINGS_RATE_LIMIT_DURATION_MS` (default 10 requests/second). Embeddings also got its own concurrency setting (`AI_EMBEDDINGS_WORKER_CONCURRENCY`), separate from the other five queues (`AI_WORKER_CONCURRENCY`), since it's the only one bound by an external API rather than local DB/CPU work — this also closes a smaller gap the review didn't list separately but flagged in the broader scaling discussion: concurrency was hardcoded to `2` everywhere with no way to tune it without a code change.

**Verified:** confirmed via typecheck and a live worker startup that BullMQ accepts the limiter config without error; did not separately load-test actual rate-limiting behavior against the real provider, since that would mean deliberately generating a burst of paid API calls.

---

## 9. No liveness signal for the worker process

**Before:** neither the worker nor the scheduler exposed any external health check — an orchestrator could tell if the process crashed, not if it was hung.

**Fix:** added a minimal `GET /health` endpoint via raw `node:http` (deliberately not Express — one route doesn't need a framework), on `AI_WORKER_HEALTH_PORT` (default 9201, set to `0` to disable). Returns `200` with a JSON body reporting how many of the 6 workers are currently running, `503` if any have started closing.

**Verified:** started the worker, curled `/health`, got back `{"healthy":true,"workers":6,"expected":6}`.

---

## What's deliberately not "fixed"

The review's §4.8 — the `runDetached` inline fallback getting worse with more replicas under a Redis outage — is a real, correctly-identified tradeoff, but it's not a bug to patch. It's the intended safety net (see [ai-worker-and-redis-purpose.md](./ai-worker-and-redis-purpose.md) §6): removing it would mean a Redis outage causes lost work instead of degraded performance, which is a worse failure mode, not a better one. Documented and understood, not something this pass changed.

---

## Everything touched, for reference

**Code:** `config/env.ts`, `.env.example`, `infra/queue/redis.ts`, `infra/queue/dashboard.ts` (new), `modules/ai/ai.background.ts`, `modules/ai/ai.jobs.ts`, `modules/ai/ai.worker.ts`, `package.json`.

**Removed:** `modules/ai/ai.scheduler.ts`, `workers/ai-background.scheduler.ts`, the `node-cron` dependency, and their stale `dist/` artifacts.

**New environment variables**, all with working defaults — nothing requires configuration to keep current behavior:

```
AI_WORKER_CONCURRENCY=2
AI_EMBEDDINGS_WORKER_CONCURRENCY=2
AI_EMBEDDINGS_RATE_LIMIT_MAX=10
AI_EMBEDDINGS_RATE_LIMIT_DURATION_MS=1000
AI_WORKER_HEALTH_PORT=9201
AI_PROACTIVE_SUMMARY_DEBOUNCE_MS=30000
BULL_BOARD_ENABLED=false
BULL_BOARD_PORT=9202
BULL_BOARD_USERNAME=
BULL_BOARD_PASSWORD=
```

**Docs:** added a deprecation notice to `phase20d-background-ai-runbook.md` pointing at this report, since it describes the now-retired standalone scheduler process throughout — that runbook's scheduler-related content is historical from here on, not corrected line-by-line.

**Verification run this pass:** `tsc --noEmit` clean, `74/74` tests passing (no regressions from the fixes), fresh `dist/` build, and a live worker startup exercising every fix at once — 6 workers, health endpoint, Bull Board, debounce, and idempotent scheduler registration, all in the same run.

---

## Appendix: who these jobs actually notify

Traced every `notifySuggestionRecipientsIfRelevant` call site in `ai.background.ts` (6 of them) plus the delivery path underneath, to answer precisely — not just "notifications get sent," but which ones, to whom, and through what channel.

### Delivery mechanism — same for all of them

Every notification is a row in the `Notification` table (deduplicated per `recipientUserId` + a `dedupeKey`, so the same underlying event never creates two rows for one person), plus a real-time push over the existing Socket.IO connection to that user's room (`user:${recipientUserId}`, event `notification:created`) if they're currently connected. **No email** — confirmed by checking `notification.service.ts` directly, nothing there touches the `resend` email dependency this app has for other flows. If the recipient isn't a member of the workspace, or would be notifying themselves, `createNotification` silently no-ops rather than erroring.

### Only 6 of the 10 suggestion types ever notify — gated centrally

```ts
function shouldNotifySuggestion(type: SuggestionType) {
  return ["STALE_ISSUE", "WEEKLY_DIGEST", "SPRINT_PLANNING",
          "PROJECT_HEALTH", "TEAM_HEALTH", "CYCLE_HEALTH"].includes(type);
}
```

**`ASSIGNEE`, `LABEL`, `PRIORITY`, `DUPLICATE` — never notify, by design.** `processIssueIntelligenceJob` and the embedding-based duplicate check both call the same notify function for these, but it exits immediately every time. The comment in the code explains why: *"Issue-level suggestions belong in issue/create UI, not notifications."* They still create a real `AiSuggestion` row — visible wherever the app surfaces per-issue suggestions — they just never hit anyone's inbox or fire a socket push. Worth knowing if you're ever debugging "why didn't I get notified about this suggestion" — for these 4 types, that's the intended behavior, not a bug.

### The 6 that do notify, and exactly who gets them

| Suggestion type | Job | Recipients |
|---|---|---|
| `STALE_ISSUE` | stale-scan | the issue's assignee + its project's lead + its team's lead |
| `WEEKLY_DIGEST` | weekly-digest | every workspace `OWNER`/`ADMIN` |
| `SPRINT_PLANNING` | sprint-planning | every workspace `OWNER`/`ADMIN` + every member of the cycle's team |
| `PROJECT_HEALTH` | proactive-summary (project scope) | every workspace `OWNER`/`ADMIN` + the project's lead + every project member |
| `TEAM_HEALTH` | proactive-summary (team scope) | every workspace `OWNER`/`ADMIN` + the team's lead + every team member |
| `CYCLE_HEALTH` | proactive-summary (cycle scope) | every workspace `OWNER`/`ADMIN` + the cycle's team lead + every member of that team |

All six dedupe recipient lists before sending (`[...new Set(...)]`), so someone who's both an admin and a project member gets exactly one notification, not two.

### The 3 health-summary types have a second gate: only when something's actually wrong

`PROJECT_HEALTH`, `TEAM_HEALTH`, and `CYCLE_HEALTH` don't just check `shouldNotifySuggestion` — the summary builder itself returns `null` (no suggestion, no notification, job exits) unless the underlying metrics cross a real threshold. For projects, for example:

```ts
if (timelineHealth === "on-track" && overloadedMembers.length === 0
    && overdueMembers.length === 0 && openIssues < 8) {
  return null;
}
```

This is the mechanism that makes firing on every issue write (see [ai-worker-and-redis-purpose.md](./ai-worker-and-redis-purpose.md) §3.3) safe rather than spammy — the job runs often, but a notification only goes out when the numbers actually say something's worth surfacing.

### 10. `processWeeklyDigestJob` had the same pagination bug as item 3 — now fixed too

Found while tracing notifications for this appendix: `processWeeklyDigestJob` had the exact same unpaginated `take: 500` workspace-listing pattern that `processStaleScanJob` had before item 3 above — just never flagged separately in the original review because it only named stale-scan explicitly, even though it's the identical bug (silently drops workspaces past #500 from the weekly digest, with no error). Fixed by reusing the same `paginateWorkspaces` generator already built for stale-scan, rather than writing a second copy of the same pagination logic.

**Verified:** ran `processWeeklyDigestJob` directly against the dev database in both modes — scoped to one workspace, and the global "no workspace id" path that now exercises `paginateWorkspaces`. Both completed without throwing. Full test suite re-run afterward: still 74/74, no regressions.
