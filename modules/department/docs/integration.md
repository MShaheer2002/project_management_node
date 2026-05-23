# Department Module — Integration Guide

> This guide explains how the implemented department backend works and how the frontend should consume it.

---

## 1. Architecture

Department requests follow the standard backend flow:

`Route → authenticate → validate → requireWorkspace → permission guard → controller → service → Prisma`

Implementation is split into:

- [department.routes.ts](/Users/admin/Documents/project_management/project_management_node/modules/department/department.routes.ts:1)
- [department.controller.ts](/Users/admin/Documents/project_management/project_management_node/modules/department/department.controller.ts:1)
- [department.service.ts](/Users/admin/Documents/project_management/project_management_node/modules/department/department.service.ts:1)
- [department-membership.service.ts](/Users/admin/Documents/project_management/project_management_node/modules/department/department-membership.service.ts:1)
- [department.schemas.ts](/Users/admin/Documents/project_management/project_management_node/modules/department/department.schemas.ts:1)

`department.service.ts` owns CRUD and visibility logic. `department-membership.service.ts` owns member listing and membership mutations.

---

## 2. Frontend Contract

All department routes are workspace-scoped through `X-Workspace-Id`.

Paginated responses follow backend rules, not the earlier frontend draft:

```json
{
  "success": true,
  "data": [],
  "meta": {
    "total": 12,
    "cursor": "next-id-or-null",
    "hasMore": true
  }
}
```

This means the frontend should read:

- `response.data.data` for list items
- `response.data.meta.cursor` for the next cursor
- `response.data.meta.hasMore` for infinite scroll / load more

Not implemented:

- nested `pageInfo`
- top-level department icon output
- activity feed

---

## 3. Visibility and Permissions

Permissions are enforced in middleware, not in controllers.

- `POST /departments` and `DELETE /departments/:id`: `ADMIN`, `OWNER`
- `PATCH /departments/:id`: `ADMIN`, `OWNER`, or the department head
- member add/remove: `ADMIN`, `OWNER`, or the department head
- list/detail/member read routes: any workspace member

Guests cannot see private departments. The backend intentionally returns `404`, not `403`, to avoid leaking private resource existence.

Frontend should map:

- `PRIVATE_DEPARTMENT_FORBIDDEN` as hidden/not visible
- `FORBIDDEN` as visible resource but disallowed action

---

## 4. Key Backend Decisions

### Case-insensitive uniqueness

Department names are enforced case-insensitively within a workspace. `"Design"` and `"design"` conflict.

### Head must belong to the workspace

`headId` uses Clerk user IDs, not UUIDs. The backend verifies the selected head is a workspace member.

### Head is auto-added to the department

When a department is created or updated with a `headId`, the backend ensures the head also has a `DepartmentMembership`.

### Only one default department

If `isDefault = true` is set on create or update, any previous default department in that workspace is cleared inside the same transaction.

### Delete keeps teams alive

Deleting a department:

- removes department memberships
- sets `teams.departmentId = null`
- clears denormalized `project.departmentId`
- clears denormalized `issue.departmentId`

The team itself is not deleted.

---

## 5. Picker and Screen Usage

Recommended frontend usage:

- department page list: `GET /departments?view=full`
- department picker: `GET /departments?view=compact&limit=10&q=<text>`
- department detail: `GET /departments/:id`
- department members tab: `GET /departments/:id/members?view=full`

For department head and member pickers, use the workspace member endpoint:

```http
GET /workspaces/:workspaceId/members?view=compact&limit=10&q=<text>
```

That endpoint now supports `q`, `cursor`, `limit`, `sort`, `role`, and `view`.

---

## 6. Member Row Behavior

`GET /departments/:id/members?view=full` returns one `department` object and one best-fit `team` object per row.

The `team` field is limited to a team inside the same department when possible. Frontend should treat it as:

- nullable
- summary-only
- not a complete list of all teams that member belongs to

---

## 7. Known Limits

- `projectCount` and `issueCount` are returned from current DB state; in early phases they may still be `0`
- no icon field is returned even though the schema has `icon`
- no department activity API exists in phase 3
