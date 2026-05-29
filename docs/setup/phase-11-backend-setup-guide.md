# Phase 11 Backend Setup Guide (Cycles)

> Phase 11 adds team-scoped cycles as the execution layer.
> Follow existing architecture rules: Route -> Middleware -> Controller -> Service -> DB.

Backend references:
- [phase11-backend-contract.md](./phase11-backend-contract.md)
- [build-phases.md](./build-phases.md)
- [rules.md](./rules.md)

---

## 1. Prerequisites

Required completed phases:

- Phase 3 (teams/departments)
- Phase 4 (projects)
- Phase 5 (issues)
- Phase 8 (activity)
- Phase 9 (notifications)
- Phase 10 (socket realtime)

Required middleware stack for protected endpoints:

- `authenticate`
- `requireWorkspace`
- `requireRole`

---

## 2. Module Structure

Create module structure:

```txt
modules/cycle/
├── cycle.routes.ts
├── cycle.controller.ts
├── cycle.service.ts
└── cycle.schemas.ts
```

Keep rule alignment:

- controllers contain no business logic
- controllers do not use Prisma
- service contains lifecycle/permission-domain checks
- all workspace-scoped queries include `workspaceId`

---

## 3. Data Model Contract

Cycle model must include:

- `id`
- `workspaceId`
- `teamId`
- `name`
- `number` (team-scoped sequence)
- `description` nullable
- `goal` nullable
- `startsAt`
- `endsAt`
- `status: UPCOMING | CURRENT | COMPLETED`
- `completedAt` nullable
- `completedById` nullable
- `createdById`
- `createdAt`
- `updatedAt`

Issue relation:

- `Issue.cycleId` nullable FK to `Cycle`
- one issue belongs to at most one cycle at a time

Required constraints/indexes:

- unique `(teamId, number)`
- index `(workspaceId, teamId, status)`
- index `(workspaceId, startsAt, endsAt)`
- `Issue.cycleId` indexed

Run after schema update:

```bash
npx prisma generate
npx prisma migrate deploy
npm run build
```

---

## 4. Lifecycle Rules

Enforce in service layer:

- `startsAt < endsAt`
- only one `CURRENT` cycle per `(workspaceId, teamId)`
- default no overlapping windows for same team
- completed cycles are immutable unless explicit reopen operation
- completing a cycle does not auto-move unfinished issues
- carry-over is explicit operation only
- cannot assign issues to completed cycles

---

## 5. Endpoint Plan

Implement endpoints:

```txt
POST   /cycles
GET    /cycles
GET    /cycles/current
GET    /cycles/:id
PATCH  /cycles/:id
DELETE /cycles/:id
POST   /cycles/:id/complete
POST   /cycles/:id/reopen            # recommended for completed-cycle edits
POST   /cycles/:id/carry-over
POST   /issues/:id/cycle
DELETE /issues/:id/cycle
```

### Role expectations

- read/list/current/detail: `GUEST`, `MEMBER`, `ADMIN`, `OWNER`
- create/update/complete/carry-over/assign/remove: `MEMBER`, `ADMIN`, `OWNER`
- reopen completed cycle: `ADMIN`, `OWNER`

Contextual team rule (recommended):

- `MEMBER` manage cycles for teams they belong to
- `ADMIN`/`OWNER` manage any team in workspace

---

## 6. Request Validation (Zod)

`cycle.schemas.ts` should validate:

- params IDs (UUID or route format used by module)
- date-time values for `startsAt`/`endsAt`
- list query filters:
  - `teamId?`
  - `status?`
  - `from?`
  - `to?`
  - `cursor?`
  - `limit?` (bounded)
- carry-over body:
  - target mode (`nextCycle` or `backlog`) and target cycleId when needed
- issue cycle assignment body:
  - `cycleId`

Invalid input returns `422 VALIDATION_ERROR`.

---

## 7. Service Responsibilities

### `createCycle`

- verify team exists in workspace
- enforce role/team membership access
- enforce non-overlap and single-current constraints
- assign next `number` per team
- infer initial status from date window (or explicit controlled status)
- log activity
- trigger notifications where relevant
- emit socket event

### `listCycles`

- workspace-scoped listing with filters
- cursor pagination
- include per-cycle summary stats
- support current/upcoming/completed views

### `getCycleById`

- workspace and visibility-safe fetch
- return cycle + stats + issue breakdown + rules flags
- include `canComplete/canCarryOver/canEditDates` booleans

### `updateCycle`

- block restricted fields for completed cycles unless reopened
- recheck overlap/current constraints on date/status changes
- log activity + emit realtime

### `deleteCycle`

- usually allow only upcoming (recommended)
- clear `Issue.cycleId` safely in transaction
- preserve issues
- log activity + emit realtime

### `completeCycle`

- set `status=COMPLETED`, `completedAt`, `completedById`
- calculate unfinished issue count
- return carry-over required flag
- log activity + notify impacted assignees/watchers if needed
- emit realtime

### `reopenCycle` (recommended)

