# Phase 20D - Background AI Implementation Guide

> Purpose: Build passive intelligence into Trussen without turning it into an uncontrolled automation system.
> 20D observes normal product activity, creates safe suggestions, and notifies users. It does not silently mutate workspace data.

---

## 1. Product Definition

Phase 20D is **Background AI / Passive Intelligence**.

It runs automatically after normal events happen:

- An issue is created.
- An issue is updated.
- A cycle is created.
- A daily stale-work scan runs.
- A weekly digest scan runs.

It produces helpful outputs:

- Suggested assignees.
- Suggested labels.
- Suggested priority changes.
- Possible duplicate issue warnings.
- Stale issue warnings.
- Weekly digest summaries.
- Sprint/cycle planning suggestions.

It must not directly perform destructive or user-visible mutations without confirmation.

Correct mental model:

```text
20D watches -> analyzes -> creates suggestions -> notifies -> user/admin accepts or dismisses
```

Incorrect mental model:

```text
20D watches -> silently changes assignee/priority/labels/cycle
```

---

## 2. Relationship To 20A, 20B, 20C, 20E

### 20A - AI Issue Creator

20A is user-triggered issue creation assistance.

20D can reuse some of the same rule logic:

- Priority detection.
- Type detection.
- Label detection.
- Mention/member lookup.

But 20D runs after issue creation/update events, not inside the create form.

### 20B - Trussen AI

20B is the workspace operator.

20B can act:

- Create issues.
- Update issues.
- Assign work.
- Add comments.
- Analyze workspace state.

20D can surface suggestions that 20B may later explain or act on, but 20D itself should not bypass the user.

Example:

```text
20D: "Suggested assignee: Sarah"
20B: "Assign this issue to Sarah"
```

### 20C - AI Assistance

20C is guide-only.

20C should not own 20D logic. It may explain what a suggestion means or navigate users to suggestions, but it must not generate or apply them.

### 20E - MCP Server

20E exposes Trussen actions to external agents.

20D should share safe backend primitives where possible, but it must not depend on MCP being built first.

---

## 3. Phase 20D Goals

Phase 20D should deliver:

1. A background job foundation.
2. A durable suggestion storage model.
3. Rule-based intelligence that is cheap and deterministic.
4. Safe notification/activity surfaces for generated suggestions.
5. Optional embedding-backed duplicate detection.
6. Optional paid-AI sprint planning after the safe foundation is complete.

The first production-grade version should prioritize:

- Safety.
- Idempotency.
- Low cost.
- Workspace isolation.
- Clear user confirmation.
- Observability.

---

## 4. Non-Goals

20D must not:

- Silently assign issues.
- Silently change priority.
- Silently add or remove labels.
- Silently move issues into cycles.
- Delete anything.
- Change billing, workspace settings, roles, or API keys.
- Run broad AI reasoning over entire workspaces on every event.
- Expose private workspace data across tenants.
- Depend on the frontend being open.

---

## 5. Core Features

### 5.1 Auto-Assignee Suggestions

Trigger:

- Issue created without `assigneeId`.
- Issue updated and assignee is still empty.

Output:

- Suggest 1 to 3 candidate assignees.
- Include confidence and explanation.

Inputs:

- Issue title.
- Issue description.
- Project.
- Team.
- Existing assignee distribution.
- Recent related issues.
- Project/team membership.

Rules first:

- Prefer project lead if no better signal.
- Prefer team members over workspace-wide members.
- Prefer users who completed similar labels/issues.
- Penalize users with high active issue counts.
- Never suggest guests if they cannot own work.

AI fallback:

- Only if rule scoring cannot produce a confident result.
- Use compact context: issue summary plus 5 to 10 candidate member summaries.

Acceptance:

- A user/admin can accept the suggestion to assign the issue.
- Accepting must call the normal issue update service and permission checks.

### 5.2 Duplicate Detection

Trigger:

- Issue created.
- Issue title/description materially updated.

Output:

- Possible duplicate issue suggestions.
- Top 3 matches.
- Confidence/similarity score.

Preferred implementation:

- Use embeddings with pgvector.
- No chat model call required.

Fallback before pgvector:

- Use text similarity and keyword matching.
- Compare normalized title and description against recent/open issues in same workspace.

Important:

- Duplicate suggestions should never block issue creation.
- Similarity should be workspace-scoped.
- Closed/done issues can be included but should be labeled as completed.

### 5.3 Smart Label Suggestions

Trigger:

- Issue created.
- Issue title/description updated.
- Workspace labels changed.

Output:

- Suggested existing labels.
- Optional "new label candidate" suggestions only for admins/owners.

Rules first:

- Keyword matching against existing label names.
- Keyword aliases in a local map.
- Existing issue history: if similar titles used label X, suggest X.

AI fallback:

- Only when existing labels exist but rules find no clear match.
- Return existing label IDs only. Do not trust model-created label names as IDs.

Acceptance:

- User can accept suggested labels if they have permission to label issues.
- Creating new labels remains admin/owner-only.

### 5.4 Priority Suggestions

Trigger:

- Issue created with default/medium priority.
- Issue updated with urgent language.

Output:

- Suggested priority.
- Explanation.

Rules:

```text
urgent:
  crash, outage, production down, data loss, security, critical, urgent, asap

high:
  broken, failing, regression, cannot, blocked, error, payment issue

low:
  nice to have, polish, enhancement, eventually, minor
```

AI fallback:

- Not required for V1.
- If added later, use a cheap classifier model and strict JSON schema.

Acceptance:

- User can accept to update priority through the existing issue update flow.

### 5.5 Stale Issue Detection

Trigger:

- Daily cron job.

Definition V1:

- Issue status is in-progress/review-like.
- No issue update, comment, activity, or status movement for more than 7 days.
- Issue is not completed.

Output:

- Suggestion or notification to assignee and project/team lead.

Rules:

- Do not notify repeatedly every day.
- Use cooldown per issue, for example 3 to 7 days.
- Do not notify for archived/completed/canceled work.

### 5.6 Weekly Digest

Trigger:

- Weekly cron job.

Output:

- Workspace or team digest notification.

V1 should be template-based from database aggregates:

- Issues completed this week.
- Issues created this week.
- Overdue issues.
- Stale issues.
- Top blockers.
- Cycle progress.

AI prose generation is optional and should come after template digest works.

### 5.7 Sprint Planning Assist

Trigger:

- New cycle created.
- Manual "Generate sprint suggestions" action in cycle UI.

Output:

- Suggested issue candidates for the cycle.
- Reasoning: priority, age, dependencies, workload, project goals.

Rules first:

- Include open high/urgent issues.
- Include overdue issues.
- Include issues with no blockers.
- Avoid issues already in another active cycle.
- Respect team/project scope.
- Use team capacity if available.

AI use:

- This is the main paid/reasoning-heavy 20D feature.
- It should be plan-gated if needed.
- It must return suggestions only.

Acceptance:

- User can add selected issues to the cycle.
- Applying must use existing cycle/issue services with permission checks.

---

## 6. Architecture Overview

```text
Product event
  -> Service writes normal data
  -> Service enqueues background job after commit
  -> Worker loads minimal workspace-scoped context
  -> Rules/AI/embedding logic creates suggestions
  -> Suggestions saved with idempotency key
  -> Notification/activity emitted
  -> User views suggestion
  -> User accepts/dismisses
  -> Existing domain service applies accepted action
```

The queue must never be required for the original user action to succeed.

If the queue is down:

- Issue creation still works.
- A warning is logged.
- No user-facing 500 should occur because background intelligence failed.

---

## 7. Suggested Backend File Structure

Keep the existing modular monolith rules. 20D is complex enough to justify sub-files inside `modules/ai/`.

```text
modules/ai/
├── ai.background.ts              # Orchestrates background intelligence jobs
├── ai.suggestions.ts             # Suggestion CRUD, accept, dismiss
├── ai.rules.ts                   # Free rule-based priority/type/label logic
├── ai.embeddings.ts              # Embedding generation + similarity search
├── ai.jobs.ts                    # Queue names, enqueue helpers, job payload types
├── ai.worker.ts                  # Worker processor entrypoint
├── ai.cron.ts                    # Daily/weekly scheduled job registration
├── ai.controller.ts              # Add suggestions endpoints
├── ai.routes.ts                  # Add suggestions routes
├── ai.schemas.ts                 # Add suggestion schemas
└── docs/
    └── phase20d-background-ai-guide.md
```

