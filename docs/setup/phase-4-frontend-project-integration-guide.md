# Phase 4 Frontend Project Integration Guide

This document tells frontend exactly how to integrate Projects against the Phase 4 backend.

Contract baseline:
- `/Users/admin/Documents/project_management/project_management_react/docs/setup/phase4-backend-contract.md`

Backend source of truth:
- [build-phases.md](./build-phases.md)
- [phase-4-backend-setup-guide.md](./phase-4-backend-setup-guide.md)

## Preconditions

Before integrating:
- Auth session is working (Clerk)
- Active workspace is selected
- `X-Workspace-Id` is added on workspace-scoped requests
- Team and department option queries are available from Phase 3

## Routes To Use

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

## Request Rules

- Send `X-Workspace-Id` on every route above.
- Use backend identity from auth session; never send `userId` for authorization.
- Use cursor pagination, not page-number pagination.

## Shared Response Shapes

Standard success:

```ts
type ApiResponse<T> = {
  success: true;
  data: T;
};
```

Paginated:

```ts
type ApiPaginatedResponse<T> = {
  success: true;
  data: T[];
  meta: {
    total: number;
    cursor: string | null;
    hasMore: boolean;
  };
};
```

Error:

```ts
type ApiError = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Array<{
      field: string;
      message: string;
      location: 'body' | 'params' | 'query';
    }>;
  };
};
```

## Query Contracts

### `GET /projects`

Supported query params:
- `q`
- `cursor`
- `limit`
- `sort`
- `view` (`compact | full`)
- `teamId`
- `departmentId`
- `leadId`
- `status`
- `visibility`

Recommended defaults:
- `limit=20`
- list sort default: `updatedAt:desc`
- picker sort: relevance then `name:asc`

Example:

```http
GET /projects?q=mobile&teamId=team_xxx&status=ACTIVE&visibility=PUBLIC&cursor=proj_xxx&limit=12&view=full
X-Workspace-Id: <workspaceId>
```

### `GET /projects/:id/members`

Supported query params:
- `q`
- `cursor`
- `limit`
- `sort`
- `view`
- `role`

## Create Flow

Frontend can omit slug. Backend generates unique slug from `name`.
If a generated/custom slug collides in the workspace, backend resolves it to a unique slug (no `409` slug conflict in current implementation).

Example request:

```json
{
  "name": "Mobile App Redesign",
  "description": "Q3 redesign work for iOS and Android",
  "teamId": "team_xxx",
  "departmentId": "dept_xxx",
  "leadId": "user_xxx",
  "memberIds": ["user_a", "user_b"],
  "visibility": "PRIVATE",
  "startDate": "2026-06-01",
  "targetDate": "2026-08-30",
  "features": {
    "roadmap": true,
    "cycles": true,
    "issueTracking": true
  }
}
```

Department note (current behavior):
- On create, backend normalizes/stores department from the selected team.
- On update, backend currently allows `departmentId` changes; prefer keeping it aligned with team to avoid inconsistent UI expectations.

## UI Integration Mapping

Projects page:
- `GET /projects?view=full`
- server-side `q`, `teamId`, `status`, `visibility`
- cursor pagination with `meta.cursor` and `meta.hasMore`

Project detail page:
- `GET /projects/:id`
- route must be deep-link stable on refresh

Create project modal:
- `POST /projects`
- option dependencies:
- `GET /teams?view=compact`
- `GET /departments?view=compact`
- `GET /workspaces/:workspaceId/members?view=compact`

Project members tab:
- `GET /projects/:id/members`
- `POST /projects/:id/members`
- `DELETE /projects/:id/members/:uid`

Project settings tab:
- `PATCH /projects/:id`
- archive via `PATCH /projects/:id` with `status=ARCHIVED`
- destructive delete via `DELETE /projects/:id`

Issue creation/filtering dependency:
- `GET /projects?view=compact`
- `GET /projects?teamId=<teamId>&view=compact`

## Frontend State Behavior

- On filter changes, reset cursor and cached pages before refetch.
- Deduplicate list rows by `id` when appending paginated responses.
- Prefer optimistic updates only for low-risk mutations; otherwise refetch list/detail.
- Keep detail and list caches synchronized after update/delete/member changes.

## Error Handling Branches

Expected HTTP/status branches:
- `401` unauthenticated
- `403` forbidden
- `404` missing or hidden resource
- `409` uniqueness conflicts
- `422` validation failure

Recommended code branches:
- `PROJECT_NAME_TAKEN`
- `PRIVATE_PROJECT_FORBIDDEN`
- `TEAM_NOT_IN_WORKSPACE`
- `VALIDATION_ERROR`

For `422`, map `error.details[]` entries (`field`, `message`, `location`) to field-level form errors.

## Out of Scope in Phase 4

Do not block release on:
- issue CRUD inside project tabs
- board persistence
- roadmap timeline backend
- project activity feed
- cycle analytics

Those are later phases even if shells already exist in UI.

## Frontend Done-When Checklist

- [ ] Create project works without manual slug input
- [ ] Project list supports search + filters + cursor pagination
- [ ] Project detail works on direct URL refresh
- [ ] Team/department filtered project lists work
- [ ] Project members list/add/remove works
- [ ] Archive and delete are distinct UI actions
- [ ] Private projects do not leak to unauthorized users
- [ ] Response parsing uses standard envelope only
