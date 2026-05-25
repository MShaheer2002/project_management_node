# Phase 6 Backend Contract (Comments)

This document defines exactly what to implement for Phase 6 (Comments + Threads) from [build-phases.md](./build-phases.md), in a way the frontend can integrate immediately.

Phase 5 (issues) is assumed complete.

## Goal

Deliver issue collaboration via comments:

- Create comment on issue
- List issue comments
- Threaded replies with `parentId`
- Edit comment (author only)
- Delete comment (author or ADMIN/OWNER)
- Parent delete cascades replies

## Frontend Needs Covered

This backend contract supports:

- Issue detail comments tab
- Issue side/context panel comments tab
- Thread rendering using flat API data + `parentId`

## Routes to Implement

All routes are authenticated and workspace-scoped using existing middleware (`authenticate`, `requireWorkspace`).

1. `POST /issues/:id/comments`
2. `GET /issues/:id/comments`
3. `PATCH /comments/:id`
4. `DELETE /comments/:id`

## Permissions

Based on Phase 6 rules:

- `GUEST`, `MEMBER`, `ADMIN`, `OWNER` can create comments
- Only author can edit their own comment
- Author can delete own comment
- `ADMIN` and `OWNER` can delete any comment

## Data Model (Current Schema Alignment)

Current Prisma model already exists and should be used:

- `Comment.id` (UUID)
- `Comment.issueId`
- `Comment.authorId`
- `Comment.body`
- `Comment.parentId` (nullable)
- `Comment.createdAt`
- `Comment.updatedAt`

Threading relation:

- `parentId` references `Comment.id`
- `onDelete: Cascade` on parent relation
- deleting a parent comment deletes all replies (required by Phase 6)

No schema change is required for baseline Phase 6.

## Request/Response Contract

### 1) Create Comment

`POST /issues/:id/comments`

Request body:

```ts
type CreateCommentInput = {
  body: string;
  parentId?: string | null;
};
```

Validation:

- `body` required, trimmed, non-empty, max length (recommended: 20,000)
- `parentId` optional UUID
- if `parentId` provided, parent must exist and belong to same issue

Response (`200`):

```ts
type CommentDto = {
  id: string;
  issueId: string;
  parentId: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: {
    id: string;
    name: string | null;
    email: string;
    avatar: string | null;
  };
};
```

### 2) List Comments

`GET /issues/:id/comments`

Query params:

```ts
type ListCommentsQuery = {
  cursor?: string;
  limit?: number; // default 50, max 100
};
```

Rules:

- return comments ordered by `createdAt ASC`, then `id ASC`
- return flat list (frontend builds tree by `parentId`)
- workspace isolation is mandatory

Response (`200`):

```ts
type ListCommentsResponse = {
  data: CommentDto[];
  meta: {
    total: number;
    cursor: string | null;
    hasMore: boolean;
  };
};
```

### 3) Update Comment

`PATCH /comments/:id`

Request body:

```ts
type UpdateCommentInput = {
  body: string;
};
```

Rules:

- author only
- trimmed non-empty body required

Response: updated `CommentDto`.

### 4) Delete Comment

`DELETE /comments/:id`

Rules:

- author can delete own comment
- `ADMIN`/`OWNER` can delete any comment
- delete is hard delete (as Phase 6 requires cascade delete for replies)

Response (`200`):

```ts
{ success: true, data: { id: string } }
```

## Validation/Error Codes

Add or reuse these codes:

- `COMMENT_NOT_FOUND`
- `COMMENT_PARENT_NOT_FOUND`
- `COMMENT_PARENT_CROSS_ISSUE`
- `COMMENT_EDIT_FORBIDDEN`
- `COMMENT_DELETE_FORBIDDEN`
- `ISSUE_NOT_FOUND`
- `FORBIDDEN`
- `VALIDATION_ERROR`

## Backend Module Structure

Create new module:

```txt
modules/comment/
├── comment.routes.ts
├── comment.controller.ts
├── comment.service.ts
└── comment.schemas.ts
```

Also integrate routes into app mounting (same pattern used by other modules).

## Service-Level Rules

`comment.service.ts` should enforce:

- issue must exist in workspace before create/list
- parent comment (if provided) must belong to same issue
- author checks on update
- author-or-admin/owner checks on delete
- return author profile in every comment row

## Implementation Plan (What To Do)

1. Add `comment.schemas.ts` with:
- create schema (`params.id`, `body.body`, optional `body.parentId`)
- list schema (`params.id`, query cursor/limit)
- update schema (`params.id`, `body.body`)
- delete schema (`params.id`)

2. Add `comment.service.ts` with:
- `createComment(workspaceId, userId, input)`
- `listIssueComments(workspaceId, issueId, query)`
- `updateComment(workspaceId, commentId, userId, input)`
- `deleteComment(workspaceId, commentId, userId, role)`

3. Add `comment.controller.ts`:
- parse validated input
- call service
- send standardized `sendOk/sendList` responses

4. Add `comment.routes.ts`:
- attach middleware chain consistent with existing modules
- expose issue-scoped create/list and global comment update/delete

5. Register comment routes in main app router.

6. Add error codes in `shared/errors/error-codes.ts`.

7. Add tests for core flows.

## Minimal Test Matrix

- create top-level comment
- create reply comment with valid `parentId`
- reject reply when parent is from another issue
- list returns ASC order and correct pagination meta
- author can edit own comment; non-author cannot
- author can delete own comment
- admin can delete other user comment
- deleting parent deletes reply chain (cascade)
- guest can create comment

## Done Criteria

- [ ] All 4 Phase 6 routes implemented and documented
- [ ] Threading via `parentId` works with flat list response
- [ ] Permission rules match Phase 6 exactly
- [ ] Parent delete cascade verified in tests
- [ ] Frontend comments UI works without mock data
