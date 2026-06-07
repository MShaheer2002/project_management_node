# Phase 15 Frontend Roadmap Integration Guide

This guide defines frontend integration for roadmap (Phase 15), including workspace timeline views, project roadmap detail, milestones, dependencies, schedule updates, notifications, and realtime updates.

Backend references:
- [phase-15-backend-setup-guide.md](./phase-15-backend-setup-guide.md)
- [phase15-backend-contract.md](./phase15-backend-contract.md)
- [phase-10-frontend-socket-notification-integration-guide.md](./phase-10-frontend-socket-notification-integration-guide.md)

Frontend files impacted:
- [RoadmapPage.tsx](</Users/shaheer/Documents/personal/project_management_react/src/pages/RoadmapPage.tsx>)
- [ProjectDetailPage.tsx](</Users/shaheer/Documents/personal/project_management_react/src/features/projects/pages/ProjectDetailPage.tsx>)
- [Sidebar.tsx](</Users/shaheer/Documents/personal/project_management_react/src/components/Sidebar.tsx>)

## Preconditions

- workspace auth flow is stable
- `X-Workspace-Id` is sent for all roadmap calls
- Phase 10 socket client integration is active
- Phase 9 notification inbox and unread badge are active
- project detail page already has working `projectId`

## Routes

```txt
GET    /roadmap
GET    /roadmap/projects/:projectId
PATCH  /roadmap/projects/:projectId/schedule
POST   /roadmap/projects/:projectId/milestones
PATCH  /roadmap/projects/:projectId/milestones/:milestoneId
PATCH  /roadmap/projects/:projectId/milestones/reorder
DELETE /roadmap/projects/:projectId/milestones/:milestoneId
POST   /roadmap/dependencies
PATCH  /roadmap/dependencies/:dependencyId/resolve
PATCH  /roadmap/dependencies/:dependencyId/cancel
DELETE /roadmap/dependencies/:dependencyId
```

## Current Frontend Gaps To Replace

Current `RoadmapPage.tsx` is still mock-driven.

Replace:

- `MOCK_PROJECTS`
- `MOCK_TEAMS`
- synthetic bar width logic
- static `Q1 2024` label
- fixed month header cells

Important query mismatch:

- current frontend uses `?team=<id>`
- backend route expects `teamId`

Frontend must either:

- change URL generation to `?teamId=<id>`

or:

- read `team` from URL and translate it into `teamId` before calling the API

Project detail gap:

- current project detail roadmap tab renders the generic `RoadmapPage`
- that tab must instead call `GET /roadmap/projects/:projectId` and render project-specific roadmap data

## Role Expectations

- workspace roadmap list: member/admin/owner
- project roadmap detail: guest/member/admin/owner subject to project visibility
- schedule update: project lead, team lead, admin, owner
- milestone management: project lead, team lead, admin, owner
- dependency management: project lead, team lead, admin, owner

Frontend must hide or disable mutation actions for users outside those roles.

## Workspace Roadmap Query Contract

`GET /roadmap` supports:

- `view?: 'MONTH' | 'QUARTER'`
- `from?: string` ISO date
- `to?: string` ISO date
- `cursor?: string`
- `limit?: number`
- `sort?: 'targetDate:asc' | 'targetDate:desc' | 'startDate:asc' | 'startDate:desc' | 'progress:asc' | 'progress:desc' | 'health:asc' | 'health:desc' | 'updatedAt:desc' | 'name:asc'`
- `teamId?: string`
- `departmentId?: string`
- `leadId?: string`
- `projectId?: string`
- `status?: 'ACTIVE' | 'COMPLETED' | 'ARCHIVED'`
- `health?: 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK' | 'BLOCKED' | 'NO_SIGNAL'`
- `includeUnscheduled?: boolean`
- `q?: string`

Use cursor pagination only.

## Workspace Roadmap Response Shape

Treat `GET /roadmap` as a backend-owned render payload.