If workers are run from a separate process, add:

```text
workers/
└── ai-background.worker.ts       # Starts queue worker using modules/ai/ai.worker.ts
```

If the project already has an `infra/queue` folder later, queue client code should live there:

```text
infra/queue/
├── redis.ts
├── queues.ts
└── worker.ts
```

---

## 8. Proposed Database Models

### 8.1 AiSuggestion

Stores passive intelligence outputs.

```prisma
enum AiSuggestionType {
  ASSIGNEE
  DUPLICATE
  LABEL
  PRIORITY
  STALE_ISSUE
  WEEKLY_DIGEST
  SPRINT_PLANNING
}

enum AiSuggestionStatus {
  OPEN
  ACCEPTED
  DISMISSED
  EXPIRED
  SUPERSEDED
}

enum AiSuggestionSource {
  RULE
  EMBEDDING
  AI_MODEL
  SQL
  TEMPLATE
}

model AiSuggestion {
  id              String             @id @default(uuid())
  workspaceId     String
  type            AiSuggestionType
  status          AiSuggestionStatus @default(OPEN)
  source          AiSuggestionSource

  targetType      String             // "issue", "cycle", "workspace", "team"
  targetId        String

  title           String
  message         String             @db.Text
  confidence      Float?
  reason          String?            @db.Text
  payload         Json

  dedupeKey       String
  model           String?
  inputTokens     Int                @default(0)
  outputTokens    Int                @default(0)

  createdByUserId String?
  acceptedById    String?
  dismissedById   String?
  acceptedAt      DateTime?
  dismissedAt     DateTime?
  expiresAt       DateTime?

  createdAt       DateTime           @default(now())
  updatedAt       DateTime           @updatedAt

  workspace       Workspace          @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, dedupeKey])
  @@index([workspaceId, status, type])
  @@index([workspaceId, targetType, targetId])
  @@index([workspaceId, createdAt])
}
```

Payload examples:

Assignee:

```json
{
  "issueId": "TRS-42",
  "candidates": [
    {
      "userId": "user_123",
      "name": "Sarah",
      "score": 0.86,
      "reasons": ["Project lead", "Completed 4 related auth issues", "Low current workload"]
    }
  ]
}
```

Duplicate:

```json
{
  "issueId": "TRS-42",
  "matches": [
    {
      "issueId": "TRS-12",
      "title": "Google login crashes on Android",
      "similarity": 0.91,
      "status": "IN_PROGRESS"
    }
  ]
}
```

Label:

```json
{
  "issueId": "TRS-42",
  "labels": [
    { "labelId": "label_1", "name": "authentication", "confidence": 0.88 }
  ]
}
```

Priority:

```json
{
  "issueId": "TRS-42",
  "currentPriority": "medium",
  "suggestedPriority": "urgent",
  "matchedSignals": ["production down", "data loss"]
}
```

### 8.2 AiEmbedding

Stores vector embeddings for duplicate detection and future semantic search.

Prisma support for pgvector commonly uses `Unsupported("vector(1536)")`.

```prisma
enum AiEmbeddingEntityType {
  ISSUE
  COMMENT
  DOCUMENT
}

model AiEmbedding {
  id          String                @id @default(uuid())
  workspaceId String
  entityType  AiEmbeddingEntityType
  entityId    String
  contentHash String
  content     String                @db.Text
  embedding   Unsupported("vector(1536)")
  model       String
  createdAt   DateTime              @default(now())
  updatedAt   DateTime              @updatedAt

  workspace   Workspace             @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, entityType, entityId])
  @@index([workspaceId, entityType])
  @@index([workspaceId, entityId])
}
```

Migration must enable pgvector:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Add vector index manually in migration SQL:

```sql
CREATE INDEX "AiEmbedding_embedding_idx"
ON "AiEmbedding"
USING ivfflat ("embedding" vector_cosine_ops)
WITH (lists = 100);
```

Important:

- Keep `workspaceId` in every embedding row.
- Never search embeddings without `workspaceId`.
- Store `contentHash` so unchanged issue text does not regenerate embeddings.

### 8.3 AiJobRun (Optional But Recommended)

Tracks background run health and debugging.

