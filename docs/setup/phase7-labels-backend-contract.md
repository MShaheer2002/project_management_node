# Phase 7 Backend Contract — Labels (Linear/Jira Style)

This document defines the backend contract required for Phase 7 labels so frontend can deliver a production-grade label system comparable to Linear/Jira.

References:
- [build-phases.md](./build-phases.md)
- [rules.md](../architecture/rules.md)
- [phase5-backend-contract.md](./phase5-backend-contract.md)
- [phase6-backend-contract.md](./phase6-backend-contract.md)

## Goal

Deliver a workspace-scoped label system with:
- global label management (create/update/delete/list)
- issue-label assignment/removal
- searchable label picker UX
- strict uniqueness, validation, and safe deletion behavior

## Frontend UI Surfaces To Support

Phase 7 backend must support labels across all active issue UI surfaces:

1. Create Issue page
- multi-select label picker
- search labels
- create missing label inline
- selected chips show color + name

2. Issue Detail page (full page)
- labels section shows colored chips
- add/remove label from issue without leaving page

3. Issue side panel
- same add/remove behavior as full page

4. Issues list/board/calendar rows
- labels render as compact colored chips from stored label metadata

## Product Behavior Requirements

## Workspace scope
- labels are workspace-scoped, not project-scoped
- no cross-workspace visibility

## Uniqueness
- label `name` unique per workspace (case-insensitive)
- normalize (trim, collapse spaces, lowercase for uniqueness check)

## Color model
- persist color as hex (`#RRGGBB`)
- backend validates format
- backend should return consistent color for every label (frontend must not guess)

## Safe deletion policy
- deleting a label removes issue associations (`IssueLabel` rows)
- deleting a label does not delete issues

## Limits
- max label name length: 40
- max labels per issue: 20
- max labels returned per picker request: 100

## API Routes

## Label management (workspace-scoped)

```txt
POST   /labels
GET    /labels
PATCH  /labels/:labelId
DELETE /labels/:labelId
```

## Issue-label assignment

```txt
POST   /issues/:issueId/labels
DELETE /issues/:issueId/labels/:labelId
```

---

## 1) Create label

`POST /labels`

Body:

```ts
type CreateLabelInput = {
  name: string;
  color: string; // #RRGGBB
  description?: string | null;
};
```

Response:

```ts
type Label = {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  description?: string | null;
  issueCount?: number;
  createdAt: string;
  updatedAt: string;
};
```

Validation:
- `name` required, trimmed, length 1..40
- `color` required, valid hex
- reject duplicate (case-insensitive)

---

## 2) List labels (for picker + admin)

`GET /labels?q=<query>&cursor=<cursor>&limit=<n>&sort=name:asc|usage:desc`

Default behavior:
- `sort=name:asc`
- `limit=50`

Response:

```ts
type ListLabelsResponse = {
  data: Label[];
  meta: {
    total: number;
    cursor: string | null;
    hasMore: boolean;
  };
};
```

Notes:
- case-insensitive search by `name`
- include `issueCount` for better picker ordering and admin screens

---

## 3) Update label

`PATCH /labels/:labelId`

Body:

```ts
type UpdateLabelInput = {
  name?: string;
  color?: string;
  description?: string | null;
};
```

Rules:
- if `name` changes, uniqueness check remains case-insensitive
- color format validated

Response: updated `Label`

---

## 4) Delete label

`DELETE /labels/:labelId`

Behavior:
- remove label row
- remove join rows in `IssueLabel`
- return success payload

Response:

```ts
{ success: true, data: { id: string } }
```

---

## 5) Attach labels to issue

`POST /issues/:issueId/labels`

Body:

```ts
type AttachIssueLabelsInput = {
  labelIds: string[];
};
```

Rules:
- issue must belong to workspace
- each label must belong to same workspace
- dedupe repeated IDs
- enforce per-issue max labels

Response (recommended for frontend simplicity):

```ts
{
  success: true,
  data: {
    issueId: string;
    labels: Label[];
  }
}
```

---

## 6) Remove label from issue

`DELETE /issues/:issueId/labels/:labelId`

Response:

```ts
{
  success: true,
  data: {
    issueId: string;
    labels: Label[];
  }
}
```

---

## Issue Resource Shape Upgrade (Phase 7)

Phase 5 returned `labels: string[]` for compatibility.

Phase 7 should return structured labels everywhere issue data appears:

```ts
type IssueLabel = {
  id: string;
  name: string;
  color: string;
};
```

For migration safety (recommended transitional contract):

```ts
type IssueSummary = {
  // existing fields...
  labels: string[];            // legacy compatibility
  labelObjects?: IssueLabel[]; // new phase 7 field
};
```

After frontend fully migrates, backend may deprecate plain string labels.

## Permissions

Workspace roles:
- `OWNER`, `ADMIN`: create/update/delete global labels
- `MEMBER`: attach/remove existing labels on issues they can edit
- `GUEST`: read labels only (no label mutate)

If your product policy allows MEMBER label creation, expose that explicitly. Default recommendation is ADMIN/OWNER only for global taxonomy hygiene.

## Error Codes

Add/confirm:
- `LABEL_NOT_FOUND`
- `LABEL_ALREADY_EXISTS`
- `LABEL_INVALID_COLOR`
- `LABEL_NAME_INVALID`
- `LABEL_LIMIT_REACHED`
- `ISSUE_LABEL_LIMIT_REACHED`
- `ISSUE_NOT_FOUND`
- `FORBIDDEN`
- `VALIDATION_ERROR`

## Activity and Notification Side Effects

Phase 7 should emit activity events:
- `LABEL_CREATED`
- `LABEL_UPDATED`
- `LABEL_DELETED`
- `ISSUE_LABEL_ADDED`
- `ISSUE_LABEL_REMOVED`

These power timeline/history and notifications in later phases.

## Performance Notes

- index: `(workspaceId, normalizedName)` unique
- index: `(workspaceId, createdAt)`
- index: `IssueLabel(issueId, labelId)` unique
- list labels with cursor pagination, not offset

## Testing Matrix

Must-have tests:
- create label success
- duplicate label (case-insensitive) fails
- invalid color fails
- list/search pagination stable
- update rename to existing fails
- delete label removes issue mappings
- attach labels to issue success + dedupe
- attach cross-workspace label fails
- remove label from issue success
- role permission enforcement

## Done Criteria

- [ ] Label CRUD APIs complete and workspace-safe
- [ ] Issue label attach/remove APIs complete
- [ ] Structured label metadata available for issue UI
- [ ] Validation/uniqueness/color rules enforced
- [ ] Activity events emitted for label operations
- [ ] Pagination + search stable for picker UX
- [ ] Phase 7 tests passing
