# Phase 20D Background AI Runbook

> This document explains the full Phase 20D implementation in simple words.
> It also explains how to run it in development and what changes in production.

---

## 1. What Phase 20D Is

Phase 20D is the **background AI system** for Trussen.

It does not chat with the user like 20B.
It does not help inside a form like 20A.

Instead, it works **behind the scenes**.

Example:

- user creates an issue
- normal issue creation finishes first
- background AI checks the issue later
- it may create suggestions like:
  - suggested labels
  - suggested priority
  - suggested assignee
  - possible duplicate issue

The important rule is:

```text
20D suggests
20D does not silently change product data on its own
```

---

## 2. Main Idea In One Flow

This is the full lifecycle:

```text
user action happens
-> backend saves normal data
-> backend enqueues a background job
-> worker picks the job
-> worker loads fresh workspace data
-> worker applies rules / embeddings / background logic
-> worker saves AiSuggestion rows
-> notifications can be sent
-> user or admin accepts / dismisses suggestion
-> existing issue/cycle service applies the real change
```

This means the main product action stays fast.

If background AI fails, the issue or cycle action should still succeed.

---

## 3. What Was Added

### Background storage

Three new database models were added:

- `AiSuggestion`
- `AiEmbedding`
- `AiJobRun`

### Background infrastructure

These systems were added:

- Redis
- BullMQ queues
- worker process
- scheduler process
- pgvector support for embeddings

### New API endpoints

These AI background routes were added:

- `GET /ai/suggestions`
- `POST /ai/suggestions/:id/accept`
- `POST /ai/suggestions/:id/dismiss`
- `POST /ai/suggestions/run`

### New automatic triggers

Background AI now triggers after:

- issue create
- issue update
- issue status update
- cycle create
- label create/update/delete

Scheduled jobs can also trigger:

- stale scan
- weekly digest

---

## 4. What Each Major File Does

### `modules/ai/ai.background.ts`

This is the main background AI brain.

It:

- runs issue intelligence jobs
- runs embedding jobs
- runs stale issue scans
- runs weekly digests
- runs sprint planning suggestions
- creates and updates suggestions
- records job runs
- sends notification triggers

Simple meaning:

```text
This file decides what background AI work should happen and how suggestions are created.
```

### `modules/ai/ai.suggestions.ts`

This file handles suggestion actions.

It:

- lists suggestions
- checks access to suggestions
- accepts suggestions
- dismisses suggestions
- manually reruns suggestion jobs

Simple meaning:

```text
This file is the user/admin control layer for AI suggestions.
```

### `modules/ai/ai.jobs.ts`

This file defines queue jobs.

It:

- names each queue
- defines job payload types
- adds jobs to BullMQ queues

Simple meaning:

```text
This file is the queue contract.
```

### `modules/ai/ai.worker.ts`

This file starts BullMQ workers.

It:

- opens workers for all AI queues
- listens for jobs
- runs the correct processor
- handles shutdown

Simple meaning:

```text
This file is the background worker runner.
```

### `modules/ai/ai.scheduler.ts`

This file starts scheduled jobs.

It:

- schedules daily stale scans
- schedules weekly digests

Simple meaning:

```text
This file runs time-based background AI jobs.
```

### `modules/ai/ai.embeddings.ts`

This file handles embeddings and similarity search.

It:

- builds text for issue embeddings
- hashes embedding content
- saves vectors into `AiEmbedding`
- searches for similar issues

Simple meaning:

```text
This file powers semantic duplicate detection.
```

### `infra/queue/redis.ts`

This file manages Redis connections.

It:

- creates queue connections
- returns shared Redis connection
- closes connections safely

Simple meaning:

```text
This file is the Redis connection layer for background AI.
```

### `infra/queue/queues.ts`

This file creates BullMQ queues.

It:

- returns queue instances
- sets retry and cleanup defaults

Simple meaning:

```text
This file is the queue factory.
```

### `workers/ai-background.worker.ts`

This is the standalone process entrypoint for workers.

Use it when you want background queue processing.

### `workers/ai-background.scheduler.ts`

This is the standalone process entrypoint for scheduled jobs.

Use it when you want daily/weekly jobs to run automatically.

