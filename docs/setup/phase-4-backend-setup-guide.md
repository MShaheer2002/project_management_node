# Phase 4 Backend Setup Guide (Projects)

This document defines how Phase 4 (Projects) is integrated in the backend.

Primary references:
- [build-phases.md](./build-phases.md)
- [rules.md](./rules.md)
- Frontend contract baseline: `/Users/admin/Documents/project_management/project_management_react/docs/setup/phase4-backend-contract.md`

## Goal

Deliver workspace-scoped project APIs with stable contracts for:
- Project CRUD
- Project members (list/add/remove)
- Search + filters + cursor pagination
- Project detail for deep links (`/projects/:id`)

## Scope

Phase 4 backend routes:

```txt
POST   /projects
GET    /projects
GET    /projects/:id
PATCH  /projects/:id
DELETE /projects/:id

GET    /projects/:id/members
POST   /projects/:id/members
DELETE /projects/:id/members/:uid
```

## Implementation Order

1. Prisma model and migration
2. Zod schemas
3. Service layer
4. Controller layer
5. Routes + middleware chain
6. App route registration
7. Tests

Do not change this order.

## 1) Prisma Model + Migration

Add/confirm `Project` and `ProjectMembership` with workspace scoping.

Required `Project` fields:
- `id`
- `workspaceId`
- `teamId`
- `departmentId?`
- `leadId?`
- `name`
- `slug`
- `description?`
- `status` (`ACTIVE | ARCHIVED | COMPLETED`)
- `visibility` (`PUBLIC | PRIVATE`)
- `startDate?`
- `targetDate?`
- `featureRoadmap` (bool)
- `featureCycles` (bool)
- `featureIssueTracking` (bool)
- `createdAt`
- `updatedAt`

Constraints/indexes:
- `@@unique([workspaceId, name])`
- `@@unique([workspaceId, slug])`
- index on `[workspaceId, updatedAt]`
- index on `[workspaceId, teamId]`
- index on `[workspaceId, departmentId]`
- index on `[workspaceId, status]`
- index on `[workspaceId, visibility]`

`ProjectMembership`:
- unique `[projectId, userId]`
- relation to workspace member/user (depending on existing model design)

Migration naming:
- descriptive kebab-case only (example: `phase-4-projects-core`)

## 2) Schemas (`modules/project/project.schemas.ts`)

Create these schemas:
- `createProjectSchema`
- `updateProjectSchema`
- `listProjectsQuerySchema`
- `projectIdParamsSchema`
- `listProjectMembersQuerySchema`
- `projectMemberParamsSchema`
- `addProjectMembersSchema`

Validation requirements:
- `name`: trim, min 2, max 120
- `slug`: optional on create, regex `^[a-z0-9-]+$`
- `description`: max 5000
- `startDate`/`targetDate`: ISO date format
- `status`: strict enum
- `visibility`: strict enum
- list query: `q`, `cursor`, `limit`, `sort`, `view`, `teamId`, `departmentId`, `leadId`, `status`, `visibility`
- members list query: `q`, `cursor`, `limit`, `sort`, `view`, `role`
- `limit` default `20`, max `100`

## 3) Service (`modules/project/project.service.ts`)

Service owns all business logic.

Mandatory rules:
- Every query is workspace-scoped (`where.workspaceId = ...`)
- Team must exist in same workspace
- Department normalization: response department follows owning team if needed
- `leadId` must be in workspace (and if enforced, in project members/team members)
- Member add/remove validates workspace membership
- Private visibility must not leak to unauthorized users

Slug behavior:
- If create payload omits slug, generate from `name`
- Ensure uniqueness in workspace, resolve collisions deterministically

List behavior:
- Case-insensitive server-side search (`name`, `description`, `slug`)
- Cursor pagination with `meta: { total, cursor, hasMore }`
- Support `view=compact|full`

Delete/archive behavior:
- `PATCH` with `status: ARCHIVED` is non-destructive
- `DELETE` is destructive (cascade rules from schema)

## 4) Controller (`modules/project/project.controller.ts`)

Controllers only:
- read validated params/query/body
- call service
- send standardized envelope

No Prisma access in controller.
No business logic in controller.

## 5) Routes (`modules/project/project.routes.ts`)

Use this chain on protected routes:

```txt
authenticate -> requireWorkspace -> requireRole(...) -> validate(...)
```

Recommended role policy:
- `POST /projects`: `MEMBER | ADMIN | OWNER`
- `GET /projects`, `GET /projects/:id`: `GUEST | MEMBER | ADMIN | OWNER` (with visibility filtering)
- `PATCH /projects/:id`, `DELETE /projects/:id`: `LEAD | ADMIN | OWNER` behavior enforced via role/ownership policy
- project members add/remove: `LEAD | ADMIN | OWNER`

## 6) Response Contracts

Success envelope:

```json
{ "success": true, "data": {} }
```

Paginated envelope:

```json
{
  "success": true,
  "data": [],
  "meta": { "total": 0, "cursor": null, "hasMore": false }
}
```

Error envelope:

```json
{
  "success": false,
  "error": { "code": "VALIDATION_ERROR", "message": "Invalid input", "details": {} }
}
```

## 7) Error Codes (Recommended)

- `PROJECT_NAME_TAKEN`
- `PROJECT_SLUG_TAKEN`
- `TEAM_NOT_IN_WORKSPACE`
- `DEPARTMENT_NOT_IN_WORKSPACE`
- `LEAD_NOT_WORKSPACE_MEMBER`
- `MEMBER_NOT_WORKSPACE_MEMBER`
- `PRIVATE_PROJECT_FORBIDDEN`
- `PROJECT_STATUS_INVALID`
- `VALIDATION_ERROR`

## 8) Test Matrix

Must pass before Phase 4 is marked complete:
- Create project with valid team/workspace
- Slug auto-generation when omitted
- List supports filters + search + cursor
- Cross-workspace access denied
- Private project visibility enforced
- Detail route works on direct ID load
- Update supports status/visibility/lead/team changes with validation
- Delete behavior distinct from archive
- Members list/add/remove works with pagination

## Done-When Checklist

- [ ] All Phase 4 routes implemented
- [ ] Workspace isolation enforced in every query
- [ ] Contract envelope matches frontend expectation
- [ ] Cursor pagination and search are server-side
- [ ] Private visibility is enforced
- [ ] Project members APIs are live
- [ ] Tests cover core success and authorization failure paths
