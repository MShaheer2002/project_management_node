# Phase 15 Backend Setup Guide (Roadmap)

> Phase 15 turns roadmap into a real planning system backed by project dates, milestones, dependencies, and backend-computed delivery health.
> Follow immutable rules in [rules.md](./rules.md): Route -> Middleware -> Controller -> Service -> DB.

Backend references:
- [phase15-backend-contract.md](./phase15-backend-contract.md)
- [build-phases.md](./build-phases.md)
- [rules.md](./rules.md)

Frontend references reviewed for this guide:
- [RoadmapPage.tsx](</Users/shaheer/Documents/personal/project_management_react/src/pages/RoadmapPage.tsx>)
- [ProjectDetailPage.tsx](</Users/shaheer/Documents/personal/project_management_react/src/features/projects/pages/ProjectDetailPage.tsx>)

---

## 1. Prerequisites

Required completed phases:

- Phase 3 (teams, departments, roles)
- Phase 4 (projects with `startDate`, `targetDate`, `lead`, `team`, `department`, feature flags)
- Phase 5 (issues for progress/open/completed counts)
- Phase 8 (activity events)
- Phase 9 (notifications)
- Phase 10 (socket realtime)
- Phase 11 (cycles, if project scheduling logic already references cycles)
- Phase 14 (analytics reused for risk/forecast signals)

Required middleware chain for protected roadmap routes:

- `authenticate`
- `requireWorkspace`
- `requireRole`

Non-negotiable rules:

- every workspace-scoped query includes `workspaceId`
- controllers stay thin
- services own roadmap business rules
- frontend never computes real roadmap state from mock offsets/widths

---

## 2. Frontend-Derived Requirements

The current frontend already establishes several backend requirements.

From the roadmap page:

- `/roadmap` route already exists
- team-scoped roadmap already uses `?team=<id>` in the URL
- quarterly/monthly toggle already exists
- previous/next timeline navigation already exists
- project bars display project name and progress percent

From the project detail page:

- roadmap must also work inside the project detail roadmap tab
- the backend response shape must support both workspace roadmap and project-scoped roadmap without forcing frontend adapter logic

Backend implications:

- support team filtering cleanly
- return a backend-owned timeline window with `view`, `from`, `to`, `label`, `previous`, `next`
- return schedule inputs the frontend can use for real bar positioning
- return progress and ownership summary in the list payload
- return enough detail for a project-specific roadmap drawer/tab view
- support empty, loading, unscheduled, blocked, and overdue states explicitly

---

## 3. Module Structure

Create module:

```txt
modules/roadmap/
├── roadmap.routes.ts
├── roadmap.controller.ts
├── roadmap.service.ts
├── roadmap.schemas.ts
└── roadmap.utils.ts
```

`roadmap.utils.ts` is justified here for:

- date window derivation
- health severity ordering
- dependency cycle checks
- schedule range helpers
- timeline positioning math inputs

Rules:

- no Prisma usage in controllers
- no Express types in services
- no cross-module circular imports
- extract shared logic only if reused in 3+ places

---

## 4. Prisma Data Model

Use existing `Project.startDate`, `Project.targetDate`, `Project.progress`, and `Project.features.roadmap` as the base schedule fields.

Add roadmap-specific models:

- `ProjectMilestone`
- `ProjectDependency`

Required `ProjectMilestone` fields:

- identity/scope: `id`, `workspaceId`, `projectId`
- content: `name`, `description`
- schedule/ownership: `dueDate`, `ownerId`, `status`, `sortOrder`
- completion: `completedAt`, `completedById`
- audit: `createdById`, `createdAt`, `updatedAt`

Required `ProjectDependency` fields:

- identity/scope: `id`, `workspaceId`
- relation: `blockingProjectId`, `blockedProjectId`
- status: `status`
- note/history: `note`
- resolution: `resolvedAt`, `resolvedById`
- cancellation: `cancelledAt`, `cancelledById`
- audit: `createdById`, `createdAt`, `updatedAt`