```prisma
enum AiJobRunStatus {
  STARTED
  SUCCEEDED
  FAILED
  SKIPPED
}

model AiJobRun {
  id          String         @id @default(uuid())
  workspaceId String?
  jobName     String
  jobId       String?
  status      AiJobRunStatus
  targetType  String?
  targetId    String?
  errorCode   String?
  errorMessage String?       @db.Text
  metadata    Json?
  startedAt   DateTime       @default(now())
  finishedAt  DateTime?

  @@index([workspaceId, jobName, startedAt])
  @@index([jobName, status, startedAt])
}
```

This is useful for production support but can be delayed if the queue dashboard/logging is enough for V1.

---

## 9. Queue And Worker Design

Use BullMQ with Redis.

Queue names:

```text
ai.issue-intelligence
ai.embeddings
ai.stale-scan
ai.weekly-digest
ai.sprint-planning
```

Job payloads must be small and contain IDs, not large snapshots.

Example:

```ts
type IssueIntelligenceJob = {
  workspaceId: string;
  issueId: string;
  triggeredByUserId?: string;
  reason: "created" | "updated";
};
```

Worker loads fresh data from DB using `workspaceId`.

Rules:

- Jobs must be idempotent.
- Jobs must be retry-safe.
- Jobs must not assume data still exists.
- Jobs must stop gracefully if issue/cycle/workspace was deleted.
- Jobs must log structured errors.
- Jobs must never throw user-facing errors because they run after the user action.

Recommended BullMQ settings:

```ts
{
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: { age: 86400, count: 1000 },
  removeOnFail: { age: 604800, count: 5000 }
}
```

---

## 10. Event Triggers

### 10.1 Issue Created

After issue creation succeeds:

```text
IssueService.createIssue
  -> DB transaction creates issue
  -> after transaction, enqueue ai.issue-intelligence
  -> after transaction, enqueue ai.embeddings
```

Jobs:

- Priority suggestion.
- Label suggestion.
- Assignee suggestion.
- Duplicate detection.
- Embedding generation.

Important:

- Do not enqueue inside a transaction if the transaction could roll back.
- If enqueue fails, log warning and return issue creation success.

### 10.2 Issue Updated

If title or description changes:

- Enqueue label suggestion.
- Enqueue priority suggestion.
- Enqueue duplicate detection.
- Enqueue embedding refresh.

If assignee changes:

- Supersede open assignee suggestions for that issue.

If priority changes:

- Supersede open priority suggestions for that issue.

If labels change:

- Supersede matching open label suggestions.

### 10.3 Cycle Created

After cycle creation succeeds:

- Enqueue sprint planning suggestion job.

Only run paid-AI sprint planning if:

- Workspace plan allows it.
- AI budget allows it.
- Cycle has enough context.

Otherwise use rule-based candidate selection.

### 10.4 Daily Cron

Runs stale issue scan.

Scope:

- All active workspaces.
- Or batched workspace pages to avoid huge scans.

Output:

- Stale issue suggestions and notifications.

### 10.5 Weekly Cron

Runs weekly digest.

Scope:

- Workspace digest for owners/admins.
- Optional team digest for team members/leads.

Output:

- Notification or digest record.

---

## 11. Idempotency Rules

Every suggestion needs a deterministic `dedupeKey`.

Examples:

```text
assignee:issue:<issueId>:version:<issueUpdatedAtIso>
duplicate:issue:<issueId>:match:<matchedIssueId>
label:issue:<issueId>:label:<labelId>:version:<issueUpdatedAtIso>
priority:issue:<issueId>:priority:<suggestedPriority>:version:<issueUpdatedAtIso>
stale:issue:<issueId>:week:<YYYY-WW>
weekly-digest:workspace:<workspaceId>:week:<YYYY-WW>
sprint-planning:cycle:<cycleId>:version:<cycleUpdatedAtIso>
```

When creating a suggestion:

- Use `upsert` on `(workspaceId, dedupeKey)`.
- Do not create duplicate open suggestions.
- If the target state already changed, skip or supersede old suggestions.

---

## 12. Suggestion Lifecycle

Statuses:

- `OPEN`: visible and actionable.
- `ACCEPTED`: user accepted and action was applied.
- `DISMISSED`: user dismissed it.
- `EXPIRED`: no longer relevant because time passed.
- `SUPERSEDED`: target state changed and suggestion is outdated.

