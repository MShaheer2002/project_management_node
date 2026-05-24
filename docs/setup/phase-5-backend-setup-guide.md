# Phase 5 Backend Setup Guide (Issues)

This document defines how to implement Phase 5 (Issues) in backend, aligned with:
- [build-phases.md](./build-phases.md)
- [rules.md](./rules.md)
- [phase5-backend-contract.md](./phase5-backend-contract.md)

## Goal

Ship production-ready issue APIs for:
- Issue CRUD
- Quick status updates
- Rich filtering + cursor pagination
- Subtask CRUD + reorder
- Attachment persistence (image/video) via existing presigned upload flow
- Parent linkage + sub-dependencies + watchers + integration refs CRUD
- Workspace-safe assignment and visibility behavior

## Scope

Required routes:

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

Additional Phase 5 routes for attachments:

```txt
POST   /issues/:id/attachments
DELETE /issues/:id/attachments/:attachmentId
```

Additional Phase 5 routes for system parameters:

```txt
POST   /issues/:id/dependencies
DELETE /issues/:id/dependencies/:relatedId

GET    /issues/:id/watchers
POST   /issues/:id/watchers
DELETE /issues/:id/watchers/:userId

PATCH  /issues/:id/integration-ref
```

## Implementation Order

1. Prisma schema updates + migration  
2. Zod schemas (`issue.schemas.ts`)  
3. Issue service (`issue.service.ts`)  
4. Subtask service (`subtask.service.ts`)  
5. Attachment service (`issue-attachment.service.ts`)  
6. Controller (`issue.controller.ts`)  
7. Routes + middleware chain (`issue.routes.ts`)  
8. App wiring + build  
9. Contract tests

Do not skip this order.

## 1) Prisma and Migration

Phase 5 relies on existing `Issue` + `IssueSubtask` models. Validate these guarantees:
- `Issue.id` is public key (`LIN-N`)
- `Issue.internalId` exists for optional internal UUID use
- `@@unique([workspaceId, number])` exists for key sequence safety
- `IssueSubtask` has `issueId`, `title`, `completed`, `order`

Add production-grade persistence for system parameters:
- `parentIssueId String?` on `Issue` (self-reference, same workspace enforced in service)
- watcher join table:
  - `IssueWatcher(issueId, userId, createdAt)`
  - `@@id([issueId, userId])`
  - FK cascades from issue/user
- `integrationRef Json?` on `Issue` for provider-specific references
  - recommended shape: `{ provider, externalId, url?, metadata? }`

For dependencies:
- Reuse `IssueRelation` with explicit relation types for dependency semantics:
  - `BLOCKS`
  - `BLOCKED_BY`
- Do not create a duplicate dependency table.

Add production-grade persistence for attachments:
- `IssueAttachment` child table (recommended):
  - `id`
  - `issueId`
  - `workspaceId` (denormalized for safe filters)
  - `key` (S3/R2 object key from presigned upload response)
  - `fileName`
  - `contentType`
  - `size`
  - `kind` (`attachment | video`)
  - `assetUrl?` (optional CDN/public URL if available)
  - `createdById`
  - `createdAt`
- indexes:
  - `[issueId]`
  - `[workspaceId]`
  - unique `[issueId, key]` to prevent duplicate persistence
- on issue delete:
  - cascade delete attachment records in DB
  - object deletion from storage can be sync or queued, but must be documented

Add migration only if any field/index is missing. Migration rules:
- descriptive kebab-case name
- no editing old migration files

## 2) API Enum Strategy

Frontend contract uses lowercase wire enums:
- status: `backlog | todo | in-progress | review | done`
- priority: `low | medium | high | urgent`
- type: `task | bug | issue`
- severity: `low | medium | high`

Backend DB enums are uppercase. Choose one strategy and keep it consistent:
- Preferred: map lowercase API values <-> uppercase DB enums in schema/service layer
- Alternative: return uppercase and normalize in frontend service layer (requires frontend coordination)

## 3) Zod Schemas (`modules/issue/issue.schemas.ts`)

Define:
- `createIssueSchema`
- `listIssuesSchema`
- `issueIdParamsSchema`
- `updateIssueSchema`
- `updateIssueStatusSchema`
- `createSubtaskSchema`
- `updateSubtaskSchema`
- `deleteSubtaskParamsSchema`
- `reorderSubtasksSchema`
- `createIssueAttachmentsSchema`
- `deleteIssueAttachmentParamsSchema`
- `setParentIssueSchema`
- `addDependencySchema`
- `removeDependencyParamsSchema`
- `listWatchersSchema`
- `addWatchersSchema`
- `removeWatcherParamsSchema`
- `updateIntegrationRefSchema`

