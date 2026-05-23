# Team Module — Integration Guide

> This guide explains how the team backend is implemented and how the frontend should integrate with it.

---

## 1. Architecture

Team requests follow the standard backend chain:

`Route → authenticate → validate → requireWorkspace → permission guard → controller → service → Prisma`

Implementation is split into:

- [team.routes.ts](/Users/admin/Documents/project_management/project_management_node/modules/team/team.routes.ts:1)
- [team.controller.ts](/Users/admin/Documents/project_management/project_management_node/modules/team/team.controller.ts:1)
- [team.service.ts](/Users/admin/Documents/project_management/project_management_node/modules/team/team.service.ts:1)
- [team-membership.service.ts](/Users/admin/Documents/project_management/project_management_node/modules/team/team-membership.service.ts:1)
- [team.schemas.ts](/Users/admin/Documents/project_management/project_management_node/modules/team/team.schemas.ts:1)

---

## 2. Frontend Contract

All `/teams` routes are workspace-scoped through `X-Workspace-Id`.

Paginated responses use backend-standard top-level `meta`:

```json
{
  "success": true,
  "data": [],
  "meta": {
    "total": 0,
    "cursor": null,
    "hasMore": false
  }
}
```

Do not expect:

- nested `data.items`
- nested `pageInfo`

The frontend should normalize around:

- `data` for rows
- `meta.cursor` for the next request
- `meta.hasMore` for infinite loading

---

## 3. Visibility and Permissions

- `POST /teams`: `MEMBER`, `ADMIN`, `OWNER`
- `PATCH /teams/:id`: `ADMIN`, `OWNER`, or the team lead
- `DELETE /teams/:id`: `ADMIN`, `OWNER`
- team member add/remove: `ADMIN`, `OWNER`, or the team lead
- read routes: any workspace member if visible

Guests cannot access private teams. Private teams return `404 PRIVATE_TEAM_FORBIDDEN` rather than `403`.

---

## 4. Key Backend Decisions

### Case-insensitive uniqueness

Team names are unique per workspace, case-insensitively.

### Lead must be a workspace member

`leadId` is a Clerk user ID. The backend checks membership before create and update.

### Lead is auto-added to the team

The lead is automatically included in `TeamMembership` on create and when reassigned.

### Department is optional

Teams can exist without a department. The frontend should always support a `null` department.

### Changing department updates denormalized children

When a team’s `departmentId` changes, the backend also updates:

- `project.departmentId`
- `issue.departmentId`

for existing records in that team.

### Team lead cannot be removed directly

`DELETE /teams/:id/members/:uid` returns `409 FORBIDDEN` if the target user is the current lead. Reassign the lead first through `PATCH /teams/:id`.

---

## 5. Picker and Screen Usage

Recommended frontend usage:

- team directory: `GET /teams?view=full`
- compact team picker: `GET /teams?view=compact&limit=10&q=<text>`
- team detail header: `GET /teams/:id`
- team members tab: `GET /teams/:id/members?view=full`

For lead and member pickers, use:

```http
GET /workspaces/:workspaceId/members?view=compact&limit=10&q=<text>
```

That endpoint now supports:

- `q`
- `cursor`
- `limit`
- `sort`
- `role`
- `view`

---

## 6. Team Detail Data Shape

The backend returns:

- `lead` as a full user summary
- `department` as `null` or a small summary
- `stats.memberCount`
- `stats.projectCount`
- `stats.issueCount` on detail only

This aligns with the phase 3 UI flow for:

- team directory cards
- team detail header
- team member tab

Projects, issues, cycles, and roadmap remain separate feature areas even though they use team context.

---

## 7. Known Limits

- `projectCount` and `issueCount` depend on later phases and may stay `0` in early integration
- there is no team image upload in phase 3
- there is no team activity endpoint yet