```ts
type RoadmapListResponse = {
  window: {
    view: 'MONTH' | 'QUARTER';
    from: string;
    to: string;
    label: string;
    previous: { from: string; to: string; label: string };
    next: { from: string; to: string; label: string };
  };
  filters: {
    teamId: string | null;
    departmentId: string | null;
    leadId: string | null;
    projectId: string | null;
    status: string | null;
    health: string | null;
    includeUnscheduled: boolean;
    q: string | null;
  };
  items: RoadmapItem[];
  unscheduled: {
    count: number;
    items: RoadmapItem[];
  };
  meta: {
    total: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};
```

Roadmap item payload:

```ts
type RoadmapItem = {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
  visibility: 'PUBLIC' | 'PRIVATE';
  description: string | null;
  startDate: string | null;
  targetDate: string | null;
  updatedAt: string;
  createdAt: string;
  progress: number;
  team: { id: string; name: string } | null;
  department: { id: string; name: string; color: string | null } | null;
  lead: { id: string; name: string; email: string; avatar: string | null } | null;
  features: { roadmap: boolean };
  schedule: {
    startDate: string | null;
    targetDate: string | null;
    durationDays: number | null;
    layout: {
      startsBeforeWindow: boolean;
      endsAfterWindow: boolean;
      overlapsWindow: boolean;
      offsetPercent: number;
      widthPercent: number;
      durationDays: number;
    } | null;
  };
  stats: {
    totalIssues: number;
    completedIssues: number;
    openIssues: number;
  };
  health: {
    status: 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK' | 'BLOCKED' | 'NO_SIGNAL';
    reasonCodes: string[];
    severity: number;
  };
  milestoneSummary: {
    total: number;
    completed: number;
    overdue: number;
    next: RoadmapMilestone | null;
  };
  dependencySummary: {
    blocked: boolean;
    blockedByCount: number;
    blockingCount: number;
  };
  forecast: {
    expectedProgress: number | null;
    variance: number | null;
    status: 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK' | 'NO_SIGNAL';
    projectedTargetDate: string | null;
  };
};
```

## Rendering Rules For RoadmapPage

Use backend window data for:

- page title period label
- previous button target
- next button target
- month or quarter timeline headers

Use backend schedule layout for bar rendering:

- `offsetPercent` maps to left offset
- `widthPercent` maps to rendered width
- if `layout.overlapsWindow` is false, either hide row bar or render out-of-window state

Do not recompute synthetic bar dimensions on the frontend.

Recommended UI behavior:

- if `item.dependencySummary.blocked` is true, show blocked badge/state
- if `item.milestoneSummary.overdue > 0`, show overdue indicator
- if `item.health.reasonCodes` includes `TARGET_DATE_PASSED`, show overdue status emphasis
- if project has null layout, move it to unscheduled bucket UI when `includeUnscheduled=true`

## Project Roadmap Detail Contract

`GET /roadmap/projects/:projectId` returns:

```ts
type ProjectRoadmapDetailResponse = {
  project: RoadmapItem;
  milestones: RoadmapMilestone[];
  dependencies: {
    upstream: RoadmapDependency[];
    downstream: RoadmapDependency[];
  };
  summary: {
    blocked: boolean;
    overdueMilestones: number;
    nextMilestone: RoadmapMilestone | null;
    health: RoadmapItem['health'];
    forecast: RoadmapItem['forecast'];
  };
};
```

Milestone payload:

```ts
type RoadmapMilestone = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  dueDate: string;
  owner: { id: string; name: string; email: string; avatar: string | null } | null;
  status: 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'MISSED';
  completedAt: string | null;
  completedBy: { id: string; name: string; email: string; avatar: string | null } | null;
  sortOrder: number;
  outOfRange: boolean;
  createdAt: string;
  updatedAt: string;
};
```

Dependency payload:

```ts
type RoadmapDependency = {
  id: string;
  workspaceId: string;
  blockingProjectId: string;
  blockedProjectId: string;
  status: 'ACTIVE' | 'RESOLVED' | 'CANCELLED';
  note: string | null;
  resolvedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  blockingProject: ProjectRef | null;
  blockedProject: ProjectRef | null;
};

type ProjectRef = {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
  visibility: 'PUBLIC' | 'PRIVATE';
  startDate: string | null;
  targetDate: string | null;
  team: { id: string; name: string } | null;
  department: { id: string; name: string; color: string | null } | null;
  lead: { id: string; name: string; email: string; avatar: string | null } | null;
};
```