Required enums:

- `MilestoneStatus`: `PLANNED | IN_PROGRESS | COMPLETED | MISSED`
- `ProjectDependencyStatus`: `ACTIVE | RESOLVED | CANCELLED`

Required indexes and constraints:

- `ProjectMilestone(workspaceId, projectId, dueDate)`
- `ProjectMilestone(workspaceId, status, dueDate)`
- `ProjectDependency(workspaceId, blockingProjectId, status)`
- `ProjectDependency(workspaceId, blockedProjectId, status)`
- unique active dependency pair guard on `(blockingProjectId, blockedProjectId)` if your status model allows only one live edge

Recommended behavior constraints:

- both dependency projects must belong to the same workspace
- self-dependency is forbidden
- archived projects cannot receive new active dependencies
- roadmap-disabled projects cannot receive milestone/dependency mutations

Run after schema changes:

```bash
npx prisma generate
npx prisma migrate dev --name phase15_roadmap
npx prisma migrate deploy
npm run build
```

---

## 5. Route Scope

Implement:

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

Role policy from the phase contract:

- workspace roadmap: `OWNER`, `ADMIN`, `MEMBER` with visibility filtering, no guest access by default
- project roadmap detail: `OWNER`, `ADMIN`, `MEMBER` with visibility checks, optional public-project guest access only if the existing project visibility model already supports it
- schedule updates: `OWNER`, `ADMIN`, project lead, or team lead
- milestone CRUD: `OWNER`, `ADMIN`, project lead, or team lead
- dependency CRUD: `OWNER`, `ADMIN`, project lead, or team lead

If role/ownership logic already exists elsewhere, keep enforcement in middleware plus minimal service-side safety checks for project visibility/read-only conditions.

---

## 6. Zod Validation

`roadmap.schemas.ts` must validate:

- route params: `projectId`, `milestoneId`, `dependencyId`
- list query: `view`, `from`, `to`, `cursor`, `limit`, `sort`, `teamId`, `departmentId`, `leadId`, `projectId`, `status`, `health`, `includeUnscheduled`, `q`
- schedule update payload: `startDate`, `targetDate`, `reason`, `force`
- milestone create/update payload: `name`, `description`, `dueDate`, `ownerId`, `status`
- milestone reorder payload: `orderedIds`
- dependency create payload: `blockingProjectId`, `blockedProjectId`, `note`
- dependency resolve/cancel payload: `note`

Validation requirements:

- `view` enum: `MONTH | QUARTER`
- `limit` default `50`, max `200`
- `from` and `to` must be valid ISO dates
- `startDate <= targetDate` when both are present
- milestone name required, trimmed, max 120 chars
- milestone due date must be valid ISO datetime
- reorder array cannot contain duplicates
- dependency cannot be self-referential at schema or service validation

Reject invalid payloads with `422 VALIDATION_ERROR`.

---

## 7. List Endpoint Contract

`GET /roadmap` is an aggregation endpoint, not a thin project list.

It must return:

- a backend-owned timeline window
- normalized applied filters
- list items ready for roadmap rendering
- unscheduled bucket data when requested
- pagination metadata

Minimum response shape:

- `window`
- `filters`
- `items`
- `unscheduled`
- `meta`

Each roadmap list item should include:

- project identity: `id`, `name`, `slug`, `status`, `visibility`
- schedule: `startDate`, `targetDate`, duration, date-range intersection metadata
- progress: `progress`, open/completed issue counts
- ownership: `lead`, `team`, `department`
- health: health state plus reason codes
- milestone summary: total, completed, overdue, next milestone
- dependency summary: blocked by count, blocking count, blocked state
- forecast summary derived from analytics inputs

Important:

- filter and sort in SQL/service, never in frontend
- exclude `features.roadmap = false` by default
- support team-scoped filtering because sidebar links already depend on it
- support `includeUnscheduled=true` so projects with missing dates are still discoverable