Validation requirements:
- `title`: trim, min 1, max 500
- `description`: max 50k
- `projectId`: required (UUID)
- `status`, `priority`, `type`: strict enums
- `assigneeId`: nullable, workspace-member validated in service
- list query supports: `q`, `cursor`, `limit`, `sort`, `status`, `priority`, `type`, `assigneeId`, `projectId`, `teamId`, `departmentId`, `creatorId`
- `limit` default 20, max 100
- parent linkage accepts public issue key (`LIN-N`) for compatibility
- watcher payload accepts `userIds: string[]` with dedupe
- integration ref schema validates provider + external identifier and caps metadata size
- attachment schema validates:
  - `attachments[]` on create/update payloads when provided
  - fields: `key`, `fileName`, `contentType`, `size`, `kind`, `assetUrl?`
  - allowed kinds only: `attachment`, `video`
  - allowed types only image/video

Type-specific create/update rules:
- `bug`: require `stepsToReproduce`, `expectedBehavior`, `actualBehavior`, `severity`
- `issue`: require `acceptanceCriteria`; `notes` optional
- `task`: no extra required fields

## 4) Service Rules (`modules/issue/issue.service.ts`)

Mandatory backend behavior:
- Every query includes `workspaceId` filter
- `projectId` must belong to active workspace
- Derive `teamId` and `departmentId` from project/team, never trust client ownership fields
- `assigneeId` must be workspace member
- `id` routes accept public key (`LIN-101`)
- parent/dependency/watcher operations are workspace-scoped and idempotent where applicable
- attachment operations are workspace-scoped and only persist already-uploaded references

### Issue key generation (atomic)

Use a transaction:
1. Increment `workspace.issueCounter`
2. Create issue with:
   - `number = counter`
   - `id = LIN-${counter}`

Never reuse issue IDs.

### List behavior

`GET /issues` must provide:
- server-side search (`id`, `title`, `description`)
- filters from contract
- cursor pagination (`meta.total`, `meta.cursor`, `meta.hasMore`)
- shared data shape usable for list/board/calendar

### Detail behavior

`GET /issues/:id` returns full detail including:
- creator, assignee, project, team, department
- subtasks
- type-specific fields

### Update behavior

`PATCH /issues/:id` supports partial updates and clean unassign:
- `assigneeId: null` clears assignment
- `parentIssueId` set/clear supported (`null` clears)
- `integrationRef` set/clear supported (`null` clears)

### Attachment behavior (production-grade)

Use existing upload module for bytes transfer:
- `POST /uploads/presigned-url`
- `POST /uploads/presigned-urls`

Issue service must only persist uploaded references, never upload bytes itself.

Create flow:
1. frontend requests presigned URLs (authenticated + workspace-scoped)
2. frontend uploads directly to storage
3. frontend calls `POST /issues` with `attachments[]`
4. backend validates + persists attachment rows transactionally with issue create

Post-create management:
- `POST /issues/:id/attachments` adds persisted references
- `DELETE /issues/:id/attachments/:attachmentId` removes one record
- `GET /issues/:id` returns `attachments[]` in detail payload

Validation and security rules:
- every attachment key must belong to active workspace key prefix
- only image/video types allowed for current Phase 5 UI
- reject duplicate keys for same issue
- preserve attachment even if `assetUrl` missing (key is canonical reference)
- never trust client for storage ownership without workspace prefix checks

### Quick status behavior

`PATCH /issues/:id/status` accepts lightweight status payload for board drag-drop.

### Delete behavior

Recommended:
- `OWNER | ADMIN` always allowed
- optionally include project/team lead rules only if implemented intentionally

### Parent linkage rules (production-grade)

- Parent and child must belong to same workspace.
- Parent and child cannot be identical (no self-parent).
- Prevent 2-node cycles (`A -> B` and `B -> A`) at minimum.
- Recommended: reject deeper cycles using ancestor traversal before write.
- Clearing parent (`parentIssueId = null`) is supported.

### Sub-dependency rules (production-grade)

- Dependencies are modeled using `IssueRelation` (`BLOCKS`/`BLOCKED_BY`).
- Both issues must exist in same workspace.
- Reject self-dependency.
- Enforce unique pair per type (`issueId`, `relatedId`, `type`).
- Write both directional semantics consistently:
  - either explicit dual-row strategy
  - or single canonical row with deterministic interpretation
- Choose one strategy and document it in code comments/tests.

