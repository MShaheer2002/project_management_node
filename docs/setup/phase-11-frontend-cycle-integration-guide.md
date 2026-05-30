# Phase 11 Frontend Cycle Integration Guide

This document defines frontend integration for cycles (Phase 11), including lifecycle actions, issue planning, carry-over, notifications, and realtime updates.

Backend references:
- [phase-11-backend-setup-guide.md](./phase-11-backend-setup-guide.md)
- [phase11-backend-contract.md](./phase11-backend-contract.md)
- [phase-10-frontend-socket-notification-integration-guide.md](./phase-10-frontend-socket-notification-integration-guide.md)

## Preconditions

- Workspace auth flow is stable.
- Team/project/issue pages are integrated.
- Socket integration from Phase 10 is active.
- `X-Workspace-Id` is sent for all workspace-scoped calls.

## Routes

```txt
POST   /cycles
GET    /cycles
GET    /cycles/current
GET    /cycles/:id
PATCH  /cycles/:id
DELETE /cycles/:id
POST   /cycles/:id/complete
POST   /cycles/:id/reopen
POST   /cycles/:id/carry-over
POST   /issues/:id/cycle
DELETE /issues/:id/cycle
```

## Query Contract

`GET /cycles` supports:

- `teamId?: string`
- `status?: 'UPCOMING' | 'CURRENT' | 'COMPLETED'`
- `from?: string` (ISO datetime)
- `to?: string` (ISO datetime)
- `cursor?: string`
- `limit?: number` (default server value, max 100)

Use cursor pagination only.

## Cycle Payload Shape

Cycle summary payload:

```ts
type CycleSummary = {
  id: string;
  workspaceId: string;
  teamId: string;
  name: string;
  number: number;
  description: string | null;
  goal: string | null;
  startsAt: string;
  endsAt: string;
  status: 'UPCOMING' | 'CURRENT' | 'COMPLETED';
  completedAt: string | null;
  completedById: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  team: { id: string; name: string };
  stats: {
    totalIssues: number;
    completedIssues: number;
    inProgressIssues: number;
    todoIssues: number;
    backlogIssues: number;
    reviewIssues: number;
    unfinishedIssues: number;
    progress: number;
    daysTotal: number;
    daysElapsed: number;
    daysRemaining: number;
    timeElapsedPercent: number;
  };
};
```

Cycle detail extends summary and includes:

- `createdBy`
- `completedBy`
- `issueBreakdown` (`byStatus`, `byPriority`, `byType`, `byProject`)
- `rules` (`carryOverRequired`, `canComplete`, `canEditDates`, `canCarryOver`, ...)
- `issues` list

## Lifecycle UX Rules

- only one current cycle per team is allowed by backend
- overlapping dates in same team are rejected
- completed cycle cannot be edited directly
- completion does not auto-move unfinished work
- carry-over is explicit action

Frontend behavior:

1. On complete action, inspect `rules.carryOverRequired`.
2. If true, prompt explicit choice:
   - move unfinished to another cycle (`mode: nextCycle`)
   - move unfinished to backlog (`mode: backlog`)
3. Execute `POST /cycles/:id/carry-over` only after user confirms.

## Issue Planning Integration

Assign issue to cycle:

- `POST /issues/:id/cycle` with `{ cycleId }`

Remove issue from cycle:

- `DELETE /issues/:id/cycle`

Expected UI updates:

- issue detail cycle field updates
- cycle detail issue list updates
- cycle stats/progress updates
- optional success toast for planning actions

## Realtime Events (Phase 10)

Workspace realtime events for cycles:

- `cycle:created`
- `cycle:updated`
- `cycle:deleted`
- `cycle:completed`
- `cycle:reopened`
- `cycle:issues-added`
- `cycle:issue-removed`
- `cycle:issues-carried-over`

Also consume existing issue/comment events from Phase 10 for cross-screen freshness.

Client behavior:

- patch or invalidate cycle list/detail cache on cycle events
- patch issue detail/list cache when issue cycle assignment changes
- dedupe by socket envelope `id`

## Notifications

Cycle operations emit notification-impacting updates through existing inbox model.

Frontend should:

- continue listening to `notification:created`
- show toast/badge updates
- refetch `/notifications` and `/notifications/unread-count` on reconnect

## Suggested Query Keys

- `['cycles', workspaceId, params]`
- `['cycle-current', workspaceId, teamId]`
- `['cycle-detail', workspaceId, cycleId]`
- `['issues', workspaceId, params]`
- `['issue', workspaceId, issueId]`
- `['notifications', workspaceId, params]`
- `['notifications-unread', workspaceId]`

Reset cursor when filters/team/status change.

## Error Handling

Handle expected backend errors:

- `CYCLE_NOT_FOUND`
- `CYCLE_DATE_INVALID`
- `CYCLE_OVERLAP_NOT_ALLOWED`
- `CYCLE_CURRENT_ALREADY_EXISTS`
- `CYCLE_COMPLETED_IMMUTABLE`
- `CYCLE_TEAM_MISMATCH`
- `CYCLE_ASSIGN_COMPLETED_FORBIDDEN`
- `CYCLE_REOPEN_FORBIDDEN`

## Cycle Activity Tab

Use cycle-scoped activity endpoint:

- `GET /activity?scope=cycle&scopeId=<cycleId>`

Important behavior:

- show only events tagged for that cycle
- do not merge workspace/team/project generic feeds into cycle tab
- rely on backend `metadata.cycleId`-scoped filtering

Status mapping:

- `422` invalid input
- `409` lifecycle conflict
- `403` permission denied
- `404` missing resource

## Recommended Screen Integration

Cycle list page:

- tabs/filters by `CURRENT`, `UPCOMING`, `COMPLETED`
- team filter
- cycle cards with stats and progress

Cycle detail page:

- overview stats and breakdown sections
- issue list with quick navigation
- complete/reopen/carry-over actions
- realtime refresh on socket events

Issue create/edit/detail:

- cycle selector constrained to team-compatible cycles
- block completed cycles in selector

## Completion Checklist

- [ ] Cycle list and detail read from API contract
- [ ] Create/update/delete/complete/reopen/carry-over actions wired
- [ ] Issue planning into/from cycle wired
- [ ] Realtime cycle events update UI caches
- [ ] Notification and unread badge stay in sync
- [ ] Conflict and validation errors surfaced with actionable UI
