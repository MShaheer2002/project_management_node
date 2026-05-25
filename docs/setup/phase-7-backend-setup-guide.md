# Phase 7 Backend Setup Guide (Labels)

This document defines how to implement Phase 7 (Labels) in backend, aligned with:
- [build-phases.md](./build-phases.md)
- [rules.md](./rules.md)
- [phase7-labels-backend-contract.md](./phase7-labels-backend-contract.md)

## Goal

Ship production-ready label APIs for:
- Workspace-scoped label CRUD
- Issue label attach/remove
- Searchable label picker support
- Case-insensitive uniqueness + color validation
- Safe deletion behavior (remove mappings, keep issues)

## Scope

Required routes:

```txt
POST   /labels
GET    /labels
PATCH  /labels/:labelId
DELETE /labels/:labelId

POST   /issues/:issueId/labels
DELETE /issues/:issueId/labels/:labelId
```

## Implementation Order

1. Prisma schema/index review + migration
2. Add/update label error codes
3. Zod schemas (`label.schemas.ts`)
4. Label service (`label.service.ts`)
5. Label controller (`label.controller.ts`)
6. Label routes (`label.routes.ts`)
7. App wiring
8. Build + contract tests

Do not skip this order.

## 1) Prisma and Migration

Use existing models if present:
- `Label`
- `IssueLabel`

Ensure these guarantees:
- labels are workspace-scoped (`workspaceId`)
- `IssueLabel` is many-to-many join with uniqueness on `(issueId, labelId)`
- deleting label removes join rows only (issues remain)

Add/validate indexes and constraints:
- unique `(workspaceId, name)` minimum baseline
- recommended: store normalized name and enforce unique `(workspaceId, normalizedName)` for strict case-insensitive uniqueness
- index `(workspaceId, createdAt)` for admin list sorting
- `IssueLabel(issueId, labelId)` unique

If any guarantee is missing, create a new migration.

## 2) Error Codes

Add to `shared/errors/error-codes.ts` if missing:
- `LABEL_NOT_FOUND`
- `LABEL_ALREADY_EXISTS`
- `LABEL_INVALID_COLOR`
- `LABEL_NAME_INVALID`
- `LABEL_LIMIT_REACHED`
- `ISSUE_LABEL_LIMIT_REACHED`

Reuse existing:
- `ISSUE_NOT_FOUND`
- `FORBIDDEN`
- `VALIDATION_ERROR`

## 3) Zod Schemas (`modules/label/label.schemas.ts`)

Define:
- `createLabelSchema`
- `listLabelsSchema`
- `updateLabelSchema`
- `deleteLabelSchema`
- `attachIssueLabelsSchema`
- `removeIssueLabelSchema`

Validation requirements:
- `name`: trim, min 1, max 40
- `color`: strict hex format `#RRGGBB`
- `description`: nullable optional, max length (recommended 500)
- list query:
  - `q?: string`
  - `cursor?: string`
  - `limit?: number` (default 50, max 100)
  - `sort?: 'name:asc' | 'usage:desc'`
- `labelIds`: array of UUIDs, dedupe in service

## 4) Service Rules (`modules/label/label.service.ts`)

Mandatory behavior:
- every query must be workspace-scoped
- enforce case-insensitive name uniqueness in workspace
- enforce valid color persistence
- max labels per issue = 20
- max labels returned per picker request = 100

### Create Label

`createLabel(workspaceId, input)`
- normalize name for uniqueness checks:
  - trim
  - collapse multiple internal spaces to single spaces
  - lowercase for uniqueness comparison
- reject duplicates with `LABEL_ALREADY_EXISTS`
- return created label DTO

### List Labels

`listLabels(workspaceId, query)`
- case-insensitive name search by `q`
- cursor pagination (no offset)
- default sort `name:asc`
- support `usage:desc` using issue association count
- include `issueCount`

### Update Label

`updateLabel(workspaceId, labelId, input)`
- label must exist in workspace
- if renaming, re-run normalization + uniqueness check
- return updated label DTO

