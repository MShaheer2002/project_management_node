# Phase 20D - Heavy Infrastructure Explained

> Purpose: explain the infrastructure part of Phase 20D in simple English first, then in technical terms, with benefits and key terminology.

---

## 1. What "Heavy Infrastructure" Means

### Simple English

Heavy infrastructure means the parts of Background AI that do not just add feature logic, but add the systems needed to run AI work safely in the background.

This is different from normal backend code.

Normal backend code:

- user sends request
- server handles it immediately
- response returns

Heavy infrastructure:

- work is queued
- background workers process it later
- scheduled jobs run automatically
- embeddings are stored for similarity search
- failures are retried safely

### Technical Meaning

Heavy infrastructure for 20D means adding asynchronous job processing, vector search support, scheduled execution, durable suggestion pipelines, and production-safe background processing around the existing AI module.

In this project, that means:

- Redis
- BullMQ
- worker processes
- cron/scheduler jobs
- pgvector
- embeddings storage
- retry/idempotency patterns
- observability for background jobs

### Benefits

- User-facing requests stay fast.
- AI/background failures do not break issue creation.
- Expensive work can run later and be retried.
- Duplicate detection becomes much stronger with vector similarity.
- The system becomes scalable enough for daily scans and weekly reports.

---

## 2. Redis

### Simple English

Redis is a very fast storage system that keeps data in memory.

For Phase 20D, Redis is mainly used as the message store behind the background job queue.

Think of it like a temporary control room:

- jobs are placed there
- workers pick them up
- retries and delays are managed there

### Technical Meaning

Redis is an in-memory data store commonly used for queues, caching, locks, and pub/sub systems.

With BullMQ, Redis stores:

- waiting jobs
- active jobs
- failed jobs
- delayed jobs
- retry metadata
- queue state

### Benefits

- Very fast job coordination.
- Reliable enough for queue-backed workflows.
- Standard choice for BullMQ.
- Makes background execution possible without blocking API requests.

---

## 3. BullMQ

### Simple English

BullMQ is the tool that manages background jobs.

Instead of doing everything during the API request, BullMQ lets the app say:

"Do this later in the background."

Example:

- user creates issue
- API returns success immediately
- duplicate detection job is added to queue
- worker processes it later

### Technical Meaning

BullMQ is a Node.js job queue library built on Redis.

It provides:

- queues
- workers
- retries
- delayed jobs
- concurrency control
- backoff strategies
- job cleanup

For 20D, BullMQ should manage jobs such as:

- issue intelligence
- embeddings generation
- stale scans
- weekly digests
- sprint planning

### Benefits

- Keeps request-response paths fast.
- Makes failures retryable.
- Supports controlled concurrency.
- Separates business events from expensive processing.

---

## 4. Queue System

### Simple English

A queue is a waiting line for background work.

Instead of processing everything instantly, the system puts work into the line.

Then workers process items one by one or in small batches.

### Technical Meaning

A queue is a durable async execution layer.

For 20D, queues should carry small payloads with IDs, for example:

- workspace ID
- issue ID
- cycle ID
- trigger reason

The worker then reloads fresh data from the database.

### Benefits

- Decouples write actions from background analysis.
- Prevents slow AI work from delaying user responses.
- Helps recover safely from temporary failures.

---

## 5. Worker Process

### Simple English

A worker is a separate backend process that listens for queued jobs and performs them.

The web server handles user requests.
The worker handles background jobs.

### Technical Meaning

A worker process is a long-running service that subscribes to BullMQ queues and executes job handlers.

For 20D, worker responsibilities include:

- loading target records from Prisma
- generating suggestions
- generating embeddings
- performing duplicate search
- creating logs and suggestion rows

### Benefits

- Keeps background logic out of the web request cycle.
- Lets the system scale web and worker capacity separately.
- Makes CPU/AI-heavy work easier to isolate.

---

## 6. Scheduler / Cron Jobs

### Simple English

Some tasks are not triggered by users.
They happen every day or every week.

Examples:

- stale issue scan every day
- weekly digest every week

A scheduler is what starts those jobs automatically.

### Technical Meaning

A scheduler or cron system runs predefined jobs on a time schedule.

In 20D, cron-style jobs should enqueue work such as:

- daily stale scans
- weekly digest generation
- optional periodic backfills

The scheduler should trigger jobs, not do all heavy work inline.

### Benefits

- Makes recurring intelligence automatic.
- Prevents manual admin reruns.
- Supports passive intelligence even when no user is online.

---

## 7. pgvector

### Simple English

pgvector is a PostgreSQL extension that lets the database store and compare AI vectors.

Vectors are number lists that represent meaning.

This is what allows semantic duplicate detection.

Instead of only checking exact words, the system can check whether two issue descriptions mean almost the same thing.

### Technical Meaning

pgvector is a PostgreSQL extension for vector embeddings and similarity search.

It allows columns like:

- `vector(1536)`

and operators/indexes for nearest-neighbor search.

For 20D, pgvector is needed to:

- store issue embeddings
- search similar issues in the same workspace
- support semantic duplicate detection

### Benefits

- Much better duplicate detection than basic keyword matching.
- Uses existing PostgreSQL instead of a separate vector database at first.
- Creates a path toward semantic search later.

---

## 8. Vector Database

### Simple English

A vector database stores embeddings and helps search them quickly.

In this project, PostgreSQL + pgvector acts as the vector database.

So you do not need a separate product like Pinecone or Weaviate for the first version.

### Technical Meaning

A vector database is a system optimized for storing embeddings and running nearest-neighbor similarity search.

In Trussen V1, the vector database layer is:

- PostgreSQL
- pgvector extension
- embeddings table
- vector indexes

### Benefits

- Lower infrastructure complexity.
- Reuses your main database.
- Easier local development and simpler first rollout.

---

## 9. Embeddings

### Simple English

An embedding is a numeric representation of text.

Example:

- issue title
- issue description

gets converted into a vector.

Then the app compares that vector with vectors from older issues.

### Technical Meaning

Embeddings are dense numerical vectors generated by an embedding model.

The same meaning or similar text tends to produce nearby vectors.

For 20D, embeddings should be generated from normalized issue text such as:

- title
- description
- possibly selected metadata later

### Benefits

- Enables semantic duplicate detection.
- Supports future semantic search.
- Allows meaning-based comparisons instead of exact string matching only.

---

## 10. Embedding Pipeline

### Simple English

The embedding pipeline is the full process:

1. issue is created or updated
2. a background job is queued
3. worker generates embedding
4. embedding is stored
5. system searches similar issues

### Technical Meaning

The embedding pipeline is the async workflow that:

- detects relevant content change
- enqueues embedding work
- generates embedding from AI provider
- stores or updates vector row
- performs workspace-scoped similarity lookup

It should use content hashes so unchanged issue text is not embedded again.

### Benefits

- Avoids blocking issue creation.
- Avoids wasteful duplicate embedding calls.
- Makes duplicate detection durable and scalable.

---

## 11. Duplicate Detection

### Simple English

Duplicate detection tries to find issues that are probably describing the same problem.

Example:

- "Google login crashes on Android"
- "Android app crashes when signing in with Google"

These are different words, but possibly the same bug.

### Technical Meaning

Duplicate detection in 20D should be done in two stages:

V1 fallback:

- text similarity
- normalized keyword overlap

Better version:

- embedding generation
- pgvector nearest-neighbor search
- similarity scoring

It must always be workspace-scoped.

### Benefits

- Reduces repeated work.
- Improves triage quality.
- Helps teams link related issues earlier.

---

## 12. Suggestion Pipeline

### Simple English

20D should not silently change issue data.
It should create suggestions for users to accept or dismiss.

Examples:

- suggested assignee
- suggested labels
- suggested priority
- possible duplicate

### Technical Meaning

The suggestion pipeline is the backend flow that:

- receives an event trigger
- analyzes the target entity
- creates or updates `AiSuggestion` rows
- exposes them through APIs
- lets users accept or dismiss them

Accepting must call existing domain services, not custom direct database shortcuts.

### Benefits

- Preserves user control.
- Keeps automation safe.
- Fits the documented 20D product model.

---

## 13. Idempotency

### Simple English

Idempotency means if the same job runs twice, it should not create duplicate effects.

If a queue retries a job, the system should not create five copies of the same suggestion.

### Technical Meaning

Idempotency means repeated execution of the same logical background event produces a stable result.