## Schedule Update Flow

Call:

```txt
PATCH /roadmap/projects/:projectId/schedule
```

Body:

```json
{
  "startDate": "2026-06-01",
  "targetDate": "2026-08-15",
  "reason": "Scope moved to next release",
  "force": false
}
```

Conflict handling:

- backend may return `409 ROADMAP_SCHEDULE_CONFLICT`
- payload includes `affectedDependencies`
- payload includes `requiresConfirmation`
- payload includes `allowedForceOverride`

Frontend behavior:

1. Show a confirmation modal listing affected blocked projects.
2. If user is admin/owner and confirms, resend with `force: true`.
3. If user is not admin/owner, do not show force action.

## Milestone Flows

Create:

```txt
POST /roadmap/projects/:projectId/milestones
```

Update:

```txt
PATCH /roadmap/projects/:projectId/milestones/:milestoneId
```

Reorder:

```txt
PATCH /roadmap/projects/:projectId/milestones/reorder
```

Delete:

```txt
DELETE /roadmap/projects/:projectId/milestones/:milestoneId
```

Frontend rules:

- use backend `sortOrder`, do not maintain local-only order as source of truth
- if `outOfRange=true`, show warning state but still render milestone
- setting status to `COMPLETED` should update completion UI from response payload

## Dependency Flows

Create:

```txt
POST /roadmap/dependencies
```

Resolve:

```txt
PATCH /roadmap/dependencies/:dependencyId/resolve
```

Cancel:

```txt
PATCH /roadmap/dependencies/:dependencyId/cancel
```

Delete incorrect link:

```txt
DELETE /roadmap/dependencies/:dependencyId
```

Frontend rules:

- resolve means work relationship is complete
- cancel means planning relationship is no longer valid
- delete should be reserved for incorrect links only

## Realtime Events

Workspace/project socket events:

- `roadmap:project-updated`
- `roadmap:milestone-created`
- `roadmap:milestone-updated`
- `roadmap:milestone-deleted`
- `roadmap:dependency-created`
- `roadmap:dependency-resolved`
- `roadmap:dependency-cancelled`
- `roadmap:dependency-deleted`

Client behavior:

- invalidate workspace roadmap list on any roadmap workspace event
- invalidate project roadmap detail on any event for that project
- if optimistic UI is used, reconcile against server payload
- dedupe by realtime envelope id from Phase 10 client logic

## Suggested Query Keys

- `['roadmap', workspaceId, params]`
- `['roadmap-project', workspaceId, projectId]`
- `['notifications', workspaceId, params]`
- `['notifications-unread', workspaceId]`

Reset cursor when:

- `view` changes
- `teamId` changes
- `departmentId` changes
- `leadId` changes
- `status` changes
- `health` changes
- `q` changes

## Error Handling

Handle expected backend codes:

- `ROADMAP_DISABLED_FOR_PROJECT`
- `ROADMAP_INVALID_DATE_RANGE`
- `ROADMAP_SCHEDULE_CONFLICT`
- `ROADMAP_MILESTONE_NOT_FOUND`
- `ROADMAP_DEPENDENCY_DUPLICATE`
- `ROADMAP_DEPENDENCY_CYCLE`
- `ROADMAP_DEPENDENCY_CANCELLED`
- `ROADMAP_DEPENDENCY_INVALID_SCOPE`
- `ROADMAP_FORBIDDEN`
- `PROJECT_NOT_FOUND`
- `PRIVATE_PROJECT_FORBIDDEN`

Status expectations:

- `422` invalid input
- `409` dependency/schedule conflict
- `403` permission denied
- `404` missing or invisible resource

## Recommended Integration Order

1. Replace `RoadmapPage` mock data with `GET /roadmap`.
2. Translate current `team` URL param to backend `teamId`.
3. Replace static timeline label/navigation with backend `window`.
4. Render bars from `schedule.layout`.
5. Add unscheduled bucket support.
6. Implement project detail roadmap tab using `GET /roadmap/projects/:projectId`.
7. Add milestone CRUD and reorder UI.
8. Add dependency create/resolve/cancel/delete UI.
9. Wire schedule edit conflict modal and force flow.
10. Wire roadmap socket invalidation.
