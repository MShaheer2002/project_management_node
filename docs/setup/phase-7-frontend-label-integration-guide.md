# Phase 7 Frontend Label Integration Guide

This document defines how frontend should integrate Labels for Phase 7, including workspace label management and issue label assignment.

Backend references:
- [phase-7-backend-setup-guide.md](./phase-7-backend-setup-guide.md)
- [phase7-labels-backend-contract.md](./phase7-labels-backend-contract.md)
- [build-phases.md](./build-phases.md)

## Preconditions

- Auth/session flow is working.
- Active workspace is selected.
- `X-Workspace-Id` is sent on workspace-scoped requests.
- Issue detail and issue list integrations from Phase 5 are in place.

## Core Routes

```txt
POST   /labels
GET    /labels
PATCH  /labels/:labelId
DELETE /labels/:labelId

POST   /issues/:issueId/labels
DELETE /issues/:issueId/labels/:labelId
```

## Response and Query Contract

Use standard envelopes:
- `ApiResponse<T>` for single-resource success
- `ApiPaginatedResponse<T>` with top-level `meta` for list

Label list query (`GET /labels`) supports:
- `q?: string`
- `cursor?: string`
- `limit?: number` (default 50, max 100)
- `sort?: 'name:asc' | 'usage:desc'`

## Frontend Types

```ts
type Label = {
  id: string;
  workspaceId: string;
  name: string;
  color: string; // #RRGGBB
  description?: string | null;
  issueCount?: number;
  createdAt: string;
  updatedAt: string;
};

type IssueLabel = {
  id: string;
  name: string;
  color: string;
};

type CreateLabelInput = {
  name: string;
  color: string;
  description?: string | null;
};

type UpdateLabelInput = {
  name?: string;
  color?: string;
  description?: string | null;
};

type AttachIssueLabelsInput = {
  labelIds: string[];
};
```

## Label Picker Integration

For create/edit issue screens:
- use `GET /labels` to populate picker
- use `q` for server-side search
- use cursor pagination for large workspaces
- render chip color from backend `color` only

For inline create (if enabled by role):
- call `POST /labels`
- append returned label to picker cache
- immediately include returned `id` in selected labels for issue attach

## Label Management Integration

Create label:
- `POST /labels`

Update label:
- `PATCH /labels/:labelId`

Delete label:
- `DELETE /labels/:labelId`

Expected validation behavior:
- name: 1..40 chars after trim
- color: `#RRGGBB`
- duplicate label names in same workspace rejected case-insensitively

## Issue Label Assignment Integration

Attach labels to issue:
- `POST /issues/:issueId/labels`
- body: `{ labelIds: string[] }`

Remove one label from issue:
- `DELETE /issues/:issueId/labels/:labelId`

Response for both returns:
- `issueId`
- full current `labels` array for the issue

Use that response to update issue detail UI immediately.

## Transitional Issue Shape

Backend keeps legacy names and adds structured labels:
- `labels: string[]` (legacy)
- `labelObjects?: { id, name, color }[]` (Phase 7)

Frontend should migrate rendering to `labelObjects` where available and keep fallback to `labels` during rollout.

## Permissions to Reflect in UI

- `OWNER`, `ADMIN`: create/update/delete global labels
- `MEMBER`: attach/remove labels on editable issues
- `GUEST`: read labels only

UI should gate actions by role, but still handle backend `403` responses.

## Error Handling

Handle by HTTP and `error.code`:
- `401` unauthenticated
- `403` forbidden
- `404` not found
- `409` conflict
- `422` validation

Label-specific codes:
- `LABEL_NOT_FOUND`
- `LABEL_ALREADY_EXISTS`
- `LABEL_INVALID_COLOR`
- `LABEL_NAME_INVALID`
- `LABEL_LIMIT_REACHED`
- `ISSUE_LABEL_LIMIT_REACHED`
- `ISSUE_NOT_FOUND`
- `VALIDATION_ERROR`

For `422`, map `error.details` into field-level errors.

## Frontend State and Cache

Recommended query keys:
- labels list: `['labels', workspaceId, { q, sort }]`
- issue detail: `['issue', workspaceId, issueId]`
- issue list: `['issues', workspaceId, filters]`

After label mutations:
- create/update/delete label:
  - invalidate labels list cache
  - invalidate issue list/detail caches that render label chips
- attach/remove issue labels:
  - update issue detail from mutation response
  - invalidate issue list pages where chip state is shown

## Done-When Checklist

- [ ] Label picker loads and searches via `GET /labels`
- [ ] Label CRUD works for admin/owner roles
- [ ] Attach/remove labels on issue works from detail and side panel
- [ ] Issue chips render from structured `labelObjects`
- [ ] Role-based UI gating matches backend behavior
- [ ] Duplicate-safe pagination and cache invalidation are stable