### Delete Label

`deleteLabel(workspaceId, labelId)`
- label must exist in workspace
- delete label row
- join rows removed via cascade/manual delete
- return `{ id }`

### Attach Labels To Issue

`attachLabelsToIssue(workspaceId, issueId, labelIds)`
- issue must exist in workspace
- every label must belong to same workspace
- dedupe label IDs
- enforce max 20 labels per issue
- attach idempotently (skip duplicates)
- return full issue label set

### Remove Label From Issue

`removeLabelFromIssue(workspaceId, issueId, labelId)`
- issue + label must belong to workspace
- delete one join row if present
- return full issue label set

## 5) Controller (`modules/label/label.controller.ts`)

Controller rules:
- no business logic
- parse validated params/body/query
- call service
- return standardized responses (`sendSuccess`, `sendList`)

Handlers:
- `create`
- `list`
- `update`
- `remove`
- `attachToIssue`
- `removeFromIssue`

## 6) Routes (`modules/label/label.routes.ts`)

Global label management:
- `POST /labels`
  - `authenticate`, `requireWorkspace`, `requireRole('ADMIN','OWNER')`, `validate(createLabelSchema)`
- `GET /labels`
  - `authenticate`, `requireWorkspace`, `requireRole('GUEST','MEMBER','ADMIN','OWNER')`, `validate(listLabelsSchema)`
- `PATCH /labels/:labelId`
  - `authenticate`, `requireWorkspace`, `requireRole('ADMIN','OWNER')`, `validate(updateLabelSchema)`
- `DELETE /labels/:labelId`
  - `authenticate`, `requireWorkspace`, `requireRole('ADMIN','OWNER')`, `validate(deleteLabelSchema)`

Issue label assignment:
- `POST /issues/:issueId/labels`
  - `authenticate`, `requireWorkspace`, `requireRole('MEMBER','ADMIN','OWNER')`, `validate(attachIssueLabelsSchema)`
- `DELETE /issues/:issueId/labels/:labelId`
  - `authenticate`, `requireWorkspace`, `requireRole('MEMBER','ADMIN','OWNER')`, `validate(removeIssueLabelSchema)`

## 7) App Wiring

Mount label routes in app registration:
- `app.use(labelRoutes)` or `app.use('/labels', labelRoutes)` based on route file design.

If issue-label routes are in label module, ensure no route conflicts with issue module.

## 8) Response Shape (Frontend Contract)

Label DTO:
- `id`
- `workspaceId`
- `name`
- `color`
- `description`
- `issueCount`
- `createdAt`
- `updatedAt`

Issue attach/remove response:
- `issueId`
- `labels: { id, name, color }[]`

For transitional compatibility with Phase 5 UI:
- keep existing `labels: string[]` in issue payloads
- add `labelObjects?: { id, name, color }[]`

## 9) Security and Isolation

- never access labels without workspace filter
- block cross-workspace label attach by validating all label IDs in workspace
- block cross-workspace issue access
- enforce role matrix exactly

## 10) Activity Side Effects

Emit activity events for downstream timeline/notifications:
- `LABEL_CREATED`
- `LABEL_UPDATED`
- `LABEL_DELETED`
- `ISSUE_LABEL_ADDED`
- `ISSUE_LABEL_REMOVED`

## 11) Test Matrix

Minimum tests:
- create label success
- duplicate name (case-insensitive) fails
- invalid color fails
- list search pagination stable
- update rename to existing fails
- delete label removes issue mappings
- attach labels to issue success + dedupe
- attach cross-workspace label fails
- enforce issue label max 20
- remove label from issue success
- role permission checks for admin/member/guest

## Done Criteria

- [ ] Label CRUD APIs implemented and workspace-safe
- [ ] Issue label attach/remove APIs implemented
- [ ] Case-insensitive uniqueness + color validation enforced
- [ ] Per-issue label limit enforced
- [ ] Structured label metadata available for issue UI
