# Phase 15 Backend Contract (Roadmap)

This document translates Phase 15 from [build-phases.md](./build-phases.md) into a production-grade backend contract for roadmap planning.

Phase 0 through Phase 14 are assumed complete.

## Goal

Deliver a real roadmap system for planning and tracking project delivery across the workspace.

The roadmap is not just a chart.

It must become a planning surface that lets users:

- schedule projects against real dates
- understand delivery risk
- manage milestones
- model project dependencies
- filter by team, department, owner, and status
- see blocked and overdue work
- reschedule confidently
- power both the workspace roadmap page and the project detail roadmap tab

The backend must own the source of truth for:

- roadmap timeline ranges
- project bar positioning inputs
- milestone persistence
- project dependency persistence
- health and risk computation
- blocked state computation
- computed forecast metadata
- roadmap filtering, sorting, and access control

The frontend must never compute roadmap state from mock positioning logic.

## Business Goal

Projects already have:

- `startDate`
- `targetDate`
- `progress`
- `team`
- `department`
- `lead`
- feature toggles including `roadmap`

That is enough to start rendering a real roadmap, but not enough to make roadmap operational.

To become useful, roadmap must answer:

- what is planned?
- what is slipping?
- what is blocked?
- what milestone is next?
- what should move first?
- which team roadmap am I looking at?
- can I safely shift dates without breaking downstream work?

This phase closes the gap between visual placeholder and production-grade planning.

## Dependency and Scope

Depends on:

- Phase 3 (teams, departments, roles)
- Phase 4 (projects)
- Phase 5 (issues)
- Phase 8 (activity)
- Phase 9 (notifications)
- Phase 10 (realtime)
- Phase 11 (cycles)
- Phase 14 (analytics)

In scope:

- roadmap aggregation endpoints
- project schedule persistence and validation
- milestone DB model and CRUD
- project dependency DB model and CRUD
- workspace and team-scoped roadmap views
- project-scoped roadmap detail
- timeline health and risk computation
- blocked and overdue state computation
- forecast-ready metadata derived from analytics inputs
- forecast remains computed at read time and may be cached, but must not be stored as roadmap source of truth
- sorting, filtering, and pagination/windowing for large workspaces
- activity events for roadmap operations
- notifications where roadmap changes affect owners/leads/blocked projects
- socket updates for roadmap mutations

Out of scope:

- arbitrary freeform canvas editing
- dependency graphs between issues
- portfolio budgeting
- OKR management
- recurring milestone automation
- capacity planning per person
- billing rules for roadmap access

## Frontend Surfaces Impacted

- roadmap page: [src/pages/RoadmapPage.tsx](/Users/shaheer/Documents/personal/project_management_react/src/pages/RoadmapPage.tsx)
- project detail roadmap tab: [src/features/projects/pages/ProjectDetailPage.tsx](/Users/shaheer/Documents/personal/project_management_react/src/features/projects/pages/ProjectDetailPage.tsx)
- sidebar team-scoped roadmap links: [src/components/Sidebar.tsx](/Users/shaheer/Documents/personal/project_management_react/src/components/Sidebar.tsx)
- project create/edit settings where schedule fields already exist
- analytics surfaces that reference project timeline health
- activity feeds for roadmap mutations
- notification inbox and realtime toast

## Domain Model

## Core Concepts

Roadmap item = one project represented on a time axis.

Milestone = a dated checkpoint inside one project timeline.

Dependency = one project blocks another project.

Health = backend-computed delivery confidence for a roadmap item.

Blocked = a project has one or more unresolved upstream dependencies.

Forecast = backend-computed schedule signal informed by analytics and current progress.

Forecast is derived data, not persisted source-of-truth state.

## Project Scheduling Fields

Use existing project fields as the schedule anchor:

```ts
type ProjectScheduleFields = {
  startDate: string | null;   // ISO date
  targetDate: string | null;  // ISO date
  progress: number;           // 0..100
  status: 'ACTIVE' | 'ARCHIVED' | 'COMPLETED';
  features: {
    roadmap: boolean;
  };
};
```

Rules:

- roadmap rendering requires `features.roadmap = true`
- roadmap rendering prefers both `startDate` and `targetDate`
- projects missing one or both dates may still appear in a dedicated unscheduled bucket if requested
- archived projects are excluded by default
- schema should remain forward-compatible with portfolio grouping later, such as `parentProjectId` or a future `initiativeId`

## Future Portfolio Hierarchy

Not required in Phase 15, but roadmap should be designed so higher-level grouping can be added later without breaking endpoint shape.

Examples:

- `project.parentProjectId`
- `initiativeId`

Use cases:

- portfolio views with 20+ projects
- strategic grouping across multiple delivery streams
- nested roadmap rows in later phases

## Milestone Model

```ts
type MilestoneStatus = 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'MISSED';

type ProjectMilestone = {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  description: string | null;
  dueDate: string; // ISO date-time
  ownerId: string | null;
  status: MilestoneStatus;
  completedAt: string | null;
  completedById: string | null;
  sortOrder: number;
  createdById: string;
  createdAt: string;
  updatedAt: string;
};
```

Recommended Prisma shape:

```prisma
model ProjectMilestone {
  id            String          @id @default(uuid())
  workspaceId   String
  projectId     String
  name          String
  description   String?
  dueDate       DateTime
  ownerId       String?
  status        MilestoneStatus @default(PLANNED)
  completedAt   DateTime?
  completedById String?
  sortOrder     Int             @default(0)
  createdById   String
  createdAt     DateTime        @default(now())
  updatedAt     DateTime        @updatedAt

  workspace     Workspace       @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  project       Project         @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([workspaceId, projectId, dueDate])
  @@index([workspaceId, status, dueDate])
}

enum MilestoneStatus {
  PLANNED
  IN_PROGRESS
  COMPLETED
  MISSED
}
```

## Dependency Model

```ts
type ProjectDependencyStatus = 'ACTIVE' | 'RESOLVED' | 'CANCELLED';

type ProjectDependency = {
  id: string;
  workspaceId: string;
  blockingProjectId: string;
  blockedProjectId: string;
  status: ProjectDependencyStatus;
  note: string | null;
  resolvedAt: string | null;
  resolvedById: string | null;
  cancelledAt: string | null;
  cancelledById: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
};
```

Recommended Prisma shape:

```prisma
model ProjectDependency {
  id                String                  @id @default(uuid())
  workspaceId       String
  blockingProjectId String
  blockedProjectId  String
  status            ProjectDependencyStatus @default(ACTIVE)
  note              String?
  resolvedAt        DateTime?
  resolvedById      String?
  cancelledAt       DateTime?
  cancelledById     String?
  createdById       String
  createdAt         DateTime                @default(now())
  updatedAt         DateTime                @updatedAt

  workspace         Workspace               @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  blockingProject   Project                 @relation("RoadmapBlockingProject", fields: [blockingProjectId], references: [id], onDelete: Cascade)
  blockedProject    Project                 @relation("RoadmapBlockedProject", fields: [blockedProjectId], references: [id], onDelete: Cascade)

  @@unique([blockingProjectId, blockedProjectId])
  @@index([workspaceId, status])
  @@index([workspaceId, blockedProjectId, status])
  @@index([workspaceId, blockingProjectId, status])
}

enum ProjectDependencyStatus {
  ACTIVE
  RESOLVED
  CANCELLED
}
```

Rules:

- `RESOLVED` means the dependency was satisfied through normal delivery
- `CANCELLED` means the dependency link is no longer relevant and should not count as an active blocker

## Health and Risk Model

```ts
type RoadmapHealth = 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK' | 'BLOCKED' | 'NO_SIGNAL';

type RoadmapRiskReason =
  | 'MISSING_DATES'
  | 'LOW_COMPLETION_RATE'
  | 'OVERDUE_TARGET'
  | 'ACTIVE_BLOCKERS'
  | 'NO_RECENT_DELIVERY'
  | 'SCOPE_GROWTH'
  | 'MANUAL_OVERRIDE';
```

The backend computes health using:

- `project.startDate`
- `project.targetDate`
- current `progress`
- issue completion rate from analytics
- open vs completed issue counts
- active dependencies
- overdue milestones
- project status

Initial recommended rules:

- `BLOCKED` if active upstream dependencies exist
- `OFF_TRACK` if target date is past and project is incomplete
- `AT_RISK` if completion trend is insufficient for remaining time
- `ON_TRACK` if delivery trend supports current target date
- `NO_SIGNAL` if required schedule/analytics data is missing

The backend should also return reason codes so frontend chips/tooltips are deterministic.

## Permissions

Use `authenticate`, `requireWorkspace`, and role guards.

| Action | Owner | Admin | Member | Guest |
|---|---:|---:|---:|---:|
| View workspace roadmap | Yes | Yes | Scoped | Public only |
| View team roadmap | Yes | Yes | Team members | Public only |
| View project roadmap detail | Yes | Yes | Project members | Public project only |
| Edit project schedule | Yes | Yes | Project lead or team lead | No |
| Create/edit/delete milestone | Yes | Yes | Project lead or team lead | No |
| Reorder milestones | Yes | Yes | Project lead or team lead | No |
| Create/remove/resolve dependency | Yes | Yes | Project lead or team lead | No |

Recommended contextual rule:

- owner/admin can manage all roadmap entities in workspace
- members can manage roadmap for projects they lead or teams they lead
- guests can only view public project roadmap data and never workspace-level planning views

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

## Roadmap Window

```ts
type RoadmapView = 'MONTH' | 'QUARTER';

type RoadmapWindow = {
  view: RoadmapView;
  from: string;       // ISO date
  to: string;         // ISO date
  label: string;      // "Q3 2026" or "Jun 2026"
  previous: { from: string; to: string; label: string };
  next: { from: string; to: string; label: string };
};
```

## Roadmap Filters

```ts
type RoadmapFilters = {
  teamId?: string;
  departmentId?: string;
  leadId?: string;
  projectId?: string;
  status?: 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
  health?: RoadmapHealth;
  includeUnscheduled?: boolean;
  q?: string;
};
```

## Roadmap Summary Item

Used by the main roadmap page.

```ts
type RoadmapProjectSummary = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: 'ACTIVE' | 'ARCHIVED' | 'COMPLETED';
  visibility: 'PUBLIC' | 'PRIVATE';
  progress: number;
  startDate: string | null;
  targetDate: string | null;
  durationDays: number | null;
  team: { id: string; name: string };
  department: { id: string; name: string; color: string | null } | null;
  lead: { id: string; name: string; avatar: string | null } | null;
  stats: {
    totalIssues: number;
    completedIssues: number;
    openIssues: number;
    overdueIssues: number;
  };
  health: {
    status: RoadmapHealth;
    reasons: RoadmapRiskReason[];
    confidence: number | null; // 0..100 or null if insufficient signal
  };
  blockers: {
    blockedByCount: number;
    blockingCount: number;
    active: boolean;
  };
  milestones: {
    total: number;
    completed: number;
    overdue: number;
    next: {
      id: string;
      name: string;
      dueDate: string;
      status: MilestoneStatus;
      owner: { id: string; name: string; avatar: string | null } | null;
    } | null;
  };
  timeline: {
    startsInWindow: boolean;
    endsInWindow: boolean;
    startsBeforeWindow: boolean;
    endsAfterWindow: boolean;
  };
};
```

## Roadmap List Response

```ts
type RoadmapListResponse = {
  window: RoadmapWindow;
  filters: RoadmapFilters;
  items: RoadmapProjectSummary[];
  unscheduled: {
    count: number;
    items: Array<{
      id: string;
      name: string;
      team: { id: string; name: string };
      lead: { id: string; name: string; avatar: string | null } | null;
    }>;
  };
  meta: {
    total: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};
```

## Roadmap Project Detail

Used by the project detail roadmap tab and focused roadmap screens.