For 20D this usually means:

- deterministic dedupe keys
- upsert patterns
- safe retry handling
- checking whether the target state already changed

### Benefits

- Retry-safe jobs.
- Cleaner suggestion storage.
- Less notification spam.
- More predictable production behavior.

---

## 14. Retry and Backoff

### Simple English

Sometimes a job fails for a temporary reason:

- Redis hiccup
- AI provider timeout
- network issue

Retry means try again.
Backoff means wait longer between retries.

### Technical Meaning

Retry logic allows a failed BullMQ job to run again.

Backoff delays retries using a strategy such as exponential delay.

Typical configuration:

- 3 attempts
- exponential backoff
- cleanup after completion/failure retention window

### Benefits

- Temporary failures do not require manual fixes.
- More reliable background processing.
- Less chance of losing important suggestion work.

---

## 15. Observability

### Simple English

Observability means being able to see what the system is doing.

If something goes wrong, the team should know:

- which job failed
- for which workspace
- for which issue
- why it failed

### Technical Meaning

Observability includes:

- structured logs
- job metrics
- failure counts
- duration tracking
- AI token usage tracking
- optional job-run tables

For 20D, every background job should be traceable.

### Benefits

- Easier debugging.
- Safer production rollout.
- Better cost tracking.
- Faster incident response.

---

## 16. Environment and Deployment Changes

### Simple English

20D heavy infrastructure usually means the backend is no longer only one process.

You will likely have:

- web server
- worker process
- scheduler process
- Redis service

### Technical Meaning

Deployment architecture will likely split into:

- API/web process
- BullMQ worker process
- scheduler/cron process
- PostgreSQL with pgvector enabled
- Redis for queue state

Environment variables will be needed for:

- Redis connection
- worker settings
- scheduler toggles
- embedding model configuration

### Benefits

- Cleaner separation of responsibilities.
- Better scaling options.
- Safer operations for async systems.

---

## 17. Recommended Order of Implementation

### Simple English

Build the systems in the order that reduces risk.

Do not start with the most advanced AI part first.

Recommended order:

1. Redis
2. BullMQ queue setup
3. worker process
4. suggestion jobs
5. scheduler jobs
6. pgvector
7. embeddings
8. duplicate detection
9. digest and sprint planning

### Technical Meaning

The implementation should be layered:

1. Infrastructure runtime
2. Async execution model
3. Durable suggestion pipeline
4. Scheduled scans
5. Vector storage
6. Embedding generation
7. Similarity search
8. Higher-cost AI reasoning only where justified

### Benefits

- Lower rollout risk.
- Easier testing.
- Faster path to a stable 20D architecture.

---

## 18. Summary

### Simple English

Phase 20D heavy infrastructure is what turns Background AI from a simple feature into a real system.

It lets Trussen:

- run jobs in the background
- detect duplicates better
- scan stale issues automatically
- generate suggestions safely
- scale AI work without slowing down user requests

### Technical Meaning

Phase 20D heavy infrastructure is the combination of:

- Redis
- BullMQ
- workers
- schedulers
- pgvector
- embeddings
- queue-safe suggestion pipelines
- observability and retry controls

This is the layer that enables robust passive intelligence for the existing Phase 20 backend.

---

## 19. Key Terms Quick Reference

| Term | Simple Meaning | Technical Meaning |
|---|---|---|
| Redis | Fast temporary store | In-memory datastore used by queues/caching |
| BullMQ | Background job manager | Redis-backed Node.js queue library |
| Queue | Waiting line for work | Durable async job channel |
| Worker | Background processor | Separate process executing queued jobs |
| Cron / Scheduler | Timed automation | Scheduled trigger system for recurring jobs |
| pgvector | Vector support in Postgres | PostgreSQL extension for embeddings/similarity |
| Vector DB | Similarity search storage | Embedding store optimized for nearest-neighbor search |
| Embedding | Meaning as numbers | Dense vector representation of text |
| Similarity Search | Find close matches | Nearest-neighbor vector comparison |
| Idempotency | Safe repeated execution | Same logical job does not duplicate side effects |
| Retry | Try job again | Re-execution after failure |
| Backoff | Wait before retry | Increasing delay between retries |
| Observability | See system behavior | Logs, metrics, traces, job run visibility |

