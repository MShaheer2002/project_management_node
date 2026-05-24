# Phase 5 Frontend Issue Integration Guide

This document defines how frontend should integrate Issues for Phase 5, including attachments via the existing presigned upload flow.

Backend references:
- [phase-5-backend-setup-guide.md](./phase-5-backend-setup-guide.md)
- [phase5-backend-contract.md](./phase5-backend-contract.md)
- [build-phases.md](./build-phases.md)

## Preconditions

- Auth/session flow is working.
- Active workspace is selected.
- `X-Workspace-Id` is sent on workspace-scoped requests.
- Project/team/department option data from earlier phases is available.
- Upload module is available:
  - `POST /uploads/presigned-url`
  - `POST /uploads/presigned-urls`

## Core Routes

```txt
POST   /issues
GET    /issues
GET    /issues/:id
PATCH  /issues/:id
DELETE /issues/:id
PATCH  /issues/:id/status

POST   /issues/:id/subtasks
PATCH  /issues/:id/subtasks/:sid
DELETE /issues/:id/subtasks/:sid
PATCH  /issues/:id/subtasks/reorder
```

Attachments:

```txt
POST   /issues/:id/attachments
DELETE /issues/:id/attachments/:attachmentId
```

System parameters:

```txt
POST   /issues/:id/dependencies
DELETE /issues/:id/dependencies/:relatedId

GET    /issues/:id/watchers
POST   /issues/:id/watchers
DELETE /issues/:id/watchers/:userId

PATCH  /issues/:id/integration-ref
```

## Response and Query Contract

Use standard envelopes:
- `ApiResponse<T>` for single-resource success
- `ApiPaginatedResponse<T>` with top-level `meta` for lists

List query (`GET /issues`) must support:
- `q`, `cursor`, `limit`, `sort`
- `status`, `priority`, `type`
- `assigneeId`, `projectId`, `teamId`, `departmentId`, `creatorId`

Use cursor pagination only.

## Attachment Flow (Presigned Upload + Issue Persistence)

Frontend flow for create:
1. User selects image/video files.
2. Frontend requests presigned instructions from uploads module.
3. Frontend uploads bytes directly to storage.
4. Frontend sends `POST /issues` with stable attachment references.

Important:
- Auth + `X-Workspace-Id` go to presign endpoint, not to direct S3 PUT.
- Issue create/update endpoints should persist references, not upload bytes.

Recommended attachment item shape sent to issue endpoints:

```ts
type IssueAttachmentInput = {
  key: string;
  fileName: string;
  contentType: string;
  size: number;
  kind: 'attachment' | 'video';
  assetUrl?: string | null;
};
```

## Create Issue Integration

`POST /issues` should support:
- core issue fields
- type-specific fields
- `attachments?: IssueAttachmentInput[]`
- `status` optional (for board quick-create)

On success, frontend should receive full issue detail payload to:
- navigate directly to detail page
- refresh list/board/calendar caches

## Detail and Update Integration

`GET /issues/:id` should include:
- related entities (creator, assignee, project/team/department)
- subtasks
- attachments
- system parameter fields (parent/dependencies/watchers/integration-ref) when implemented

`PATCH /issues/:id` supports partial edits:
- `assigneeId: null` to unassign
- optional parent updates

Integration refs use dedicated route:
- `PATCH /issues/:id/integration-ref`

`PATCH /issues/:id/status` is the fast path for board drag-drop.

## Subtasks Integration

- add: `POST /issues/:id/subtasks`
- edit/toggle: `PATCH /issues/:id/subtasks/:sid`
- delete: `DELETE /issues/:id/subtasks/:sid`
- reorder: `PATCH /issues/:id/subtasks/reorder`

Persist and rely on stable `order`.

## Post-Create Attachment Management

Use:
- `POST /issues/:id/attachments` to add more uploaded refs later
- `DELETE /issues/:id/attachments/:attachmentId` to remove

Attachment add request shape:

```json
{
  "attachments": [
    {
      "key": "uploads/workspaces/<workspaceId>/attachment/2026/05/uuid.png",
      "fileName": "screenshot.png",
      "contentType": "image/png",
      "size": 245123,
      "kind": "attachment",
      "assetUrl": null
    }
  ]
}
```

Keep gallery/UI synced by refetching issue detail or invalidating detail query after mutation.

## Watchers Integration

List:
- `GET /issues/:id/watchers`

Add:
- `POST /issues/:id/watchers`
- request body:

```json
{
  "userIds": ["user_a", "user_b"]
}
```

Remove:
- `DELETE /issues/:id/watchers/:userId`

## Frontend State and Caching

- Use one shared issue list query for list/board/calendar modes.
- On any filter change, reset cursor and pagination pages.
- Deduplicate appended list results by `id`.
- Invalidate:
  - issue detail after update/subtask/attachment/system-parameter mutations
  - issue list after create/delete/status changes
  - dashboard slices after status/due/assignment changes

## Error Handling

Handle by HTTP and code:
- `401` unauthenticated
- `403` forbidden
- `404` missing/hidden resource
- `409` conflicts
- `422` validation

Common branch codes:
- `ISSUE_NOT_FOUND`
- `PROJECT_NOT_FOUND`
- `ASSIGNEE_NOT_WORKSPACE_MEMBER`
- `SUBTASK_NOT_FOUND`
- `ATTACHMENT_NOT_FOUND`
- `ATTACHMENT_TYPE_NOT_ALLOWED`
- `VALIDATION_ERROR`

For `422`, map `error.details` into field-level form errors.

## Permission Notes

- Issue delete is restricted to `ADMIN | OWNER` in current implementation.
- Frontend should hide/disable delete for other roles and still handle server-side `403`.

## Done-When Checklist

- [ ] Create issue works with project + type-specific validation
- [ ] List/board/calendar all run from `GET /issues` with filters
- [ ] Detail route `/issues/:id` works on direct refresh
- [ ] Quick status updates work for drag-drop
- [ ] Subtasks CRUD + reorder works
- [ ] Create issue with uploaded attachments persists and renders gallery
- [ ] Add/remove attachment on existing issue works
- [ ] Parent/dependency/watcher/integration-ref interactions are wired if enabled
- [ ] Cursor pagination + search are stable without duplicates
