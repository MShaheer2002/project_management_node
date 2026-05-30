# Phase 11 Backend Contract (Cycles)

This document translates Phase 11 from [build-phases.md](./build-phases.md) into a production-grade backend contract for cycles.

Phase 0 through Phase 10 are assumed complete.

## Goal

Deliver team-scoped cycles as the time-boxed execution layer for Linearis.

Cycles organize issues into predictable work windows. They are equivalent to sprint-style planning, but must stay aligned with the product model:

- issues are the atomic work unit
- projects and cycles both organize issues
- projects represent product goals or work containers
- cycles represent a team execution window
- a cycle can include issues from multiple projects within the same team/workspace

This phase must support:

- cycle list and detail UI
- current/upcoming/completed cycle states
- cycle progress and scope breakdown
- issue planning into a cycle
- issue removal from a cycle
- carry-over unfinished issues
- completion flow with explicit carry-over decision
- activity events for every cycle operation
- notifications where cycle actions affect users
- realtime socket updates for cycle screens

## Dependency and Scope

Depends on:

- Phase 3 (teams and departments)
- Phase 4 (projects)
- Phase 5 (issues)
- Phase 8 (activity)
- Phase 9 (notifications)
- Phase 10 (realtime)

In scope:

- cycle DB model and issue relation
- REST endpoints for CRUD and lifecycle actions
- issue assignment/removal to/from cycles
- cycle detail summary and analytics
- cycle activity integration
- cycle notification triggers
- socket event payloads

Out of scope:

- advanced velocity forecasts
- burndown charts
- recurring auto-created cycles
- capacity planning per member
- billing limits for cycles
- templates for cycle setup

## Frontend Surfaces Impacted

- cycle list page: `src/pages/CyclesPage.tsx`
- cycle detail page: `src/pages/CycleDetailPage.tsx`
- issue create/edit cycle selector
- issue detail sidebar cycle field
- project/team activity feeds
- notification inbox and realtime toast
- dashboard widgets once real analytics consume cycle data

## Domain Model

## Cycle

A cycle belongs to one workspace and one team.

```ts
type CycleStatus = 'UPCOMING' | 'CURRENT' | 'COMPLETED';

type Cycle = {
  id: string; // uuid
  workspaceId: string;
  teamId: string;
  name: string; // "Cycle 14"
  number: number; // team-scoped sequence number
  description: string | null;
  goal: string | null;
  startsAt: string; // ISO date-time
  endsAt: string; // ISO date-time
  status: CycleStatus;
  completedAt: string | null;
  completedById: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
};
```

## Issue Cycle Relation

An issue can belong to at most one active/planned cycle at a time.

Preferred implementation:

- add nullable `cycleId` to `Issue`
- keep historical movements in Activity

```ts
type IssueCycleFields = {
  cycleId: string | null;
};
```

Recommended Prisma shape:

```prisma
model Cycle {
  id            String       @id @default(uuid())
  workspaceId   String
  teamId        String
  name          String
  number        Int
  description   String?
  goal          String?
  startsAt      DateTime
  endsAt        DateTime
  status        CycleStatus  @default(UPCOMING)
  completedAt   DateTime?
  completedById String?
  createdById   String
  createdAt     DateTime     @default(now())
  updatedAt     DateTime     @updatedAt

  workspace     Workspace    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  team          Team         @relation(fields: [teamId], references: [id], onDelete: Cascade)
  issues        Issue[]

  @@unique([teamId, number])
  @@index([workspaceId, teamId, status])
  @@index([workspaceId, startsAt, endsAt])
}

enum CycleStatus {
  UPCOMING
  CURRENT
  COMPLETED
}

model Issue {
  id        String  @id @default(uuid())
  cycleId   String?
  cycle     Cycle?  @relation(fields: [cycleId], references: [id], onDelete: SetNull)
}
```

## Lifecycle Rules

## Status Rules

- `UPCOMING`: cycle is planned but not active
- `CURRENT`: cycle is the team’s active execution window
- `COMPLETED`: cycle has been closed

Rules:

- a team can have only one `CURRENT` cycle at a time
- `startsAt` must be before `endsAt`
- cycles for the same team should not overlap unless explicitly allowed by an admin-level configuration; default is no overlap
- completed cycles are immutable for dates/team/name unless reopened by owner/admin
- completing a cycle never silently moves unfinished issues
- carry-over requires explicit API action