- `ADMIN/OWNER` only
- move completed -> current/upcoming safely
- preserve audit event trail

### `carryOverCycleIssues`

- source cycle must be completed
- move unfinished issues explicitly:
  - to provided next cycle (same workspace/team)
  - or to backlog (`cycleId=null`)
- transactional update + activity + notification + realtime

### `assignIssueToCycle`

- verify issue + cycle in same workspace
- verify issue team matches cycle team
- block assigning to completed cycle
- set/replace `issue.cycleId`
- log activity + notify assignee/creator/watchers when relevant
- emit issue/cycle realtime update

### `removeIssueFromCycle`

- clear `issue.cycleId`
- log activity + optional notification
- emit realtime update

---

## 8. Response Contract

Follow standard format only.

Success:

```json
{ "success": true, "data": {} }
```

List:

```json
{ "success": true, "data": [], "meta": { "total": 0, "cursor": null, "hasMore": false } }
```

Error:

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [] } }
```

---

## 9. Stats and Breakdown Computation

Return cycle detail with:

- `stats`: total/completed/in-progress/todo/backlog/review/unfinished/progress
- time metrics: `daysTotal`, `daysElapsed`, `daysRemaining`, `timeElapsedPercent`
- breakdown:
  - by status
  - by priority
  - by type
  - by project (count + completedCount)

Implementation note:

- derive from issue rows scoped by `workspaceId + cycleId`
- keep computation deterministic and timezone-safe

---

## 10. Activity Integration (Phase 8)

Emit activity for each operation:

- cycle created
- cycle updated
- cycle completed
- cycle reopened
- cycle deleted
- issue assigned to cycle
- issue removed from cycle
- cycle carry-over executed

Metadata should include:

- `cycleId`, `cycleName`, `teamId`
- `issueId` for issue-cycle operations
- previous/new values where applicable

---

## 11. Notification Integration (Phase 9)

Create notifications for user-impacting events:

- issue moved into cycle (assignee)
- issue removed from cycle (assignee)
- carry-over moved assigned issue (assignee)
- cycle completed with unfinished assigned issues (assignee/watchers/creator as policy)

Use existing notification service patterns:

- dedupe keys
- actor self-exclusion
- workspace membership checks

Recommended notification types:

- `UPDATE` for issue cycle field changes
- optional future type extension for cycle-specific notification

---

## 12. Realtime Integration (Phase 10)

Emit socket events after successful DB mutations:

Workspace room (`workspace:<workspaceId>`):

- `cycle:created`
- `cycle:updated`
- `cycle:deleted`
- `cycle:completed`
- `cycle:reopened`
- `cycle:carry-over`

Issue/workspace updates:

- include issue update event when `cycleId` changes

Use standard envelope:

- `id`, `type`, `workspaceId`, `createdAt`, `dedupeKey?`, `payload`

---

## 13. Transactions and Safety

Use `prisma.$transaction()` for:

- create cycle with number allocation + validations
- complete cycle + carry-over dependency checks
- carry-over bulk issue movement
- delete cycle + issue detach
- issue move between cycles

Never leave partial state.

---

## 14. Error Codes (Recommended)

Add/standardize codes:

- `CYCLE_NOT_FOUND`
- `CYCLE_NAME_TAKEN` (if naming uniqueness enforced in team scope)
- `CYCLE_DATE_INVALID`
- `CYCLE_OVERLAP_NOT_ALLOWED`
- `CYCLE_CURRENT_ALREADY_EXISTS`
- `CYCLE_COMPLETED_IMMUTABLE`
- `CYCLE_COMPLETE_CARRY_OVER_REQUIRED`
- `CYCLE_TEAM_MISMATCH`
- `CYCLE_ASSIGN_COMPLETED_FORBIDDEN`
- `CYCLE_REOPEN_FORBIDDEN`

Return appropriate status:

- `404` not found
- `409` conflicts/state violations
- `422` validation
- `403` permission

---

## 15. App Wiring

Mount route module in [app.ts](/Users/admin/Documents/project_management/project_management_node/app/app.ts):

```ts
app.use(cycleRoutes);
```

Ensure middleware order remains unchanged and route registered before 404 handler.

---

## 16. Operational Checklist

- [ ] Prisma model/migration aligned to Phase 11 contract
- [ ] Cycle module files created (`routes/controller/service/schemas`)
- [ ] All queries workspace-scoped
- [ ] Team/member permission checks enforced
- [ ] Lifecycle constraints enforced (single current, overlap, immutability)
- [ ] Cycle stats/breakdown returned in detail
- [ ] Issue-cycle assign/remove endpoints implemented
- [ ] Complete + carry-over flows implemented transactionally
- [ ] Activity events emitted for all cycle operations
- [ ] Notifications emitted for impacted users
- [ ] Socket events emitted for cycle/issue updates
- [ ] `npm run build` passes

---

## 17. Suggested Frontend Integration Notes

Frontend should expect:

- list filters for current/upcoming/completed
- explicit carry-over flow at completion time
- realtime cycle/issue refresh from socket events
- notification updates for impacted assignees