---

## 8. Project Detail Endpoint Contract

`GET /roadmap/projects/:projectId` must power:

- project detail roadmap tab
- milestone management UI
- dependency detail UI

Return:

- project summary
- full schedule metadata
- milestone list ordered by `sortOrder`, then `dueDate`
- dependency lists split by upstream/downstream when practical
- blocked/overdue/risk summary
- enough IDs and timestamps for cache invalidation

Do not require the frontend to call multiple extra endpoints just to render one project roadmap view.

---

## 9. Service Behavior

### `listRoadmap`

- enforce workspace and visibility filtering
- derive window from `view`, `from`, and `to`
- compute `previous` and `next` window metadata
- aggregate project, issue, milestone, and dependency data
- return stable sorting for large workspaces

### `getProjectRoadmapDetail`

- verify project is visible in workspace scope
- return project schedule, milestones, dependencies, and health summary

### `updateProjectSchedule`

- update `startDate` and `targetDate` together in one operation
- reject invalid ranges with `ROADMAP_INVALID_DATE_RANGE`
- if active downstream dependencies are endangered, return `409 ROADMAP_SCHEDULE_CONFLICT`
- allow `force=true` only for `OWNER`/`ADMIN`
- capture old/new dates and reason in activity metadata

### `createMilestone`

- verify project is roadmap-enabled and mutable
- verify owner belongs to same workspace if provided
- assign `sortOrder` to end of list
- return out-of-range signal when `dueDate` falls outside project schedule

### `updateMilestone`

- maintain completion metadata consistency
- setting `status=COMPLETED` sets `completedAt` and `completedById`
- moving away from `COMPLETED` clears completion fields
- overdue milestones feed roadmap health

### `reorderMilestones`

- all IDs must belong to the same project and workspace
- perform atomically in a transaction

### `deleteMilestone`

- hard delete is acceptable
- activity history must still remain intact separately

### `createDependency`

- verify both projects are in the same workspace
- reject self-links, duplicates, and cycles
- reject archived or roadmap-disabled project participation

### `resolveDependency`

- set `status=RESOLVED`
- set resolver metadata
- recompute impacted blocked state

### `cancelDependency`

- set `status=CANCELLED`
- exclude cancelled link from active blocker calculations
- preserve history for auditability

### `deleteDependency`

- reserve for incorrect links
- normal business completion should use `resolve`

---

## 10. Health, Blocked State, and Forecast

Backend owns health computation.

Required output states:

- `ON_TRACK`
- `AT_RISK`
- `OFF_TRACK`
- `BLOCKED`
- `NO_SIGNAL`

Deterministic severity ordering for sorting:

- `BLOCKED`
- `OFF_TRACK`
- `AT_RISK`
- `NO_SIGNAL`
- `ON_TRACK`

Recommended input signals:

- target date proximity
- project progress
- open/completed issue mix
- overdue milestone count
- active dependency blockers
- analytics-derived throughput or trend signals from Phase 14

Rules:

- blocked state comes from active unresolved upstream dependencies
- cancelled dependencies do not count toward blocked state
- forecast is derived data and never persisted as roadmap source of truth
- forecast may be cached, but cache must be disposable and recomputable

---

## 11. Activity Integration

Emit activity for every roadmap mutation.

Required event types:

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

Recommended metadata:

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
- `reason`
- `force`

---

## 12. Notification Integration

Create notifications only when planning state changes become actionable for someone else.

Recommended triggers:

- project lead notified when another project starts blocking their project
- project lead notified when a blocker is resolved
- project lead notified when a dependency is cancelled by another actor
- project lead notified when target date changes by another actor
- milestone owner or fallback project lead notified when a milestone becomes overdue or missed

Rules:

- never notify across workspaces
- skip actor self-notification by default
- follow Phase 9 notification preference behavior

---

## 13. Socket Integration