## Issue Planning Rules

- only issues from the same workspace can be assigned
- issue team must match cycle team
- completed issues can remain in completed cycles
- assigning an issue to a new cycle removes it from the previous cycle
- moving an issue into a completed cycle is blocked by default

## Permissions

Use `authenticate`, `requireWorkspace`, and role guards.

| Action | Owner | Admin | Member | Guest |
|---|---:|---:|---:|---:|
| List/view cycles | Yes | Yes | Yes | Yes |
| Create cycle | Yes | Yes | Yes | No |
| Edit upcoming/current cycle | Yes | Yes | Yes | No |
| Delete upcoming cycle | Yes | Yes | Lead/member creator | No |
| Complete cycle | Yes | Yes | Yes | No |
| Reopen completed cycle | Yes | Yes | No | No |
| Plan/remove issues | Yes | Yes | Yes | No |
| Carry over unfinished issues | Yes | Yes | Yes | No |

Recommended contextual rule:

- members can manage cycles for teams they belong to
- guests are read-only
- owner/admin can manage all cycles in the workspace

## Standard Response Format

All endpoints must use the existing API response format:

```json
{
  "success": true,
  "data": {}
}
```

Errors:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "details": []
  }
}
```

## Shared Types

## Cycle Summary

Used by list page cards.

```ts
type CycleSummary = Cycle & {
  team: {
    id: string;
    name: string;
  };
  stats: CycleStats;
};
```

## Cycle Detail

Used by detail overview.

```ts
type CycleDetail = CycleSummary & {
  createdBy: UserSummary;
  completedBy?: UserSummary | null;
  issueBreakdown: CycleIssueBreakdown;
  rules: {
    carryOverRequired: boolean;
    unfinishedIssueCount: number;
    canComplete: boolean;
    canEditDates: boolean;
    canCarryOver: boolean;
  };
};
```

## Cycle Stats

```ts
type CycleStats = {
  totalIssues: number;
  completedIssues: number;
  inProgressIssues: number;
  todoIssues: number;
  backlogIssues: number;
  reviewIssues: number;
  unfinishedIssues: number;
  progress: number; // 0-100, completedIssues / totalIssues
  daysTotal: number;
  daysElapsed: number;
  daysRemaining: number;
  timeElapsedPercent: number; // 0-100
};
```

## Cycle Issue Breakdown

```ts
type CycleIssueBreakdown = {
  byStatus: Array<{
    status: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
    label: string;
    count: number;
  }>;
  byPriority: Array<{
    priority: 'low' | 'medium' | 'high' | 'urgent';
    count: number;
  }>;
  byType: Array<{
    type: 'task' | 'bug' | 'issue';
    count: number;
  }>;
  byProject: Array<{
    projectId: string;
    projectName: string;
    count: number;
    completedCount: number;
  }>;
};
```

## User Summary

```ts
type UserSummary = {
  id: string;
  name: string;
  email?: string;
  avatar?: string | null;
};
```

## Issue Summary For Cycle

Cycle issues should use the same issue shape already returned by the issue directory when possible.

Required fields for cycle UI:

```ts
type CycleIssueSummary = {
  id: string; // public id, e.g. LIN-214
  entityId?: string; // uuid if separate from id
  title: string;
  description?: string | null;
  type: 'task' | 'bug' | 'issue';
  status: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  labels: string[];
  dueDate?: string | null;
  project?: {
    id: string;
    name: string;
  } | null;
  team: {
    id: string;
    name: string;
  };
  assignee?: UserSummary | null;
  subtaskStats?: {
    total: number;
    completed: number;
  };
  createdAt: string;
  updatedAt: string;
};
```

## API Endpoints

Base path:

```txt
/cycles
```

All routes require:

- `Authorization: Bearer <Clerk JWT>`
- `x-workspace-id: <workspaceId>`

## List Cycles

```http
GET /cycles
```

Query:

```ts
type ListCyclesQuery = {
  teamId?: string;
  status?: 'UPCOMING' | 'CURRENT' | 'COMPLETED';
  q?: string;
  from?: string; // ISO date
  to?: string; // ISO date
  sort?: 'startsAt:asc' | 'startsAt:desc' | 'updatedAt:desc' | 'number:desc';
  cursor?: string;
  limit?: number; // default 30, max 100
};
```

Response:

```ts
type ListCyclesResponse = {
  success: true;
  data: CycleSummary[];
  meta: {
    nextCursor: string | null;
    hasMore: boolean;
  };
};
```

Notes:

- if `teamId` is omitted, return cycles for all teams visible to the user
- guests only see cycles for visible teams/projects
- default sort should place current/upcoming cycles before completed cycles for UI usefulness

## Get Current Cycle

```http
GET /cycles/current?teamId=<teamId>
```

Response:

```ts
type CurrentCycleResponse = {
  success: true;
  data: CycleDetail | null;
};
```

If no current cycle exists, return `data: null`, not `404`.

## Get Cycle Detail

```http
GET /cycles/:cycleId
```

Response:

```ts
type GetCycleResponse = {
  success: true;
  data: CycleDetail;
};
```

## Create Cycle

```http
POST /cycles
```

Body:

```ts
type CreateCycleBody = {
  teamId: string;
  name?: string; // optional, backend can generate "Cycle {number}"
  description?: string | null;
  goal?: string | null;
  startsAt: string;
  endsAt: string;
  status?: 'UPCOMING' | 'CURRENT';
};
```

Response:

```ts
type CreateCycleResponse = {
  success: true;
  data: CycleDetail;
};
```

Validation:

- `teamId` must belong to workspace
- `startsAt < endsAt`
- no overlapping cycles for team
- if `status=CURRENT`, no other current cycle for team
- generated `number` increments per team

Side effects:

- create `CYCLE_CREATED` activity
- emit `cycle:created` to `workspace:<workspaceId>`

## Update Cycle

```http
PATCH /cycles/:cycleId
```

Body:

```ts
type UpdateCycleBody = {
  name?: string;
  description?: string | null;
  goal?: string | null;
  startsAt?: string;
  endsAt?: string;
  status?: 'UPCOMING' | 'CURRENT';
};
```

Response:

```ts
type UpdateCycleResponse = {
  success: true;
  data: CycleDetail;
};
```

Validation:

- completed cycles cannot be edited except by `OWNER`/`ADMIN` through reopen flow
- date changes cannot overlap another cycle in the same team
- setting `CURRENT` must demote no other cycle silently; either block or require explicit `start` endpoint

Side effects:

- create field-level activity events, e.g. `CYCLE_DATES_CHANGED`, `CYCLE_GOAL_CHANGED`
- emit `cycle:updated`

## Delete Cycle

```http
DELETE /cycles/:cycleId
```

Response:

```json
{
  "success": true,
  "data": {
    "id": "cycle_uuid",
    "deleted": true,
    "unassignedIssueCount": 7
  }
}
```

Rules:

- deleting a completed cycle is blocked by default
- deleting a current cycle requires owner/admin or explicit force flag if implemented
- issues in deleted cycle must have `cycleId` set to `null`

Side effects:

- create `CYCLE_DELETED` activity
- emit `cycle:deleted`

## Start Cycle

```http
POST /cycles/:cycleId/start
```

Body:

```ts
type StartCycleBody = {
  replaceCurrent?: boolean; // default false
};
```

Response:

```ts
type StartCycleResponse = {
  success: true;
  data: CycleDetail;
};
```

Rules:

- if another current cycle exists and `replaceCurrent=false`, return conflict
- if `replaceCurrent=true`, old current cycle must be explicitly completed or moved back to upcoming based on backend policy; recommended: block unless old cycle is completed first

Recommended behavior:

- only allow start when no current cycle exists
- avoid implicit state changes

## Complete Cycle

```http
POST /cycles/:cycleId/complete
```

Body:

```ts
type CompleteCycleBody = {
  unfinishedAction: 'KEEP' | 'MOVE_TO_NEXT' | 'MOVE_TO_BACKLOG';
  targetCycleId?: string; // required for MOVE_TO_NEXT
};
```

Response:

```ts
type CompleteCycleResponse = {
  success: true;
  data: {
    cycle: CycleDetail;
    movedIssueCount: number;
    keptIssueCount: number;
    unfinishedIssueCount: number;
  };
};
```

Rules:

- completed issues remain in completed cycle
- unfinished issues are handled according to `unfinishedAction`
- `MOVE_TO_NEXT` requires target cycle in same team and not completed
- `MOVE_TO_BACKLOG` sets `cycleId=null`
- `KEEP` leaves unfinished issues attached for historical visibility

Side effects:

- create `CYCLE_COMPLETED` activity
- create `ISSUE_CYCLE_CHANGED` activity for moved issues
- notify assignees for moved unfinished issues when relevant
- emit `cycle:completed`, `cycle:updated`, and `issue:updated`

## Reopen Cycle

```http
POST /cycles/:cycleId/reopen
```

Response:

```ts
type ReopenCycleResponse = {
  success: true;
  data: CycleDetail;
};
```

Rules:

- owner/admin only
- cannot reopen if another current cycle exists unless reopened as `UPCOMING`
- default reopened status should be `UPCOMING`

Side effects:

- create `CYCLE_REOPENED` activity
- emit `cycle:updated`

## List Cycle Issues

```http
GET /cycles/:cycleId/issues
```

Query:

```ts
type ListCycleIssuesQuery = {
  q?: string;
  status?: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
  type?: 'task' | 'bug' | 'issue';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  projectId?: string;
  assigneeId?: string;
  departmentId?: string;
  view?: 'list' | 'board' | 'calendar';
  sort?: 'updatedAt:desc' | 'priority:desc' | 'dueDate:asc' | 'status:asc';
  cursor?: string;
  limit?: number;
};
```

Response:

```ts
type ListCycleIssuesResponse = {
  success: true;
  data: CycleIssueSummary[];
  meta: {
    nextCursor: string | null;
    hasMore: boolean;
  };
};
```

## Plan Issues Into Cycle

Bulk assignment endpoint used by the cycle planning UI.

```http
POST /cycles/:cycleId/issues
```

Body:

```ts
type PlanIssuesBody = {
  issueIds: string[]; // uuid or public ids; backend should support uuid primarily
};
```

Response:

```ts
type PlanIssuesResponse = {
  success: true;
  data: {
    cycle: CycleDetail;
    added: CycleIssueSummary[];
    skipped: Array<{
      issueId: string;
      reason: 'NOT_FOUND' | 'WRONG_TEAM' | 'COMPLETED_CYCLE' | 'NO_ACCESS' | 'ALREADY_IN_CYCLE';
    }>;
  };
};
```

Rules:

- issue team must match cycle team
- target cycle must not be completed
- moving from a previous cycle is allowed but must be recorded

Side effects:

- create `ISSUE_ADDED_TO_CYCLE` activity for each issue
- notify assignee when issue is planned into a current cycle
- emit `cycle:issues-added`

## Remove Issue From Cycle

```http
DELETE /cycles/:cycleId/issues/:issueId
```

Response:

```ts
type RemoveCycleIssueResponse = {
  success: true;
  data: {
    cycle: CycleDetail;
    removedIssue: CycleIssueSummary;
  };
};
```

Rules:

- cannot remove from completed cycle unless owner/admin
- removing issue sets `issue.cycleId=null`

Side effects:

- create `ISSUE_REMOVED_FROM_CYCLE` activity
- emit `cycle:issue-removed`

## Carry Over Unfinished Issues

Explicit carry-over action before or after completion.

```http
POST /cycles/:cycleId/carry-over
```

Body:

```ts
type CarryOverBody = {
  target: 'NEXT_CYCLE' | 'BACKLOG';
  targetCycleId?: string;
  issueIds?: string[]; // optional subset; omitted means all unfinished issues
};
```

Response:

```ts
type CarryOverResponse = {
  success: true;
  data: {
    sourceCycle: CycleDetail;
    targetCycle?: CycleDetail | null;
    movedIssues: CycleIssueSummary[];
    skipped: Array<{
      issueId: string;
      reason: string;
    }>;
  };
};
```

Rules:

- unfinished statuses are `backlog`, `todo`, `in-progress`, `review`
- `done` issues are never carried over
- target cycle must belong to same team
- target cycle cannot be completed

## Cycle Activity

Cycle activity must integrate with the Phase 8 activity system, but the cycle activity screen must show **only activity related to the selected cycle**.

Frontend contract:

```http
GET /activity?scope=cycle&scopeId=:cycleId
```

The response shape remains the Phase 8 activity list response.

The backend must support `scope=cycle` in the activity feed query.

### Cycle Activity Scope Rules

For `scope=cycle&scopeId=:cycleId`, include only:

- lifecycle events where the cycle itself is the primary target
- issue planning events for this cycle
- issue removal events for this cycle
- carry-over events where this cycle is source or target
- issue updates that occurred while the issue was assigned to this cycle
- comments created on issues while the issue was assigned to this cycle

Do not include:

- all workspace activity
- all team activity
- all project activity
- issue activity that happened before the issue was added to this cycle
- issue activity that happened after the issue was removed from this cycle
- activity for issues in the same project but not in this cycle

This is important because the cycle activity tab is a cycle audit trail, not a team feed.

### Required Activity Persistence Metadata

Every activity record that should be visible in a cycle feed must include `metadata.cycleId`.

For issue-related events, persist the cycle context active at event time:

```ts
type CycleActivityMetadata = {
  workspaceId: string;
  cycleId: string;
  cycleName: string;
  teamId: string;
  issueId?: string; // public issue id, e.g. LIN-214
  issueUuid?: string;
  projectId?: string | null;
  fromCycleId?: string | null;
  toCycleId?: string | null;
  fromStatus?: string;
  toStatus?: string;
};
```

Reason: if an issue moves between cycles later, old activity must remain attached to the cycle where it happened.

### Activity Query Implementation

Recommended filtering for `scope=cycle`:

```ts
where: {
  workspaceId,
  OR: [
    { targetType: 'cycle', targetId: cycleId },
    { metadata: { path: ['cycleId'], equals: cycleId } },
    { metadata: { path: ['sourceCycleId'], equals: cycleId } },
    { metadata: { path: ['targetCycleId'], equals: cycleId } }
  ]
}
```

If using PostgreSQL JSONB, add a GIN index for activity metadata if activity volume is expected to grow.

### Activity Types

Cycle actions must write to Phase 8 activity.

Required activity types:

```ts
type CycleActivityType =
  | 'CYCLE_CREATED'
  | 'CYCLE_UPDATED'
  | 'CYCLE_DATES_CHANGED'
  | 'CYCLE_GOAL_CHANGED'
  | 'CYCLE_STARTED'
  | 'CYCLE_COMPLETED'
  | 'CYCLE_REOPENED'
  | 'CYCLE_DELETED'
  | 'ISSUE_ADDED_TO_CYCLE'
  | 'ISSUE_REMOVED_FROM_CYCLE'
  | 'ISSUE_CARRIED_OVER'
  | 'ISSUE_CYCLE_CHANGED'
  | 'CYCLE_ISSUE_STATUS_CHANGED'
  | 'CYCLE_ISSUE_PRIORITY_CHANGED'
  | 'CYCLE_ISSUE_ASSIGNEE_CHANGED'
  | 'CYCLE_ISSUE_COMMENT_CREATED';