Lifecycle:

```text
Worker creates OPEN suggestion
  -> notification/activity created
  -> user accepts
      -> permission check
      -> domain service applies action
      -> suggestion ACCEPTED
  -> user dismisses
      -> suggestion DISMISSED
  -> issue changes before user acts
      -> suggestion SUPERSEDED
  -> expiresAt passes
      -> suggestion EXPIRED
```

---

## 13. API Contract

### GET /ai/suggestions

List open suggestions for current workspace.

Auth:

- `authenticate`
- `requireWorkspace`

Query:

```ts
{
  status?: "OPEN" | "ACCEPTED" | "DISMISSED" | "EXPIRED" | "SUPERSEDED";
  type?: AiSuggestionType;
  targetType?: string;
  targetId?: string;
  limit?: number;
  cursor?: string;
}
```

Response:

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "type": "DUPLICATE",
      "status": "OPEN",
      "targetType": "issue",
      "targetId": "TRS-42",
      "title": "Possible duplicate issue",
      "message": "This looks similar to TRS-12.",
      "confidence": 0.91,
      "payload": {},
      "createdAt": "2026-06-22T00:00:00.000Z"
    }
  ],
  "meta": {
    "hasMore": false,
    "cursor": null
  }
}
```

Visibility:

- Only return suggestions for entities the user can access.
- For V1, workspace-level suggestions can be visible to members unless sensitive.
- Admin-only suggestion types should be filtered for non-admins.

### POST /ai/suggestions/:id/accept

Accept and apply a suggestion.

Auth:

- `authenticate`
- `requireWorkspace`

Body:

```json
{
  "selectedIds": ["optional-sub-selection"]
}
```

Examples:

- For label suggestions, selected IDs are label IDs.
- For duplicate suggestions, accept may mark/link duplicate or simply dismiss after user confirms.
- For assignee suggestions, selected ID is user ID.

Rules:

- Re-load suggestion from DB by `id` and `workspaceId`.
- Verify status is `OPEN`.
- Verify target still exists.
- Verify user has permission to apply the underlying change.
- Apply through existing domain service.
- Mark suggestion as `ACCEPTED`.
- Write activity log.

### POST /ai/suggestions/:id/dismiss

Dismiss suggestion.

Body:

```json
{
  "reason": "not_relevant"
}
```

Rules:

- Any user who can see the suggestion can dismiss user-targeted suggestions.
- Admin-only/workspace-wide suggestions may require admin/owner.

### POST /ai/suggestions/run

Manual trigger for admins/dev use.

Auth:

- `authenticate`
- `requireWorkspace`
- `requireRole("ADMIN", "OWNER")`

Body:

```json
{
  "targetType": "issue",
  "targetId": "TRS-42",
  "jobs": ["labels", "priority", "duplicate", "assignee"]
}
```

Use only for:

- Debugging.
- Admin re-run.
- Backfill.

---

## 14. Frontend Scope

20D needs a small but polished UI surface.

Recommended V1 surfaces:

### 14.1 Issue Detail Intelligence Panel

Show suggestions related to the current issue:

- Duplicate warnings.
- Suggested labels.
- Suggested priority.
- Suggested assignee.
- Stale warning.

UX:

- Compact cards.
- Clear confidence and reason.
- Buttons: Accept, Dismiss.
- Loading and empty states.
- Keyboard accessible.

### 14.2 Workspace Notification Integration

Create notifications for important suggestions:

- Possible duplicate.
- Stale issue.
- Sprint planning ready.
- Weekly digest ready.

Notification click should route to the target issue/cycle/suggestion.

### 14.3 Suggestions Center (Optional V1, Recommended V2)

Add a page or panel:

```text
/ai/suggestions
```

Filters:

- Type.
- Status.
- Target.
- Created date.

This is useful for admins/owners.

### 14.4 Cycle Planning UI

On cycle detail:

- Show "Suggested issues for this cycle".
- Let user select issues.
- Apply selected issues to cycle using existing cycle/issue APIs.

---

## 15. Security Requirements

### 15.1 Workspace Isolation

Every DB query must include `workspaceId`.

Correct:

```ts
prisma.issue.findMany({ where: { workspaceId, status: "IN_PROGRESS" } });
```

Wrong:

```ts
prisma.issue.findMany({ where: { status: "IN_PROGRESS" } });
```

### 15.2 Permission Checks

Generating a suggestion is not the same as applying it.

Generation:

- Runs as system.
- Must still be workspace-scoped.
- Must avoid sensitive leakage.

Application:

- Runs as the accepting user.
- Must use normal permission checks.
- Must call existing services where possible.

### 15.3 Private Project/Team Visibility

Suggestions about private projects/teams must not leak to users who cannot access them.

When listing suggestions:

- Join/check target entity visibility.
- Hide suggestions the user cannot see.

### 15.4 AI Prompt Safety

If AI is used:

- Send minimal context only.
- Treat issue text as untrusted.
- Use strict JSON schemas.
- Validate all model output.
- Never use model output as IDs unless IDs came from trusted lookup tables.

### 15.5 No Silent Mutation

Workers create suggestions, not business changes.

Exception:

- Embedding rows can be written automatically.
- Job run logs can be written automatically.
- Suggestion status can be superseded automatically.

---

## 16. Observability

Every 20D job should log:

- Job name.
- Workspace ID.
- Target type and ID.
- Duration.
- Success/failure.
- Suggestions created.
- Tokens used.
- Model used.
- Error code/message.

Suggested log event names:

```text
ai_background_job_started
ai_background_job_succeeded
ai_background_job_failed
ai_suggestion_created
ai_suggestion_skipped
ai_suggestion_accepted
ai_suggestion_dismissed
ai_embedding_created
ai_duplicate_detected
```

Metrics to track:

- Jobs processed.
- Jobs failed.
- Average job latency.
- Suggestions created by type.
- Suggestions accepted by type.
- Suggestions dismissed by type.
- AI token cost by workspace.
- Embedding generation count.

---

## 17. Cost Control

Use this order:

1. SQL/rules.
2. Embeddings.
3. Cheap AI model.
4. Expensive AI model only for sprint planning or ambiguous cases.

Hard rules:

- No AI call for stale detection.
- No AI call for priority suggestion V1.
- No AI call for duplicate detection once embeddings exist.
- No AI call for weekly digest V1.
- No AI call if workspace plan/budget blocks it.

Budget integration:

- Record token usage via existing AI usage tracking.
- Track per workspace and per user where there is an initiating user.
- For cron/system jobs, use `createdByUserId = null` and workspace-level usage.

---

## 18. Rollout Plan

### Step 1 - Suggestion Model And APIs

Build:

- `AiSuggestion` Prisma model.
- List suggestions endpoint.
- Accept endpoint.
- Dismiss endpoint.
- Basic frontend issue detail suggestion card.

No AI required.

### Step 2 - Rule-Based Suggestions

Build:

- Priority suggestion.
- Label suggestion from existing labels.
- Basic assignee scoring.

Trigger:

- Issue created.
- Issue updated.

### Step 3 - Background Queue

Build:

- BullMQ setup.
- Enqueue helpers.
- Worker processor.
- Retry/idempotency.

Move Step 2 logic into jobs.

### Step 4 - Stale Issue Detection

Build:

- Daily stale scan.
- Suggestion generation.
- Notifications.

### Step 5 - Embeddings

Build:

- pgvector migration.
- `AiEmbedding` model/table.
- Embedding generation job.
- Similarity search.
- Duplicate suggestions.

### Step 6 - Weekly Digest

Build:

- Weekly cron.
- Template-based summaries.
- Notification and digest view.

### Step 7 - Sprint Planning Assist

Build:

- Rule-based sprint candidate ranking.
- Optional AI reasoning.
- Cycle detail UI.
- Apply selected issues to cycle.

---

## 19. Edge Cases

Handle these explicitly:

- Issue deleted before job runs.
- Workspace deleted before job runs.
- User removed from workspace before accepting suggestion.
- Suggested assignee no longer belongs to workspace.
- Suggested label deleted before acceptance.
- Issue priority manually changed before suggestion acceptance.
- Duplicate target issue closed/deleted before user views suggestion.
- Queue retry tries to create duplicate suggestion.
- AI provider timeout.
- Redis unavailable.
- pgvector extension unavailable locally.
- Existing issue has empty description.
- Very large descriptions.
- Private project issue suggestion visible to unauthorized user.
- Weekly digest for workspace with no activity.
- Stale issue notification spam.

---

## 20. Acceptance Logic By Suggestion Type

### ASSIGNEE

Accept:

- Verify selected user is still workspace member.
- Verify selected user can be assigned to target issue/project/team.
- Call issue assignment/update service.
- Mark accepted.

Dismiss:

- Mark dismissed.

### DUPLICATE

Accept V1:

- Mark suggestion accepted.
- Optionally add a comment: "Possible duplicate of TRS-12."
- Do not auto-close issue in V1.

Future:

- Add issue relation type `DUPLICATES`.

### LABEL

Accept:

- Verify labels still exist in workspace.
- Verify user can label issue.
- Attach selected labels.
- Mark accepted.

### PRIORITY

Accept:

- Verify issue still exists.
- Verify user can update issue.
- Update priority.
- Mark accepted.

### STALE_ISSUE

Accept options:

- Add comment.
- Mark as acknowledged.
- Reassign.
- Move status.

V1:

- Accept means "acknowledged" only, unless a specific action is selected.

### WEEKLY_DIGEST

Accept:

- Not applicable.

Dismiss:

- Dismiss/hide.

### SPRINT_PLANNING

Accept:

- Add selected issues to cycle.
- Verify user can manage cycle/project scope.
- Mark accepted.

---

## 21. Testing Requirements

Backend tests:

- Suggestion creation is idempotent.
- Suggestions are workspace-scoped.
- User cannot list suggestions from another workspace.
- User cannot accept suggestion without permission.
- Accepting stale suggestion fails safely.
- Dismissing works.
- Issue-created trigger enqueues jobs.
- Worker handles missing issue without crashing.
- Duplicate detection only searches same workspace.
- Private project suggestions are not visible to unauthorized members.

Frontend tests:

- Empty state.
- Loading state.
- Error state.
- Accept action success.
- Accept action permission failure.
- Dismiss action.
- Malformed suggestion payload does not crash UI.

Manual QA:

- Create issue with urgent text.
- Create issue without assignee.
- Create issue similar to existing issue.
- Update issue title/description.
- Run stale scan.
- Run weekly digest.
- Create cycle and generate sprint suggestions.

---

## 22. Done Criteria

20D is done when:

- Background job infrastructure is reliable.
- Suggestions are stored durably.
- Suggestions are idempotent.
- Suggestions can be listed, accepted, and dismissed.
- Priority suggestions work without AI.
- Label suggestions work without AI.
- Assignee suggestions work with rules.
- Stale issue detection works via cron.
- Duplicate detection works via pgvector or documented V1 fallback.
- Weekly digest exists or is explicitly deferred.
- Sprint planning assist exists or is explicitly deferred.
- Notifications/activity are emitted for important suggestions.
- Accepting suggestions uses existing domain services and permission checks.
- Token usage is tracked for AI-backed jobs.
- No worker failure breaks user-facing issue/cycle flows.
- All workspace-scoped queries include `workspaceId`.
- Production rollout steps are documented.

---

## 23. Recommended V1 Scope

If building 20D now, start with this practical V1:

1. `AiSuggestion` model.
2. Suggestion list/accept/dismiss APIs.
3. Issue detail suggestion cards.
4. Rule-based priority suggestions.
5. Rule-based label suggestions.
6. Basic assignee suggestions.
7. Daily stale issue suggestions.
8. Queue foundation.

Defer until V2:

- pgvector duplicate detection.
- Weekly digest prose generation.
- AI-backed sprint planning.
- Cross-entity semantic search.

Reason:

- V1 gives visible product value with low cost.
- V1 establishes the safety model.
- V2 can add heavier AI once suggestions, permissions, and workers are stable.

---

## 24. Notes For AI Agents

When implementing this phase:

- Do not change 20C back into a planner or operator.
- Do not add automatic mutations in workers.
- Do not call Prisma from controllers.
- Do not skip `workspaceId`.
- Do not trust IDs from AI output.
- Do not expose delete operations.
- Prefer deterministic rules over model calls.
- Add idempotency before adding retries.
- Keep user-facing flows working if Redis or AI is down.
- Use existing services for accepted actions.
- Keep frontend UI minimal, accessible, and consistent with current SaaS design.