Broadcast roadmap mutations through realtime channels.

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
- `project:<projectId>` when project-scoped rooms exist

Payload minimum:

- enough data to update roadmap rows without full refetch
- enough IDs to invalidate project detail roadmap caches

---

## 14. Performance and Query Strategy

Required:

- support cursor pagination or equivalent windowed fetch
- filter and sort in backend
- avoid N+1 queries for milestone/dependency/issue counts
- keep roadmap safe for workspaces with 100+ projects

Recommended query plan:

- one base project query for visible roadmap projects
- one grouped issue-count aggregation
- one grouped milestone-summary aggregation
- one grouped dependency-summary aggregation
- reuse Phase 14 analytics service outputs where practical

Recommended response behavior:

- select only columns needed for list rows
- return summary counts in list payload
- keep project detail expansion separate from the list endpoint

---

## 15. DB and Contract Verification Checklist

After implementation, verify:

1. `ProjectMilestone` and `ProjectDependency` tables exist with required indexes.
2. `/roadmap` returns real DB-backed items instead of mock project bars.
3. `teamId` filtering works for the sidebar team-scoped roadmap link behavior.
4. `MONTH` and `QUARTER` windows return correct `previous` and `next` metadata.
5. Unscheduled projects are excluded by default and available when requested.
6. Schedule updates reject invalid ranges and return conflict payloads where required.
7. Milestone CRUD and reorder operate only within project/workspace scope.
8. Dependency create rejects self-links, duplicates, and cycles.
9. Blocked state updates correctly after dependency resolve/cancel.
10. Health and forecast are backend-derived, not stored as manual source-of-truth fields.
11. Activity rows are written for every roadmap mutation.
12. Notifications are only sent to same-workspace, relevant recipients.
13. Socket events fire for roadmap mutations.
14. Workspace isolation holds across all list/detail/mutation queries.
15. Build passes successfully.

---

## 16. Error Codes

Use explicit roadmap codes:

- `ROADMAP_DISABLED_FOR_PROJECT`
- `ROADMAP_INVALID_DATE_RANGE`
- `ROADMAP_SCHEDULE_CONFLICT`
- `ROADMAP_MILESTONE_NOT_FOUND`
- `ROADMAP_DEPENDENCY_DUPLICATE`
- `ROADMAP_DEPENDENCY_CYCLE`
- `ROADMAP_DEPENDENCY_CANCELLED`
- `ROADMAP_DEPENDENCY_INVALID_SCOPE`
- `ROADMAP_FORBIDDEN`

Standard response shape remains mandatory:

- success: `{ "success": true, "data": ... }`
- error: `{ "success": false, "error": { "code", "message", ... } }`

---

## 17. Implementation Order (Recommended)

1. Add Prisma models, enums, indexes, and migration.
2. Add `roadmap` module files and Zod schemas.
3. Implement `/roadmap` list endpoint with real date-window logic.
4. Implement `/roadmap/projects/:projectId` detail endpoint.
5. Implement schedule update with dependency conflict handling.
6. Implement milestone CRUD and reorder transaction.
7. Implement dependency create/resolve/cancel/delete with cycle validation.
8. Wire health, blocked-state, and forecast computation.
9. Wire activity, notifications, and socket events.
10. Run build and verification checklist.

---

## 18. Done Criteria

Phase 15 is complete when:

- `/roadmap` returns real timeline data from DB
- team-scoped roadmap works through backend filtering
- roadmap navigation windows are backend-driven
- monthly and quarterly views return correct timeline ranges
- project bars can be positioned from backend-provided schedule data
- milestones are persisted and manageable through CRUD endpoints
- milestone ordering is supported
- project dependencies are persisted, validated, and queryable
- blocked and overdue state is exposed in payloads
- health and forecast are computed by backend
- project detail roadmap tab can render from project-specific roadmap data
- roadmap mutations emit activity, notifications, and realtime updates
- roadmap endpoints enforce workspace isolation and role rules
- build passes