```

Activity target:

```ts
type CycleActivityTarget = {
  type: 'cycle' | 'issue';
  id: string;
  entityId?: string; // cycle number/name or issue public id where useful
  name?: string;
  url: string;
};
```

### Event Rules By Action

| Action | Activity type | Target | Required metadata |
|---|---|---|---|
| Create cycle | `CYCLE_CREATED` | `cycle` | `cycleId`, `cycleName`, `teamId` |
| Update cycle dates | `CYCLE_DATES_CHANGED` | `cycle` | `cycleId`, `fromStartsAt`, `toStartsAt`, `fromEndsAt`, `toEndsAt` |
| Update cycle goal | `CYCLE_GOAL_CHANGED` | `cycle` | `cycleId`, `fromGoal`, `toGoal` |
| Complete cycle | `CYCLE_COMPLETED` | `cycle` | `cycleId`, `unfinishedIssueCount`, `completedIssueCount` |
| Reopen cycle | `CYCLE_REOPENED` | `cycle` | `cycleId` |
| Add issue to cycle | `ISSUE_ADDED_TO_CYCLE` | `issue` | `cycleId`, `cycleName`, `issueId`, `issueUuid` |
| Remove issue from cycle | `ISSUE_REMOVED_FROM_CYCLE` | `issue` | `cycleId`, `cycleName`, `issueId`, `issueUuid` |
| Carry issue over | `ISSUE_CARRIED_OVER` | `issue` | `sourceCycleId`, `targetCycleId`, `issueId`, `issueUuid` |
| Issue status changed while in cycle | `CYCLE_ISSUE_STATUS_CHANGED` | `issue` | `cycleId`, `issueId`, `fromStatus`, `toStatus` |
| Issue priority changed while in cycle | `CYCLE_ISSUE_PRIORITY_CHANGED` | `issue` | `cycleId`, `issueId`, `fromPriority`, `toPriority` |
| Issue assignee changed while in cycle | `CYCLE_ISSUE_ASSIGNEE_CHANGED` | `issue` | `cycleId`, `issueId`, `fromAssignee`, `toAssignee` |
| Comment added while issue is in cycle | `CYCLE_ISSUE_COMMENT_CREATED` | `comment` | `cycleId`, `issueId`, `commentId` |

Issue-related cycle activity should be emitted in addition to the normal issue activity where appropriate. The same DB row can satisfy both feeds if metadata supports both `issueId` and `cycleId`.

Example:

```json
{
  "type": "ISSUE_CARRIED_OVER",
  "message": "Shaheer Project carried LIN-214 over to Cycle 15",
  "target": {
    "type": "issue",
    "id": "issue_uuid",
    "entityId": "LIN-214",
    "url": "/issues/issue_uuid"
  },
  "metadata": {
    "sourceCycleId": "cycle_13",
    "sourceCycleName": "Cycle 13",
    "targetCycleId": "cycle_15",
    "targetCycleName": "Cycle 15"
  }
}
```

## Notifications

Cycle operations should create notifications only when they affect a user’s actionable work.

Recommended notification triggers:

- issue assigned into current cycle -> notify assignee
- issue carried over to next cycle -> notify assignee
- issue removed from current cycle -> notify assignee
- cycle completed with unfinished assigned issue kept -> notify assignee optionally

Notification category:

- `update`

Example metadata:

```ts
type CycleNotificationMetadata = {
  cycleId: string;
  cycleName: string;
  issueId?: string; // public id, e.g. LIN-214
  issueUuid?: string;
  entityTitle?: string;
  fromCycleId?: string;
  toCycleId?: string;
  workspaceId: string;
  url: string;
};
```

## Realtime Events

Emit through Phase 10 socket envelope.

Workspace room:

- `cycle:created`
- `cycle:updated`
- `cycle:deleted`
- `cycle:completed`
- `cycle:issues-added`
- `cycle:issue-removed`
- `cycle:issues-carried-over`

Room:

- `workspace:<workspaceId>`

Payload:

```ts
type CycleRealtimePayload = {
  cycleId: string;
  teamId: string;
  publicName: string; // e.g. "Cycle 14"
  status: CycleStatus;
  stats?: CycleStats;
  issueIds?: string[];
  issues?: CycleIssueSummary[];
};
```

For issue changes, also emit:

- `issue:updated` to `workspace:<workspaceId>`
- `issue:updated` to `issue:<issueId>` if issue room exists

## Error Codes

Use existing global error shape.

Required cycle-specific codes:

| Code | HTTP | Meaning |
|---|---:|---|
| `CYCLE_NOT_FOUND` | 404 | Cycle does not exist or is not visible |
| `CYCLE_OVERLAP` | 409 | Dates overlap an existing cycle for same team |
| `CURRENT_CYCLE_EXISTS` | 409 | Team already has a current cycle |
| `CYCLE_COMPLETED` | 409 | Action is blocked because cycle is completed |
| `INVALID_CYCLE_DATES` | 422 | `startsAt`/`endsAt` are invalid |
| `WRONG_TEAM` | 422 | Issue and cycle belong to different teams |
| `TARGET_CYCLE_REQUIRED` | 422 | Carry-over needs target cycle |
| `TARGET_CYCLE_COMPLETED` | 422 | Target cycle is completed |
| `NO_CYCLE_ACCESS` | 403 | User cannot manage/view this cycle |

## Validation Schemas

Use Zod as source of truth.

Recommended files:

```txt
modules/cycle/
├── cycle.routes.ts
├── cycle.controller.ts
├── cycle.service.ts
├── cycle.schemas.ts
└── cycle.serializer.ts
```

Key schemas:

```ts
const createCycleSchema = z.object({
  body: z.object({
    teamId: z.string().uuid(),
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    goal: z.string().trim().max(240).nullable().optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    status: z.enum(['UPCOMING', 'CURRENT']).optional(),
  }),
});

