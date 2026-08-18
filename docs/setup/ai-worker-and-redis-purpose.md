# What the AI Worker and Redis Are Actually For

> A purpose-and-responsibility explainer, not a bug list. For known gaps,
> scaling behavior, and verified issues, see
> [redis-bullmq-production-readiness-review.md](./redis-bullmq-production-readiness-review.md).
> This doc answers a narrower question: what is this system *designed* to do.

---

## 1. The one-sentence version

**Redis's only job in this codebase is to be the message broker BullMQ uses to hand work from the API server to the worker process.** Confirmed by checking every file that touches `ioredis` in this repo — there are exactly three, and all three exist purely to set up BullMQ's queue connection. Redis is not used here for caching, sessions, or rate limiting — just the job queue.

**The AI worker's job is to do the things the user should never have to wait for.** When someone creates an issue, the API responds the instant the issue is saved — it does not wait around to also check for duplicates, suggest a priority, re-embed the entity for search, or recompute a project health summary. Those all happen a moment later, in a separate process, off the request path. That separation — instant response now, useful-but-not-urgent work seconds later — is the entire reason this system exists.

---

## 2. Why a queue, specifically — the problem it solves

Without a queue, "check for duplicate issues" or "generate an embedding" would have to happen inline, inside the same request that creates the issue. Every issue creation would get slower by however long the slowest of those checks takes. Worse, if the embedding API has a bad moment, issue creation itself would fail or hang — a feature meant to make search better would be able to break the core act of creating an issue.

A queue decouples those two things completely. The write to Postgres finishes, the user gets their response, and *separately*, a job gets dropped into Redis saying "here's something that needs following up on." The worker process — running independently, on its own schedule, unaffected by request traffic — picks that job up when it can and does the work. If that work fails, retries, or takes an extra second, the user creating the issue never notices, because they were never waiting on it.

---

## 3. What the worker is actually responsible for — six jobs, six purposes

### 3.1 `ai.embeddings` — keep the semantic search index current

**Purpose:** every time an issue, comment, document, project, team, department, member, or cycle is created or meaningfully changed, this job renders it into text and stores a vector for it, so it's findable by *meaning* later — someone searching "login problems" should find an issue titled "Auth fails on OAuth callback" even though the words don't overlap.

**Why it can't be inline:** it calls an external embedding API. That's a network round-trip on every single write to eight different entity types. Doing that synchronously would mean creating a team, renaming a project, or posting a comment all get slower by however long that external call takes — for a feature (semantic search) the person writing that data isn't even using in that moment.

### 3.2 `ai.issue-intelligence` — the "did you consider..." layer on every issue

**Purpose:** whenever an issue is created or updated, this job checks four things and surfaces a suggestion if any are worth raising: does the text imply a different priority than what's set, do any existing labels seem to fit better than what's applied, does the issue have nobody assigned when someone should probably be picked based on team workload, and does it look like a duplicate of something that already exists.

**How it decides:** keyword/heuristic detection for priority and labels, a workload comparison for assignment, and a text-similarity check for duplicates — not an LLM call. This is deliberately cheap and fast; it's meant to run on *every* issue write without adding real cost or latency risk.

### 3.3 `ai.proactive-summary` — the "is this project okay" check

