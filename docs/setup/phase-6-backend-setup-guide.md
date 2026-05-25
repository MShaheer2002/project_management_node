# Phase 6 Backend Setup Guide (Comments)

This document defines how to implement Phase 6 (Comments) in backend, aligned with:
- [build-phases.md](./build-phases.md)
- [rules.md](./rules.md)
- [phase6-backend-contract.md](./phase6-backend-contract.md)

## Goal

Ship production-ready issue comment APIs for:
- Create comments on issues
- Threaded replies using `parentId`
- List comments as flat rows (frontend builds tree)
- Edit comment (author only)
- Delete comment (author or ADMIN/OWNER)
- Parent delete cascading replies

## Scope

Required routes:

```txt
POST   /issues/:id/comments
GET    /issues/:id/comments
PATCH  /comments/:id
DELETE /comments/:id
```

## Implementation Order

1. Confirm Prisma model/indexes (no schema change if already present)
2. Add comment error codes
3. Add Zod schemas (`comment.schemas.ts`)
4. Add service (`comment.service.ts`)
5. Add controller (`comment.controller.ts`)
6. Add routes (`comment.routes.ts`)
7. Wire routes in app
8. Build and run contract tests

Do not skip this order.

## 1) Prisma and Migration

Current schema already includes `Comment` with:
- `id`, `issueId`, `authorId`, `body`, `parentId`, `createdAt`, `updatedAt`
- self relation for threads
- `onDelete: Cascade` from parent comment to replies

Phase 6 expectation from build phases is cascade behavior.

Checklist:
- ensure `@@index([issueId])`
- ensure `@@index([parentId])`
- ensure no cross-workspace leakage in service queries (workspace is resolved via issue join)

No migration required unless local schema drift exists.

## 2) Error Codes

Add to `shared/errors/error-codes.ts` if missing:
- `COMMENT_NOT_FOUND`
- `COMMENT_PARENT_NOT_FOUND`
- `COMMENT_PARENT_CROSS_ISSUE`
- `COMMENT_EDIT_FORBIDDEN`
- `COMMENT_DELETE_FORBIDDEN`

Reuse existing:
- `ISSUE_NOT_FOUND`
- `FORBIDDEN`
- `VALIDATION_ERROR`

## 3) Zod Schemas (`modules/comment/comment.schemas.ts`)

Define:
- `createCommentSchema`
- `listCommentsSchema`
- `updateCommentSchema`
- `deleteCommentSchema`

Validation requirements:
- route `:id` for issue/comment IDs: `z.string().min(1)`
- create/update body:
  - `body`: `trim`, `min(1)`, `max(20000)`
  - `parentId`: optional nullable UUID for create
- list query:
  - `cursor?: string`
  - `limit?: number` (coerce int, min 1, max 100, default in service)

## 4) Service Rules (`modules/comment/comment.service.ts`)

Mandatory behavior:
- every read/write must be workspace scoped
- issue in route must exist in workspace
- parent comment (if provided) must belong to same issue
- list ordered by `createdAt ASC`, then `id ASC`
- list returns flat rows; no server tree-building

### Create

`createComment(workspaceId, userId, issueId, input)`
- verify issue exists in workspace
- if `parentId` provided:
  - parent exists
  - parent.issueId === issueId
- create comment with `authorId=userId`
- return mapped DTO with author info

### List

`listIssueComments(workspaceId, issueId, query)`
- verify issue exists in workspace
- cursor pagination using existing pagination helper style
- include author fields required by frontend

### Update

`updateComment(workspaceId, commentId, userId, input)`
- fetch comment joined to issue.workspaceId
- reject if not found in workspace
- reject if `authorId !== userId` with `COMMENT_EDIT_FORBIDDEN`
- update body and return DTO

### Delete

`deleteComment(workspaceId, commentId, userId, role)`
- fetch comment joined to issue.workspaceId
- author can delete own comment
- `ADMIN`/`OWNER` can delete any comment
- others rejected with `COMMENT_DELETE_FORBIDDEN`
- hard delete comment
- cascade replies by DB relation

## 5) Controller (`modules/comment/comment.controller.ts`)

Controller rules:
- no business logic
- parse validated req params/body/query
- call service
- return standardized responses (`sendOk`, `sendList`, etc.)

Handlers:
- `create`
- `listByIssue`
- `update`
- `remove`

## 6) Routes (`modules/comment/comment.routes.ts`)

Use existing middleware chain patterns:

- `POST /issues/:id/comments`
  - `authenticate`
  - `requireWorkspace`
  - `requireRole("GUEST", "MEMBER", "ADMIN", "OWNER")`
  - `validate(createCommentSchema)`

- `GET /issues/:id/comments`
  - `authenticate`
  - `requireWorkspace`
  - `requireRole("GUEST", "MEMBER", "ADMIN", "OWNER")`
  - `validate(listCommentsSchema)`

- `PATCH /comments/:id`
  - `authenticate`
  - `requireWorkspace`
  - `requireRole("GUEST", "MEMBER", "ADMIN", "OWNER")`
  - `validate(updateCommentSchema)`

- `DELETE /comments/:id`
  - `authenticate`
  - `requireWorkspace`
  - `requireRole("GUEST", "MEMBER", "ADMIN", "OWNER")`
  - `validate(deleteCommentSchema)`

Permission nuance (author/admin/owner) stays in service.

## 7) App Wiring

Mount comment routes in app route registration alongside existing modules.

Keep route ownership clear:
- issue-scoped comment create/list may live in comment module routes
- comment ID update/delete also in comment module

## 8) Response Shape (Frontend Contract)

Return comment rows with:
- `id`
- `issueId`
- `parentId`
- `body`
- `createdAt`
- `updatedAt`
- `author: { id, name, email, avatar }`

List response includes pagination meta:
- `total`
- `cursor`
- `hasMore`

## 9) Security and Isolation

- never query comments without workspace scoping through issue relation
- prevent cross-issue replies via parent validation
- enforce author-only update
- enforce author-or-admin/owner delete

## 10) Test Matrix

Minimum tests:
- create top-level comment
- create reply comment (`parentId`)
- reject parent from another issue
- list ordering ascending and stable
- list cursor pagination works
- author can edit own comment
- non-author cannot edit
- author can delete own comment
- admin can delete another user's comment
- delete parent cascades all replies
- guest can create comment

## Done Criteria

- [ ] All 4 Phase 6 routes implemented
- [ ] Threading with `parentId` works
- [ ] Permission rules enforced exactly
- [ ] Cascade delete behavior verified by test
- [ ] Frontend comments tabs consume backend data without mock fallback
