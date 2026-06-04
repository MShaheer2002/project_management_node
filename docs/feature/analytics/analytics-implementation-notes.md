# Analytics Backend Implementation Notes

## What was implemented

Phase 14 analytics is now wired into the backend as a new `modules/analytics` slice.

Added files:
- `modules/analytics/analytics.routes.ts`
- `modules/analytics/analytics.controller.ts`
- `modules/analytics/analytics.service.ts`
- `modules/analytics/analytics.schemas.ts`
- `modules/analytics/analytics.utils.ts`

Mounted in:
- `app/app.ts`

## Schema and issue lifecycle changes

Updated `Issue` in `prisma/schema.prisma`:
- added `completedAt DateTime?`
- added index `@@index([workspaceId, completedAt])`

Added migration:
- `prisma/migrations/20260604090000_phase14_analytics_contract/migration.sql`

Migration behavior:
- adds `completedAt` if missing
- backfills existing `DONE` issues from `updatedAt`
- creates index on `workspaceId, completedAt`

Updated issue status transitions in `modules/issue/issue.service.ts`:
- when issue moves to `DONE`, `completedAt = new Date()`
- when issue moves away from `DONE`, `completedAt = null`
- applied in both `updateIssue()` and `updateIssueStatus()`

## Route contract

All analytics routes require:
- auth
- workspace context via `X-Workspace-Id`

Routes:
- `GET /analytics/workspace`
- `GET /analytics/projects/:id`
- `GET /analytics/teams/:id`
- `GET /analytics/members/:id`
- `GET /analytics/cycles/:id`
- `GET /analytics/export`

Query params supported by analytics endpoints:
- `period=7d|30d|90d|custom`
- `from=YYYY-MM-DD`
- `to=YYYY-MM-DD`

For `period=custom`, both `from` and `to` are required.

## Access rules actually enforced

Implemented access policy is:
- workspace analytics: `ADMIN`, `OWNER`
- project analytics: `MEMBER+`, but non-admin users must be able to access that project already
- team analytics: `MEMBER+`, but non-admin users must belong to that team
- member analytics: `ADMIN`/`OWNER` can view anyone, `MEMBER` can view only self
- cycle analytics: `MEMBER+`, but non-admin users must belong to the cycle's team
- export workspace analytics: admin only
- export team analytics: same access as team analytics
- export project analytics: same access as project analytics
- export member analytics: self for members, any member for admins/owners
- export cycle analytics: same access as cycle analytics

## Response structure

Standard analytics endpoints return the normal API envelope:

```json
{
  "success": true,
  "data": { ... }
}
```

`GET /analytics/export` does not return the normal JSON envelope.
It returns a downloadable file with:
- `Content-Disposition: attachment`
- `Content-Type` set to CSV, JSON, or PDF

## High-level implementation approach

### Shared utilities

`analytics.utils.ts` contains:
- date range resolution
- previous-period calculation
- trend calculation
- average resolution time calculation
- daily series building
- CSV serialization helper

### Workspace analytics

Built from workspace-scoped issues, teams, and memberships.

Returns:
- summary cards
- completion velocity
- issue breakdowns by status/priority/type
- team performance table
- top contributors table
- bottleneck table

### Project analytics

Built from project-scoped issues and project memberships.

Returns:
- progress
- scope changes
- burndown
- completion velocity
- status breakdown
- priority breakdown
- member workload table
- timeline health

### Team analytics

Built from team-scoped issues, team memberships, and cycles.

Returns:
- velocity summary
- average resolution time
- workload distribution
- completion rate per member
- overdue per member
- cycle comparison
- member performance table

### Member analytics

Built from assignee-scoped issues and actor-scoped activity logs.

Returns:
- assigned/completed/in-progress/overdue metrics
- completion rate trend
- average resolution time
- activity heatmap
- breakdown by project
- breakdown by team
- recent activity

### Cycle analytics

Built from cycle-scoped issues.

Returns:
- progress
- issue counts
- average resolution time
- burndown
- daily velocity
- status/priority/type breakdowns

## Export implementation

`GET /analytics/export` accepts:
- `scope=workspace|project|team|member|cycle`
- `scopeId` for non-workspace scopes
- `format=csv|json|pdf`
- period params

Behavior:
- `format=json` returns raw pretty-printed JSON file
- `format=csv` flattens summary/chart/table sections into a CSV export
- `format=pdf` returns a styled multi-section analytics report

## Validation and build status

Added Zod validation for:
- period/from/to
- project/team/member/cycle IDs
- export query

Build status at implementation time:
- `npm run build` passed

## Known limitations

This implementation is intentionally read-heavy and straightforward.
It favors correctness and contract clarity over aggressive SQL optimization.

Current limitations:
- some analytics are computed in application memory after scoped Prisma reads
- team workload is implemented as percentage of non-guest members with assigned open work
- export CSV is flattened for portability, not designed as a pixel-perfect spreadsheet layout
- PDF export is report-oriented: strong layout and sectioning, but charts are represented as structured sections/tables rather than rendered graphics
- there are no automated tests yet for the analytics module