**Purpose:** triggered by issue writes (both the issue's project and its team) and cycle writes, this job asks "given everything currently true about this project/team/cycle, is there something worth proactively telling someone about?" — a project quietly stalling, a team overloaded, a cycle at risk. If the answer is yes, it creates or updates a suggestion; if nothing's changed enough to matter, it does nothing and exits — it's not trying to notify on every single trigger, just when the underlying picture actually shifted.

**Why it's triggered so often:** it fires on the same events as issue-intelligence (every issue write) because a project's health can genuinely change with a single issue update. The tradeoff — firing on every write versus batching — is a real one, and it currently leans toward "fire every time and let the dedup logic decide if anything's worth surfacing," rather than batching writes together first.

### 3.4 `ai.sprint-planning` — cycle-creation assistance

**Purpose:** runs when a cycle is created or updated, to support planning that cycle — surfacing what should probably be in scope based on what's already in the backlog and team capacity.

### 3.5 `ai.stale-scan` — find work that's gone quiet

**Purpose:** intended to run once a day, this walks active issues (in-progress or in-review) across a workspace and flags anything that hasn't been touched — no edits, no comments, no activity — in longer than the configured stale threshold, so it doesn't just silently sit forgotten.

**Current status:** this is on a daily cron, and that cron is currently turned off in this environment (`AI_BACKGROUND_SCHEDULER_ENABLED=false`) — the job exists and works when triggered, it's just not being triggered automatically right now.

### 3.6 `ai.weekly-digest` — the once-a-week roundup

**Purpose:** intended to run weekly, summarizing what happened across a workspace over the past week — completed work, notable changes — as a digest rather than requiring someone to piece it together from individual notifications.

**Current status:** same as stale-scan — implemented, scheduled for Monday mornings, currently not firing because the scheduler is off.

---

## 4. The other half: what Redis is actually holding

When a job is enqueued, Redis is where it physically lives until a worker picks it up. Concretely, for each of the six job types, Redis holds:

- **The waiting list** — jobs that have been created but no worker has started on yet.
- **The active set** — jobs a worker currently has claimed and is working on, plus a lock that says "I'm on this one" so no other worker also picks it up.
- **The completed and failed records** — kept for a while (1 day for successes, 7 days for failures) so there's a trail of what happened, before being cleaned up automatically.
- **Retry/backoff state** — if a job fails, Redis is what remembers "try this again in 5 seconds," then 10, then 20, up to 3 attempts, before giving up and leaving it in the failed set.

This is *all* Redis is doing here. It has no idea what an "issue" or a "workspace" is — it's just holding onto small JSON payloads and coordinating which worker gets to touch which one. All of the actual meaning — what an embedding job's payload means, how to build the text for it, where to write the result — lives entirely in the application code, not in Redis.

---

## 5. How the two pieces fit together, end to end

```
1. Someone creates an issue (via the UI, or the AI side panel)
        │
2. The write happens in Postgres — this is the part the user is waiting on
        │
3. Right after, the domain service calls something like enqueueEmbedding(...)
   and triggerIssueBackgroundJobs(...)
        │
4. That call talks to Redis: "here's a small JSON payload — an entity id,
   a workspace id, a reason — for the embeddings queue and the
   issue-intelligence queue"
        │
5. The API request returns to the user right now — steps 3-4 add
   milliseconds, not seconds, because talking to Redis is just recording
   an intent, not doing the actual work
        │
6. Separately, running the whole time, is a different process
   (npm run worker) watching those same queues in Redis
        │
7. The moment a job appears, a worker claims it (Redis ensures only one
   worker can claim any given job) and runs the real logic — calls the
   embedding API, runs the heuristics, writes a suggestion
        │
8. The result lands wherever it belongs — a vector in AiEmbedding, a row
   in AiSuggestion — and the job is marked complete in Redis
```

The user in step 2 never sees steps 6-8 happen. That gap — sometimes a few hundred milliseconds, sometimes a couple of seconds if the queue is busy — is invisible to them, and that invisibility is the entire point of the design.

---

## 6. What's supposed to happen if either piece isn't there

This system was built with the expectation that Redis might not always be reachable, and it degrades rather than breaks:

- **If Redis is down when a write happens:** the enqueue attempt fails, and the same job runs immediately, inline, inside the process that was handling the write — instead of being handed off to the separate worker. The user still gets their embedding/suggestion eventually, just without the separation this whole design exists to provide (see the production-readiness review for why that's a real tradeoff at scale, not just a footnote).
- **If the worker process (`npm run worker`) isn't running at all:** jobs simply pile up waiting in Redis. Nothing is lost — they're durable in Redis until a worker comes along and claims them, whenever that is. The only cost is delay: embeddings, suggestions, and summaries just won't show up until a worker process exists to process the backlog.

Both of these are intended safety nets, not accidents — the system was designed so that neither Redis nor the worker being temporarily unavailable causes actual data loss or a broken user-facing action, only a delay in the background work that piece was responsible for.
