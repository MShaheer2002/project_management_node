# Phase 6 Frontend Comment Integration Guide

This document defines how frontend should integrate Comments for Phase 6, including threaded replies from a flat API list and comment attachments.

Backend references:
- [phase-6-backend-setup-guide.md](./phase-6-backend-setup-guide.md)
- [phase6-backend-contract.md](./phase6-backend-contract.md)
- [build-phases.md](./build-phases.md)

## Preconditions

- Auth/session flow is working.
- Active workspace is selected.
- `X-Workspace-Id` is sent on workspace-scoped requests.
- Issue detail fetch (`GET /issues/:id`) is already integrated from Phase 5.
- Upload module is available:
  - `POST /uploads/presigned-url`
  - `POST /uploads/presigned-urls`

## Core Routes

```txt
POST   /issues/:id/comments
GET    /issues/:id/comments
PATCH  /comments/:id
DELETE /comments/:id

POST   /comments/:id/attachments
DELETE /comments/:id/attachments/:attachmentId
```

## Response and Query Contract

Use standard envelopes:
- `ApiResponse<T>` for single-resource success
- `ApiPaginatedResponse<T>` with top-level `meta` for list

List query (`GET /issues/:id/comments`) supports:
- `cursor?: string`
- `limit?: number` (default backend behavior: 50, max 100)

Ordering:
- Always ascending by `createdAt` then `id`

## Frontend Types

```ts
type CommentAuthor = {
  id: string;
  name: string | null;
  email: string;
  avatar: string | null;
};

type IssueComment = {
  id: string;
  issueId: string;
  parentId: string | null;
  body: string;
  attachments?: CommentAttachment[];
  createdAt: string;
  updatedAt: string;
  author: CommentAuthor;
};

type CommentAttachment = {
  id: string;
  key: string;
  fileName: string;
  contentType: string;
  size: number;
  kind: 'attachment' | 'video';
  assetUrl?: string | null;
  createdAt?: string;
};

type CreateCommentInput = {
  body: string;
  parentId?: string | null;
  attachments?: CommentAttachmentInput[];
};

type UpdateCommentInput = {
  body: string;
  attachments?: CommentAttachmentInput[];
};

type CommentAttachmentInput = {
  key: string;
  fileName: string;
  contentType: string;
  size: number;
  kind: 'attachment' | 'video';
  assetUrl?: string | null;
};
```

## Create Comment Integration

Top-level comment:
- `POST /issues/:id/comments`
- body: `{ body: "..." }`

Reply comment:
- `POST /issues/:id/comments`
- body: `{ body: "...", parentId: "<comment-uuid>" }`

Validation expectations:
- `body` trimmed and non-empty
- `body` max length 20,000
- `parentId` must be a valid UUID if provided
- attachment items (if sent) must be valid uploaded references

## Comment Attachment Flow (Presigned Upload + Comment Persistence)

Create/reply with attachments:
1. User selects image/video files in comment composer.
2. Frontend requests presigned instructions from upload module.
3. Frontend uploads bytes directly to storage.
4. Frontend sends comment create payload with `attachments[]` references.

Add attachments after comment exists:
- `POST /comments/:id/attachments` with `attachments[]`
- remove one via `DELETE /comments/:id/attachments/:attachmentId`

Important:
- Auth + `X-Workspace-Id` are required for presign API calls.
- Direct S3 upload does not use app auth headers.
- Comment endpoints should persist uploaded references only (no byte upload through backend).

## List + Thread Build Integration

Fetch comments:
- `GET /issues/:id/comments?cursor=<cursor>&limit=<n>`

Backend returns a flat list. Frontend must build the thread tree using `parentId`.

Recommended tree-build approach:
1. Index comments by `id`
2. Create root list for `parentId === null`
3. Attach children under parent by `parentId`
4. Keep sibling order from API order (already stable)

If a parent is missing in current page window, render the child as root fallback until older pages load.

## Edit Comment Integration

- `PATCH /comments/:id`
- body: `{ body: "updated" }`

Rules to reflect in UI:
- Only author can edit
- On `403 COMMENT_EDIT_FORBIDDEN`, show permission error and revert optimistic state

## Delete Comment Integration

- `DELETE /comments/:id`

Rules to reflect in UI:
- Author can delete own comment
- `ADMIN` and `OWNER` can delete any comment
- Backend hard-deletes; if parent is deleted, replies cascade delete

UI behavior:
- Prefer optimistic removal from local thread
- On failure, rollback local state

## State, Pagination, and Cache Invalidation

Recommended query keys (example):
- comments list: `['issue-comments', workspaceId, issueId]`
- issue detail: `['issue', workspaceId, issueId]`

After mutations:
- create/update/delete comment:
  - invalidate comments list for the issue
  - optionally invalidate issue detail if it shows comment counts or activity snippets
- add/remove comment attachment:
  - invalidate comments list for the issue (or patch local cache for that comment row)

Pagination rules:
- keep appending pages by cursor
- dedupe by `id`
- stop when `meta.hasMore === false`

## Error Handling

Handle by HTTP status and `error.code`:
- `401` unauthenticated
- `403` forbidden
- `404` not found
- `409` conflict
- `422` validation

Comment-specific codes:
- `COMMENT_NOT_FOUND`
- `COMMENT_PARENT_NOT_FOUND`
- `COMMENT_PARENT_CROSS_ISSUE`
- `COMMENT_EDIT_FORBIDDEN`
- `COMMENT_DELETE_FORBIDDEN`
- `ISSUE_NOT_FOUND`
- `VALIDATION_ERROR`

For `422`, map `error.details` to field-level form errors.

## Permission Notes

Frontend role gates should match backend but never replace backend checks:
- allow create for `GUEST`, `MEMBER`, `ADMIN`, `OWNER`
- show edit only for comment author
- show delete for author and for `ADMIN`/`OWNER`
- always handle server `403`

## Suggested UI Wiring

Issue detail comments tab:
- load paginated comments list
- render thread tree
- top-level composer posts without `parentId`
- inline reply composer posts with `parentId`

Context/side panel comments tab:
- reuse same query key + thread transform
- keep mutation handlers shared with full-page comments tab

## Done-When Checklist

- [ ] Comments load from `GET /issues/:id/comments`
- [ ] Threaded replies render correctly from flat rows
- [ ] Create top-level comment works
- [ ] Reply with `parentId` works
- [ ] Create/reply comment with uploaded attachments works
- [ ] Add/remove attachment on existing comment works
- [ ] Author edit works and non-author edit is blocked in UI + handled from API
- [ ] Delete works for author/admin-owner and handles forbidden correctly
- [ ] Cursor pagination is stable and duplicate-safe
- [ ] Comments integration works in both full issue page and context panel