```ts
type RoadmapProjectDetail = {
  project: RoadmapProjectSummary & {
    createdAt: string;
    updatedAt: string;
  };
  milestones: ProjectMilestone[];
  dependencies: {
    blockedBy: Array<{
      dependencyId: string;
      project: { id: string; name: string; status: string; targetDate: string | null };
      status: ProjectDependencyStatus;
      note: string | null;
    }>;
    blocking: Array<{
      dependencyId: string;
      project: { id: string; name: string; status: string; targetDate: string | null };
      status: ProjectDependencyStatus;
      note: string | null;
    }>;
  };
  computed: {
    forecast: {
      projectedCompletionDate: string | null;
      confidence: number | null;
      basedOnDays: number | null;
    };
  };
};
```

## Sorting

Supported roadmap sorting:

```ts
type RoadmapSort =
  | 'targetDate:asc'
  | 'targetDate:desc'
  | 'startDate:asc'
  | 'startDate:desc'
  | 'progress:asc'
  | 'progress:desc'
  | 'health:asc'
  | 'health:desc'
  | 'updatedAt:desc'
  | 'name:asc';
```

Health sorting should use deterministic severity ordering:

`BLOCKED` > `OFF_TRACK` > `AT_RISK` > `NO_SIGNAL` > `ON_TRACK`

## REST Endpoints

## 1. List Roadmap Timeline

`GET /roadmap`

Returns roadmap data for workspace, team, department, or filtered portfolio views.

Query params:

```ts
type ListRoadmapQuery = {
  view?: 'MONTH' | 'QUARTER';
  from?: string; // ISO date, defaults to current period start
  to?: string;   // ISO date, optional, backend may derive from view
  cursor?: string;
  limit?: number; // recommended default 50, max 200
  sort?: RoadmapSort;
  teamId?: string;
  departmentId?: string;
  leadId?: string;
  projectId?: string;
  status?: 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
  health?: RoadmapHealth;
  includeUnscheduled?: boolean;
  q?: string;
};
```

Behavior:

- returns only projects visible to the requesting user
- excludes `features.roadmap = false` by default
- computes `window.previous` and `window.next`
- supports team-scoped roadmap via `teamId`
- supports large workspaces via `cursor` and `limit`

Success response:

```json
{
  "success": true,
  "data": {
    "window": {
      "view": "QUARTER",
      "from": "2026-07-01",
      "to": "2026-09-30",
      "label": "Q3 2026",
      "previous": {
        "from": "2026-04-01",
        "to": "2026-06-30",
        "label": "Q2 2026"
      },
      "next": {
        "from": "2026-10-01",
        "to": "2026-12-31",
        "label": "Q4 2026"
      }
    },
    "filters": {
      "teamId": "team_123"
    },
    "items": [],
    "unscheduled": {
      "count": 2,
      "items": []
    },
    "meta": {
      "total": 12,
      "hasMore": false,
      "nextCursor": null
    }
  }
}
```

## 2. Get Project Roadmap Detail

`GET /roadmap/projects/:projectId`

Returns a project-focused roadmap view.

Use cases:

- project detail roadmap tab
- dependency side panel
- milestone management drawer

Success response:

```ts
type GetProjectRoadmapResponse = RoadmapProjectDetail;
```

## 3. Update Project Schedule

`PATCH /roadmap/projects/:projectId/schedule`

Request:

```ts
type UpdateProjectScheduleInput = {
  startDate?: string | null;
  targetDate?: string | null;
  reason?: string | null;
  force?: boolean;
};
```

Rules:

- if provided, `startDate` must be on or before `targetDate`
- cannot schedule into impossible ranges
- should warn or block when active downstream dependencies make the change dangerous
- if a dependency conflict exists, backend should return a confirmation-style conflict error
- `force = true` is allowed only for owner/admin users and must be auditable in activity metadata

Recommended conflict error:

```ts
type RoadmapScheduleConflictError = {
  code: 'ROADMAP_SCHEDULE_CONFLICT';
  message: string;
  details: {
    projectId: string;
    affectedDependencies: Array<{
      dependencyId: string;
      blockedProject: { id: string; name: string };
    }>;
    requiresConfirmation: true;
    allowedForceOverride: boolean;
  };
};
```

## 4. Create Milestone

`POST /roadmap/projects/:projectId/milestones`