### Watchers rules (production-grade)

- Watchers must be workspace members.
- Add watchers in batch; skip duplicates safely.
- Remove watcher is idempotent (second delete should not fail hard).
- Optionally auto-include creator/assignee at creation time only if product requires it.

### Integration ref rules (production-grade)

- Store sanitized object only (no secrets/tokens).
- Allowed providers must be enum-constrained in validation.
- Keep refs non-authoritative (display/linking metadata only).
- Never execute external calls based solely on stored integration ref without explicit integration auth checks.

## 5) Subtask Service Rules (`modules/issue/subtask.service.ts`)

Implement:
- create subtask
- update subtask (`title`, `completed`, `order`)
- delete subtask
- reorder subtasks (`[{ id, order }]`)

Ensure:
- issue ownership is workspace-scoped
- subtask belongs to issue before mutate
- reorder operation is transactional

## 6) Attachment Service Rules (`modules/issue/issue-attachment.service.ts`)

Implement:
- persist attachments at issue create (inline)
- add attachments to existing issue
- delete attachment by `attachmentId`

Ensure:
- issue lookup always includes `workspaceId`
- attachment key prefix matches workspace upload namespace
- createdBy tracked from `req.user.id`
- writes that combine issue + attachments use transactions

## 7) Middleware and Routes

Use full chain on protected routes:

```txt
authenticate -> requireWorkspace -> requireRole(...) -> validate(...)
```

No direct service calls from routes.

Recommended permissions:
- attachment add/remove: `MEMBER+`
- dependencies / parent updates: `MEMBER+`
- watcher add/remove: `MEMBER+`
- integration ref update: `MEMBER+` (or tighter if product decides)

## 8) Response Contract

Must match global API rules:

Success:
```json
{ "success": true, "data": {} }
```

List:
```json
{
  "success": true,
  "data": [],
  "meta": { "total": 0, "cursor": null, "hasMore": false }
}
```

Error:
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "details": []
  }
}
```

## 9) Recommended Error Codes

- `ISSUE_NOT_FOUND`
- `PROJECT_NOT_FOUND`
- `PROJECT_NOT_IN_WORKSPACE`
- `ASSIGNEE_NOT_WORKSPACE_MEMBER`
- `INVALID_STATUS`
- `INVALID_PRIORITY`
- `INVALID_TYPE`
- `INVALID_RELATED_ISSUE`
- `SUBTASK_NOT_FOUND`
- `ATTACHMENT_NOT_FOUND`
- `INVALID_ATTACHMENT_REF`
- `ATTACHMENT_TYPE_NOT_ALLOWED`
- `ATTACHMENT_KEY_WORKSPACE_MISMATCH`
- `PARENT_ISSUE_NOT_FOUND`
- `INVALID_PARENT_ISSUE`
- `ISSUE_CYCLE_DETECTED`
- `DEPENDENCY_ALREADY_EXISTS`
- `DEPENDENCY_NOT_FOUND`
- `WATCHER_NOT_WORKSPACE_MEMBER`
- `WATCHER_ALREADY_EXISTS`
- `WATCHER_NOT_FOUND`
- `INVALID_INTEGRATION_REF`
- `FORBIDDEN`
- `VALIDATION_ERROR`

## 10) Testing Matrix

Required verification before marking Phase 5 complete:
- create issue generates atomic `LIN-N` key
- list supports all filters and cursor pagination
- detail by public key returns full payload
- update supports partial edits and unassign
- quick status route updates status for board flow
- delete permission rules enforced
- subtask create/update/delete/reorder works
- create issue with inline attachments persists records
- add/remove attachment routes work for existing issues
- detail payload returns attachments
- cross-workspace key mismatch is rejected
- parent set/clear works with cycle prevention
- dependency add/remove works with uniqueness and workspace safety
- watcher list/add/remove works and is idempotent
- integration ref update/clear works with schema validation
- cross-workspace access blocked everywhere
- validation returns field-level details on 422

## Done-When Checklist

- [ ] All issue + subtask routes implemented and mounted
- [ ] Workspace isolation on every issue/subtask query
- [ ] Public key (`LIN-N`) route compatibility works
- [ ] Cursor pagination + server-side search works
- [ ] Type-specific validation is enforced
- [ ] Assignment membership checks are enforced
- [ ] Attachment persistence integrated with presigned upload flow
- [ ] Parent/dependency/watcher/integration-ref CRUD is implemented
- [ ] Cycle and self-link protections are enforced
- [ ] Response envelopes match frontend contract
- [ ] Build passes and core issue flows are test-covered