### `modules/issue/issue.service.ts`

This existing file was updated so background AI triggers after:

- issue create
- issue update
- issue status update

Important:

It triggers **after the normal write succeeds**.

### `modules/cycle/cycle.service.ts`

This existing file was updated so sprint-planning background AI can trigger after cycle creation.

### `modules/label/label.service.ts`

This existing file was updated so label changes can refresh label suggestions on recent issues.

### `prisma/schema.prisma`

This now contains the 20D models and enums.

### `prisma/migrations/20260622150000_phase20d_background_infra/migration.sql`

This migration creates:

- 20D enums
- AI suggestion table
- AI embedding table
- AI job run table
- required indexes
- `pgcrypto`
- `vector`

---

## 5. What Each Background Feature Does

### Suggested labels

When an issue is created or updated, Trussen compares issue text with workspace labels.

It tries to suggest existing labels.

### Suggested priority

When issue language looks urgent, important, or minor, Trussen can suggest a better priority.

### Suggested assignee

If an issue has no assignee, Trussen ranks possible candidates using team and project context.

### Duplicate detection

Trussen checks whether a new issue looks similar to existing issues.

Two methods exist:

- text similarity
- embedding similarity with pgvector

### Stale issue detection

Scheduled job checks active issues that have gone quiet for too long.

It now looks at:

- issue update time
- comments
- activity history

### Weekly digest

Scheduled job builds a summary for admins/owners.

It now includes:

- issues created
- issues completed
- active issues
- overdue issues
- stale issues
- top blockers
- cycle progress

### Sprint planning suggestions

When a cycle is created or manually rerun, Trussen ranks unplanned team issues.

It considers things like:

- priority
- age
- overdue state
- blockers
- assignee workload

---

## 6. New Database Tables In Simple Words

### `AiSuggestion`

Stores suggestions waiting for user decision.

Examples:

- assign this issue to Sarah
- this looks like a duplicate
- add these labels

### `AiEmbedding`

Stores issue vectors for semantic search.

This is mainly for duplicate detection now.

### `AiJobRun`

Stores background job execution history.

This helps debug:

- what ran
- what failed
- what succeeded

---

## 7. Environment Variables

Add these to backend `.env`:

```env
REDIS_URL=redis://127.0.0.1:6379
REDIS_QUEUE_PREFIX=trussen
AI_BACKGROUND_WORKERS_ENABLED=true
AI_BACKGROUND_SCHEDULER_ENABLED=false
AI_EMBEDDING_MODEL=text-embedding-3-small
AI_STALE_ISSUE_DAYS=7
AI_BACKGROUND_ASSIGNEE_CANDIDATE_LIMIT=3
```

Also required:

```env
OPENROUTER_API_KEY=...
```

What they mean:

- `REDIS_URL`: where BullMQ connects
- `REDIS_QUEUE_PREFIX`: queue namespace
- `AI_BACKGROUND_WORKERS_ENABLED`: enable workers
- `AI_BACKGROUND_SCHEDULER_ENABLED`: enable scheduled jobs
- `AI_EMBEDDING_MODEL`: embedding model name
- `AI_STALE_ISSUE_DAYS`: stale issue threshold
- `AI_BACKGROUND_ASSIGNEE_CANDIDATE_LIMIT`: max assignee suggestions

---

## 8. Development Setup

### Step 1. Database

Make sure PostgreSQL is running.

The 20D migration needs:

- `pgcrypto`
- `vector`

If `vector` is not available, install `pgvector` on your PostgreSQL machine first.

### Step 2. Redis

For local development, Redis usually runs on:

```env
REDIS_URL=redis://127.0.0.1:6379
```

To verify Redis:

```bash
redis-cli ping
```

Expected:

```bash
PONG
```

### Step 3. Run migrations

If migrations are not applied yet:

```bash
npx prisma migrate dev
```

### Step 4. Build once

```bash
npx prisma generate
npm run build
```

### Step 5. Start the backend app

Use your normal backend start command.

Example:

```bash
npm run dev
```

### Step 6. Start the worker

This is required for queue-based background AI processing:

```bash
npm run worker
```

Expected startup line:

```text
[AI Worker] Started 5 background workers.
```

### Step 7. Optional scheduler

If you want daily and weekly jobs in development:

```env
AI_BACKGROUND_SCHEDULER_ENABLED=true
```

Then run:

```bash
npm run scheduler
```

### Recommended local dev mode

Use this first:

```env
AI_BACKGROUND_WORKERS_ENABLED=true
AI_BACKGROUND_SCHEDULER_ENABLED=false
```

Why:

- worker is enough to test issue-based jobs
- scheduler can stay off until you want stale/digest automation

---

## 9. How To Test In Development

### Test issue intelligence

1. create an issue with urgent or descriptive text
2. keep worker running
3. watch worker logs
4. check whether `AiSuggestion` rows are created

### Test duplicate detection

1. create one issue
2. create another issue with very similar title/description
3. look for duplicate suggestions

### Test assignee suggestion

1. create issue without assignee
2. keep team members available
3. look for assignee suggestion

### Test scheduler features

1. enable scheduler
2. manually rerun with `/ai/suggestions/run` or wait for schedule
3. verify stale or weekly digest suggestions

---

## 10. Production Setup

Production is the same architecture, but the infrastructure is different.

### Production requirements

You need:

- PostgreSQL with `pgvector` installed
- Redis reachable by the app
- backend app process
- worker process
- optional scheduler process

### Production Redis

Do not use `127.0.0.1:6379` unless Redis is on the same production machine.

Normally production uses a real Redis host:

```env
REDIS_URL=redis://username:password@your-redis-host:6379
```

### Production database

The production PostgreSQL server must allow:

- `CREATE EXTENSION vector`
- `CREATE EXTENSION pgcrypto`

Usually this is handled by infra/admin once, not by the app user every time.

### Production migration

Use:

```bash
npx prisma migrate deploy
```

Do not use `migrate dev` in production.

### Production process layout

At minimum:

1. web API process
2. worker process

Optional:

3. scheduler process

Recommended production process split:

```text
web server      -> handles API requests
worker service  -> handles BullMQ jobs
scheduler       -> enqueues stale/digest jobs
```

### Production env recommendation

```env
AI_BACKGROUND_WORKERS_ENABLED=true
AI_BACKGROUND_SCHEDULER_ENABLED=true
```

### Production startup order

1. make sure PostgreSQL is ready
2. make sure Redis is ready
3. apply migrations
4. start API server
5. start worker
6. start scheduler if used

### Production commands

After build:

```bash
npm run start
npm run worker
npm run scheduler
```

Because the project now compiles `workers/**/*.ts`, the worker and scheduler can run from compiled `dist/`.

---

## 11. What Must Stay Running

### For normal API only

Only backend app is needed.

### For full 20D background AI

Backend app and worker must be running.

### For full 20D plus automatic stale/digest jobs

Backend app, worker, and scheduler must be running.

---

## 12. Failure Behavior

This is the intended safe behavior:

- if background AI fails, issue create/update should still succeed
- if Redis is unavailable, warning should be logged
- if queue enqueue fails, request should not crash
- if worker fails a job, failure should be visible in logs and `AiJobRun`

That is the production-safe design target.

---

## 13. Quick Development Checklist

Use this exact checklist:

1. PostgreSQL running
2. `pgvector` installed
3. Redis running
4. `.env` updated
5. migrations applied
6. `npm run build`
7. backend app running
8. `npm run worker`
9. optionally `npm run scheduler`

---

## 14. Quick Production Checklist

Use this exact checklist:

1. production PostgreSQL supports `vector`
2. production Redis exists and is reachable
3. production `.env` has real Redis URL
4. `npx prisma migrate deploy`
5. deploy compiled backend
6. run web process
7. run worker process
8. run scheduler process if enabled
9. verify logs and first background suggestions

---

## 15. Short Summary

In simple words:

- the API app handles user requests
- Redis stores background jobs
- BullMQ manages those jobs
- worker processes jobs
- scheduler triggers time-based jobs
- PostgreSQL stores suggestions and job history
- pgvector stores embeddings for smarter duplicate detection
- users still decide whether suggestions should be applied

That is the complete Phase 20D system.