Request:

```ts
type CreateMilestoneInput = {
  name: string;
  description?: string | null;
  dueDate: string;
  ownerId?: string | null;
  status?: MilestoneStatus;
};
```

Rules:

- milestone belongs to the same workspace as the project
- `ownerId`, when provided, must belong to the workspace and should usually be a project/team member
- `dueDate` may be outside project schedule, but backend should return `outOfRange` flag in response
- default new milestone goes to the end of the current milestone order

## 5. Update Milestone

`PATCH /roadmap/projects/:projectId/milestones/:milestoneId`

Request:

```ts
type UpdateMilestoneInput = {
  name?: string;
  description?: string | null;
  dueDate?: string;
  ownerId?: string | null;
  status?: MilestoneStatus;
};
```

Behavior:

- setting `status = COMPLETED` sets `completedAt` and `completedById`
- moving from `COMPLETED` back to non-complete clears completion fields
- overdue milestones should surface in roadmap health calculations
- milestone owner is the default notification target for overdue and missed milestone events

## 6. Reorder Milestones

`PATCH /roadmap/projects/:projectId/milestones/reorder`

Request:

```ts
type ReorderMilestonesInput = {
  orderedIds: string[];
};
```

Rules:

- all milestone ids must belong to the project
- reorder must be atomic

## 7. Delete Milestone

`DELETE /roadmap/projects/:projectId/milestones/:milestoneId`

Behavior:

- hard delete is acceptable if activity history is retained separately

## 8. Create Dependency

`POST /roadmap/dependencies`

Request:

```ts
type CreateProjectDependencyInput = {
  blockingProjectId: string;
  blockedProjectId: string;
  note?: string | null;
};
```

Rules:

- both projects must belong to same workspace
- `blockingProjectId !== blockedProjectId`
- duplicate dependency pair is rejected
- circular dependency creation is rejected
- archived projects cannot participate in new active dependencies

Recommended circular dependency error:

```ts
type RoadmapDependencyCycleError = {
  code: 'ROADMAP_DEPENDENCY_CYCLE';
  message: string;
  details: {
    blockingProjectId: string;
    blockedProjectId: string;
    cycleProjectIds: string[];
  };
};
```

## 9. Resolve Dependency

`PATCH /roadmap/dependencies/:dependencyId/resolve`

Request:

```ts
type ResolveProjectDependencyInput = {
  note?: string | null;
};
```

Behavior:

- sets `status = RESOLVED`
- sets `resolvedAt`, `resolvedById`
- updates blocked state for impacted projects

## 10. Cancel Dependency

`PATCH /roadmap/dependencies/:dependencyId/cancel`

Request:

```ts
type CancelProjectDependencyInput = {
  note?: string | null;
};
```

Behavior:

- sets `status = CANCELLED`
- sets `cancelledAt`, `cancelledById`
- removes the dependency from active blocker calculations
- should be used when planning changes invalidate the relationship rather than completing it

## 11. Delete Dependency

`DELETE /roadmap/dependencies/:dependencyId`

Behavior:

- hard delete is acceptable
- use only for incorrect links
- normal business completion should prefer `resolve`

## Validation Rules

## Project Schedule

- `startDate <= targetDate`
- completed projects may keep historical dates
- archived projects are read-only for roadmap mutations by default
- roadmap-disabled projects (`features.roadmap = false`) should not accept milestone/dependency mutations until re-enabled

## Milestones

- name required, trimmed, max 120 chars recommended
- due date must be valid ISO date-time
- owner must belong to the same workspace if present
- completed milestone cannot remain `COMPLETED` with null `completedAt`

## Dependencies

- no self-dependency
- no cross-workspace dependency
- no exact duplicate pair
- no transitive cycle creation
- resolved dependency can be deleted or remain historical
- cancelled dependency does not count toward blocked state or health risk

## Activity Events

Every roadmap operation should emit activity events.

Recommended event types:

- `ROADMAP_SCHEDULE_UPDATED`
- `ROADMAP_MILESTONE_CREATED`
- `ROADMAP_MILESTONE_UPDATED`
- `ROADMAP_MILESTONE_COMPLETED`
- `ROADMAP_MILESTONE_DELETED`
- `ROADMAP_MILESTONES_REORDERED`
- `ROADMAP_DEPENDENCY_CREATED`
- `ROADMAP_DEPENDENCY_RESOLVED`
- `ROADMAP_DEPENDENCY_CANCELLED`
- `ROADMAP_DEPENDENCY_DELETED`

Recommended metadata fields:

- `projectId`
- `projectName`
- `milestoneId`
- `dependencyId`
- `oldStartDate`
- `newStartDate`
- `oldTargetDate`
- `newTargetDate`
- `blockingProjectId`
- `blockedProjectId`

## Notifications

Roadmap actions should create notifications only when they change someone’s actionable planning state.

Recommended notification triggers:

- project lead is notified when another project starts blocking their project
- project lead is notified when a blocking dependency is resolved
- project lead is notified when a dependency is cancelled by another user
- assigned lead is notified when project target date changes by another user
- milestone owner or fallback project lead is notified when a milestone becomes overdue or missed

Notification categories can use existing update-style semantics:

- `update`
- `assignment`

## Realtime Socket Rules

Roadmap mutations should emit socket updates through workspace and project-scoped channels.

Recommended events:

- `roadmap:project-updated`
- `roadmap:milestone-created`
- `roadmap:milestone-updated`
- `roadmap:milestone-deleted`
- `roadmap:dependency-created`
- `roadmap:dependency-resolved`
- `roadmap:dependency-cancelled`
- `roadmap:dependency-deleted`

Recommended rooms:

- `workspace:<workspaceId>`
- `project:<projectId>` if project-scoped rooms exist later

Payload requirements:

- enough data to update roadmap list rows without full page reload
- enough ids to invalidate project roadmap detail caches

## Performance and Scale Requirements

- roadmap list must support cursor pagination or windowed fetching
- backend must filter and sort in SQL, not in frontend
- health computation should be query-efficient and avoid N+1 issue aggregation
- milestone and dependency counts should be returned in the list payload
- roadmap list should be safe for large workspaces with 100+ projects

Recommended approach:

- one aggregation query for project counts and dates
- one grouped query for milestone stats
- one grouped query for dependency stats
- analytics-derived forecast inputs reused from Phase 14 services where possible
- computed forecast values may be cached for performance, but cached values are disposable and must be recomputable

## Error Codes

Recommended roadmap-specific error codes:

- `ROADMAP_DISABLED_FOR_PROJECT`
- `ROADMAP_INVALID_DATE_RANGE`
- `ROADMAP_SCHEDULE_CONFLICT`
- `ROADMAP_MILESTONE_NOT_FOUND`
- `ROADMAP_DEPENDENCY_DUPLICATE`
- `ROADMAP_DEPENDENCY_CYCLE`
- `ROADMAP_DEPENDENCY_CANCELLED`
- `ROADMAP_DEPENDENCY_INVALID_SCOPE`
- `ROADMAP_FORBIDDEN`

## Done When

- [ ] `/roadmap` returns real project timeline data using real dates
- [ ] team-scoped roadmap works through backend filtering
- [ ] roadmap window navigation is backend-driven and not static
- [ ] monthly vs quarterly roadmap views return correct date windows
- [ ] roadmap bars can be positioned from backend-provided schedule fields
- [ ] milestones are persisted and manageable through CRUD endpoints
- [ ] project dependencies are persisted, validated, and queryable
- [ ] health/risk state is computed by backend with reason codes
- [ ] blocked and overdue state is surfaced in roadmap payloads
- [ ] forecast values are computed on demand or from disposable cache, never stored as source-of-truth roadmap data
- [ ] milestones support optional ownership for accountability and notifications
- [ ] dependency cancellation is supported alongside dependency resolution
- [ ] project detail roadmap tab can render project-specific roadmap data
- [ ] roadmap mutations emit activity events
- [ ] relevant roadmap mutations create notifications
- [ ] roadmap mutations emit realtime socket updates
- [ ] roadmap endpoints enforce workspace isolation and role rules