const planIssuesSchema = z.object({
  params: z.object({ cycleId: z.string().uuid() }),
  body: z.object({
    issueIds: z.array(z.string()).min(1).max(100),
  }),
});

const completeCycleSchema = z.object({
  params: z.object({ cycleId: z.string().uuid() }),
  body: z.object({
    unfinishedAction: z.enum(['KEEP', 'MOVE_TO_NEXT', 'MOVE_TO_BACKLOG']),
    targetCycleId: z.string().uuid().optional(),
  }),
});
```

## Service Requirements

`cycle.service.ts` must own all business rules:

- workspace/team membership checks
- date overlap detection
- current cycle uniqueness
- cycle stats aggregation
- issue planning validation
- completion/carry-over transactional updates
- activity writes
- notification creation
- realtime emit dispatch

Critical mutations must be wrapped in a DB transaction:

- create current cycle
- start cycle
- complete cycle
- carry over issues
- plan/remove issues
- delete cycle with issue unassignment

## Query Performance

Required indexes:

- `Cycle(workspaceId, teamId, status)`
- `Cycle(workspaceId, startsAt, endsAt)`
- `Cycle(teamId, number)` unique
- `Issue(workspaceId, teamId, cycleId)`
- `Issue(cycleId, status)`

Stats should be aggregated in SQL/Prisma groupBy, not by loading all issues when issue count grows.

## Example Responses

## Cycle Detail

```json
{
  "success": true,
  "data": {
    "id": "6f48d205-496b-49e8-b4f5-8c3a905b8bb5",
    "workspaceId": "16570745-c2bd-49f2-a192-3b18f13738f0",
    "teamId": "team_uuid",
    "name": "Cycle 14",
    "number": 14,
    "description": null,
    "goal": "Stabilize notifications and realtime reliability",
    "startsAt": "2026-05-26T00:00:00.000Z",
    "endsAt": "2026-06-08T23:59:59.999Z",
    "status": "CURRENT",
    "completedAt": null,
    "completedById": null,
    "createdById": "user_123",
    "createdAt": "2026-05-20T12:00:00.000Z",
    "updatedAt": "2026-05-26T12:00:00.000Z",
    "team": {
      "id": "team_uuid",
      "name": "Engineering"
    },
    "stats": {
      "totalIssues": 24,
      "completedIssues": 11,
      "inProgressIssues": 8,
      "todoIssues": 5,
      "backlogIssues": 0,
      "reviewIssues": 0,
      "unfinishedIssues": 13,
      "progress": 46,
      "daysTotal": 14,
      "daysElapsed": 4,
      "daysRemaining": 10,
      "timeElapsedPercent": 29
    },
    "issueBreakdown": {
      "byStatus": [
        { "status": "done", "label": "Done", "count": 11 },
        { "status": "in-progress", "label": "In Progress", "count": 8 },
        { "status": "todo", "label": "Todo", "count": 5 }
      ],
      "byPriority": [],
      "byType": [],
      "byProject": []
    },
    "rules": {
      "carryOverRequired": true,
      "unfinishedIssueCount": 13,
      "canComplete": true,
      "canEditDates": true,
      "canCarryOver": true
    }
  }
}
```

## Done When

- [ ] Prisma migration adds `Cycle` and `Issue.cycleId`
- [ ] cycle CRUD routes are implemented with workspace/team authorization
- [ ] one current cycle per team is enforced
- [ ] date overlap validation exists
- [ ] cycle list returns summary stats for UI cards
- [ ] cycle detail returns stats, breakdown, rules, and permissions
- [ ] cycle issues endpoint supports list/board/calendar filters
- [ ] plan/remove issue endpoints update issue `cycleId`
- [ ] completion endpoint supports explicit unfinished issue handling
- [ ] carry-over endpoint supports next cycle/backlog movement
- [ ] activity events are written for cycle lifecycle and issue movement
- [ ] `/activity?scope=cycle&scopeId=:cycleId` returns only cycle-scoped activity
- [ ] issue/comment activity stores `metadata.cycleId` when event happens while assigned to a cycle
- [ ] cycle activity excludes issue events outside the issue's time in that cycle
- [ ] relevant notifications are created for assignees
- [ ] socket events are emitted for cycle and issue updates
- [ ] tests cover permissions, overlap, current uniqueness, carry-over, and completed-cycle guards
