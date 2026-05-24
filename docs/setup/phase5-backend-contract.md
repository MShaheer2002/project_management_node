# Phase 5 Backend Contract

This document translates Phase 5 from [build-phases.md](./build-phases.md) into the concrete backend contract the frontend needs in order to complete Issues.

Phases 0, 1, 2, 3, and 4 are assumed complete:

- Clerk auth works
- active workspace selection works
- workspace membership and invitations work
- teams and departments work
- projects work
- workspace-scoped requests already use `X-Workspace-Id`

This doc follows the architecture constraints in [rules.md](../architecture/rules.md):

- issue page data must come from real routes and real APIs, not frontend-only mock aggregation
- `/issues`, `/issues/create`, `/issues/:issueId`, and `/issues/my` must be stable and deep-linkable
- list, board, calendar, and dashboard issue data should all be fetchable through services and TanStack Query hooks without special-case response parsing
- feature UIs should not need custom backend branches just to support list vs board vs calendar views

## Goal

Phase 5 frontend needs backend support for:

- issue CRUD
- assignee and status updates
- searchable and paginated issue lists
- issue detail data
- subtask CRUD with reordering
- image/video attachments through the shared presigned upload flow
- issue data scoped by project, team, department, creator, and assignee
- dashboard issue summaries derived from real issue data

## Frontend Surfaces Blocked On Phase 5 APIs

The backend contract must support these UI surfaces:

- Issues list page
- Team detail issues tab
- Project detail issues tab
- Project detail board tab
- My Issues page
- Create issue page
- Create issue modal
- Issue detail page
- issue attachment uploader and detail attachment gallery
- issue side/context panel
- dashboard assigned-to-me and upcoming-deadline widgets
- team/project member performance analytics that derive from issue assignment and completion state

Important current frontend detail:

- the current issue UI already exposes `title`, `description`, `type`, `project`, `priority`, `status`, `assignee`, `labels`, `due date`, `due time`, `estimate`, `subtasks`, and type-specific fields
- the create issue page now supports direct image/video uploads before issue creation using the shared presigned upload feature
- the list page already exposes list, board, and calendar modes from the same issue dataset
- the issue detail page already exposes inline edits for `status`, `priority`, `assignee`, `due date`, `labels`, and delete
- the issue detail page now expects attachment records back for display
- the comments and activity tabs are visible in the UI, but real comment APIs belong to Phase 6

## Shared API Conventions

### Auth and workspace scope

- All `/issues` routes are authenticated.
- All workspace-scoped routes use `X-Workspace-Id`.
- Caller must already be a member of the active workspace.

### Success envelope

Frontend currently expects the standard success envelope:

```ts
type ApiResponse<T> = {
  success: true;
  data: T;
};
```

For paginated lists, frontend currently expects top-level `meta`:

```ts
type ApiPaginatedResponse<T> = {
  success: true;
  data: T[];
  meta: {
    total: number;
    cursor: string | null;
    hasMore: boolean;
  };
};
```

Do not return paginated issue lists as nested `data.items/pageInfo` unless the frontend is changed first.

### Error envelope

```ts
type ApiError = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, string[]>;
  };
};
```

### Roles

Backend should continue returning uppercase workspace roles:

- `OWNER`
- `ADMIN`
- `MEMBER`
- `GUEST`

### Pagination

Required query params on list-style routes:

- `cursor`
- `limit`
- `q`
- `sort`

Recommended defaults:

- default `limit`: `20`
- max `limit`: `100`
- default sort for full page lists: `updatedAt:desc`
- default sort for dashboard-style slices: `dueDate:asc` or `updatedAt:desc`, depending on widget intent

### Search

Search must be server-side and case-insensitive.

Recommended matching:

- issues: `id`, `title`, `description`
- related issue references: public issue keys like `LIN-101`

### Public identifier compatibility

The current frontend is built around human-readable issue keys such as `LIN-101`.

Current UI expectations:

- route: `/issues/:issueId`
- issue directory search matches the visible issue key
- issue detail breadcrumb shows the same public key
- related issues are entered as `LIN-101`, `LIN-102`, etc.

To avoid a full frontend rewrite in Phase 5:

- all issue detail/update/delete routes should accept the public issue key in `:id`
- issue payloads should expose `id` as the public issue key used by the UI
- if backend also needs an internal UUID, return it as a separate field such as `entityId`

Example:

```ts
type IssueIdentity = {
  id: string;       // "LIN-101" used by frontend routing and display
  entityId?: string; // optional internal UUID if backend needs it
};
```

### Enum wire values

Current frontend UI uses these values directly:

```ts
type IssueStatus = 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
type IssuePriority = 'low' | 'medium' | 'high' | 'urgent';
type IssueType = 'task' | 'bug' | 'issue';
type IssueSeverity = 'low' | 'medium' | 'high';
```

If the backend prefers uppercase enums such as `IN_PROGRESS`, the frontend service layer will need normalization. The simplest Phase 5 integration is to return the lowercase values above.

## Core Resource Shapes

### Issue summary

Used by:

- `/issues`
- team detail issues tab
- project detail issues tab
- project detail board tab
- My Issues page
- dashboard issue lists

```ts
type IssueSummary = {
  id: string;
  entityId?: string;
  title: string;
  description?: string | null;
  type: 'task' | 'bug' | 'issue';
  status: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  labels: string[];
  dueDate?: string | null;
  dueTime?: string | null;
  createdAt: string;
  updatedAt: string;
  creatorId: string;
  assigneeId?: string | null;
  projectId: string;
  teamId: string;
  departmentId?: string | null;
  creator: {
    id: string;
    name: string;
    email: string;
    avatar?: string | null;
  };
  assignee: {
    id: string;
    name: string;
    email: string;
    avatar?: string | null;
  } | null;
  project: {
    id: string;
    name: string;
  };
  team: {
    id: string;
    name: string;
  };
  department: {
    id: string;
    name: string;
    color?: string | null;
  } | null;
  subtaskStats: {
    total: number;
    completed: number;
  };
  attachmentCount?: number;
};
```

### Issue detail

Used by `/issues/:issueId`.

```ts
type IssueDetail = {
  id: string;
  entityId?: string;
  title: string;
  description?: string | null;
  type: 'task' | 'bug' | 'issue';
  status: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  labels: string[];
  dueDate?: string | null;
  dueTime?: string | null;
  estimate?: number | null;
  createdAt: string;
  updatedAt: string;
  creatorId: string;
  assigneeId?: string | null;
  projectId: string;
  teamId: string;
  departmentId?: string | null;
  creator: {
    id: string;
    name: string;
    email: string;
    avatar?: string | null;
  };
  assignee: {
    id: string;
    name: string;
    email: string;
    avatar?: string | null;
  } | null;
  project: {
    id: string;
    name: string;
  };
  team: {
    id: string;
    name: string;
  };
  department: {
    id: string;
    name: string;
    color?: string | null;
  } | null;
  subtasks: IssueSubtask[];
  stepsToReproduce?: string | null;
  expectedBehavior?: string | null;
  actualBehavior?: string | null;
  severity?: 'low' | 'medium' | 'high' | null;
  acceptanceCriteria?: string | null;
  relatedIssueKeys?: string[];
  notes?: string | null;
  attachments?: IssueAttachment[];
};
```

### Issue subtask

Used by:

- issue detail page
- issue side/context panel
- create issue page

```ts
type IssueSubtask = {
  id: string;
  title: string;
  completed: boolean;
  order: number;
};
```

### Issue attachment

Used by:

- create issue page
- issue detail page
- future issue edit flows

```ts
type IssueAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  kind: 'attachment' | 'video';
  key: string;
  assetUrl?: string | null;
  reference: string;
};
```

### Dashboard issue summary

Used by `/dashboard`.

```ts
type DashboardIssueSummary = {
  id: string;
  key?: string;
  title: string;
  status?: string;
  priority?: string;
  dueDate?: string | null;
};
```

Backend can satisfy the current dashboard UI by returning `id = LIN-N` and optionally `key = LIN-N`.

## Required Routes

```ts
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

No separate board or calendar endpoint is required. The same list route can power all three issue views if it supports the filters and fields defined here.

## Issue List Query Contract

### Required filters

The current frontend needs these query params on `GET /issues`:

- `q`
- `cursor`
- `limit`
- `sort`
- `status`
- `priority`
- `type`
- `assigneeId`
- `projectId`
- `teamId`
- `departmentId`
- `creatorId`

Example:

```http
GET /issues?q=oauth&projectId=proj_123&teamId=team_123&departmentId=dept_123&type=bug&status=in-progress&sort=updatedAt:desc&cursor=LIN-120&limit=25
```

### Why each filter is needed

- `q`: issues list page and My Issues page search
- `projectId`: project detail issues tab and project board tab
- `teamId`: team detail issues tab and `?team=` scoped issue directory
- `departmentId`: existing issue directory department dropdown
- `type`: issues list page and My Issues page type filter
- `assigneeId`: My Issues and assignment-based views
- `creatorId`: My Issues "Created by Me"
- `status`: board columns, completed tab, general filtering

### Sorting

Recommended sortable fields:

- `createdAt`
- `updatedAt`
- `priority`
- `dueDate`

Current list UI does not yet expose full sorting controls, but backend support now avoids another contract revision later.

### My Issues compatibility

`/issues/my` does not require a dedicated backend route if `GET /issues` supports the generic filters above.

The current tabs map to:

- `Assigned to Me`: `assigneeId=<currentUserId>` and frontend can exclude `done`
- `Created by Me`: `creatorId=<currentUserId>`
- `Completed`: `assigneeId=<currentUserId>&status=done`

Optional improvement:

- support `statusNot=done` or repeated `status` filters to make the assigned tab more efficient server-side

### Calendar compatibility

The current calendar view depends on issue due dates being present on the list payload.

Backend requirement:

- list payload must include `dueDate`
- if no due date exists, return `null`

## Create Issue Contract

### Route

```http
POST /issues
```

### Required request fields

The current create page and create modal need this payload shape:

```ts
type CreateIssueInput = {
  title: string;
  description?: string;
  type: 'task' | 'bug' | 'issue';
  projectId: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status?: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
  assigneeId?: string | null;
  labels?: string[];
  dueDate?: string | null;
  dueTime?: string | null;
  estimate?: number | null;
  subtasks?: Array<{
    title: string;
    order: number;
  }>;
  attachments?: Array<{
    fileName: string;
    contentType: string;
    size: number;
    kind: 'attachment' | 'video';
    key: string;
    assetUrl?: string | null;
    reference?: string;
  }>;

  // BUG only
  stepsToReproduce?: string;
  expectedBehavior?: string;
  actualBehavior?: string;
  severity?: 'low' | 'medium' | 'high';

  // ISSUE only
  acceptanceCriteria?: string;
  relatedIssueKeys?: string[];
  notes?: string;

  // Legacy frontend field currently visible in the create page
  departmentId?: string | null;
};
```

### Important create-time rules

- `projectId` is required because issues always belong to a project.
- Backend should derive `teamId`, `workspaceId`, and `departmentId` from the selected project.
- If client sends `departmentId`, backend should ignore conflicting values and derive the final department from project/team ownership.
- `status` should be accepted on create because the current issue page can preselect status from board quick-create flows.
- `assigneeId`, when present, must be validated as a workspace member.
- `relatedIssueKeys` should accept public issue keys like `LIN-101`.
- `labels` can remain a plain string array in Phase 5. A dedicated labels feature is not required yet.
- `attachments`, when present, are already uploaded object references from the presigned upload flow. The backend should validate and persist them, not try to upload file bytes again.

### Type-specific validation

`task`

- standard fields only

`bug`

- require `stepsToReproduce`
- require `expectedBehavior`
- require `actualBehavior`
- require `severity`

`issue`

- require `acceptanceCriteria`
- `notes` optional
- `relatedIssueKeys` optional

### Create response

Return the full created issue detail shape, not only an ID. The current UI benefits from being able to redirect immediately to the created issue or refresh relevant caches from one response.

## Issue Attachment Contract

### Current frontend flow

The current create-issue UI already performs attachment uploads before issue creation:

1. user selects image/video files
2. frontend requests presigned upload instructions
3. frontend uploads files directly to S3
4. frontend submits stable uploaded references with the issue create payload

This means attachment integration depends on two backend layers:

- the upload module
- the issue module

### Upload endpoints already expected by frontend

The frontend uses the existing upload feature contract from `docs/features/presigned-url-s3/frontend-integration.md`.

Required endpoints:

```http
POST /uploads/presigned-url
POST /uploads/presigned-urls
```

Frontend rules already implemented:

- selected files are image/video only
- images use upload `kind=attachment`
- videos use upload `kind=video`
- direct S3 upload uses returned presigned headers only
- auth and `X-Workspace-Id` go to the presign endpoint, not the S3 upload request

### Preferred issue-create contract

Because the UI uploads before the issue exists, the preferred Phase 5 contract is:

- `POST /issues` accepts an `attachments` array
- backend persists the uploaded references as issue attachment records during issue creation

This avoids a slower two-step create flow where frontend would have to:

1. create issue without attachments
2. wait for issue ID
3. call a second attachment endpoint

### Attachment request shape for create

```ts
type CreateIssueAttachmentInput = {
  fileName: string;
  contentType: string;
  size: number;
  kind: 'attachment' | 'video';
  key: string;
  assetUrl?: string | null;
  reference?: string;
};
```

Notes:

- `key` is the stable backend-side upload reference
- `assetUrl` is optional and should be stored when available for direct preview
- `reference` can be accepted as optional, but backend can also derive it as `assetUrl ?? key`

### Required detail response behavior

`GET /issues/:id` should return `attachments` directly inside the main detail payload.

The current frontend detail page expects enough metadata to render:

- previewable image/video items when `assetUrl` exists
- file name
- file type
- size
- external/open action when public URL exists

### Recommended follow-up routes for post-create edits

Even if create supports inline attachments, existing issues should still support attachment management after creation.

Recommended routes:

```http
POST   /issues/:id/attachments
DELETE /issues/:id/attachments/:attachmentId
```

Recommended post-create write payload:

```ts
type AddIssueAttachmentInput = {
  fileName: string;
  contentType: string;
  size: number;
  kind: 'attachment' | 'video';
  key: string;
  assetUrl?: string | null;
  reference?: string;
};
```

### Attachment rules the backend should enforce

- only uploaded references from the current workspace flow should be accepted
- only image/video attachments should be allowed for the current frontend UI
- `key` should be treated as the source of truth even when `assetUrl` is `null`
- deleting an issue should delete or detach its attachment records according to backend storage policy
- if `assetUrl` is unavailable, backend should still preserve the attachment using `key`

## Get Issue Detail Contract

### Route

```http
GET /issues/:id
```

### Requirements

- `:id` should accept the public issue key like `LIN-101`
- response should match `IssueDetail`
- subtasks must be included
- creator, assignee, project, team, and department references must be included

The current issue detail page and side/context panel both depend on a single payload having enough metadata to render the header, properties panel, and subtask section without extra join requests.

## Update Issue Contract

### Route

```http
PATCH /issues/:id
```

### Required update fields

The current issue detail UI needs partial updates for:

- `title`
- `description`
- `priority`
- `status`
- `assigneeId`
- `labels`
- `dueDate`
- `dueTime`
- `estimate`
- bug-only fields
- issue-only fields

Recommended request shape:

```ts
type UpdateIssueInput = Partial<{
  title: string;
  description: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
  assigneeId: string | null;
  labels: string[];
  dueDate: string | null;
  dueTime: string | null;
  estimate: number | null;
  stepsToReproduce: string | null;
  expectedBehavior: string | null;
  actualBehavior: string | null;
  severity: 'low' | 'medium' | 'high' | null;
  acceptanceCriteria: string | null;
  relatedIssueKeys: string[];
  notes: string | null;
}>;
```

### Assignment behavior

The current UI supports:

- assign issue during create
- reassign issue from detail page
- unassign issue from detail page

Backend requirement:

- `assigneeId: null` must clear assignment cleanly
- assignee must remain workspace-scoped and permission-checked

## Quick Status Update Contract

### Route

```http
PATCH /issues/:id/status
```

### Why this route is needed

The kanban board already performs quick drag-and-drop status changes. A lightweight status route is still useful even if `PATCH /issues/:id` also accepts `status`.

Recommended request:

```ts
type UpdateIssueStatusInput = {
  status: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
};
```

### Status model

The current board columns are:

- `backlog`
- `todo`
- `in-progress`
- `review`
- `done`

Any transition is acceptable for Phase 5. The backend does not need to enforce a linear workflow yet.

## Delete Issue Contract

### Route

```http
DELETE /issues/:id
```

### UI requirement

The issue detail page already exposes delete with confirmation. Backend must define real permission behavior here instead of leaving it ambiguous.

Recommended rule for Phase 5:

- `OWNER` and `ADMIN` can always delete
- project lead or team lead can delete issues inside their own scope
- creator delete permission is optional and should only be added intentionally

If the backend keeps the simpler `ADMIN+` delete rule from the base phase notes, that is acceptable, but the frontend should then hide delete for other roles.

### Delete response

Either is acceptable:

- `204 No Content`
- `200 { success: true, data: { id: "LIN-101" } }`

## Subtask Contracts

### Add subtask

```http
POST /issues/:id/subtasks
```

```ts
type CreateSubtaskInput = {
  title: string;
  order?: number;
};
```

### Update subtask

```http
PATCH /issues/:id/subtasks/:sid
```

```ts
type UpdateSubtaskInput = Partial<{
  title: string;
  completed: boolean;
  order: number;
}>;
```

### Delete subtask

```http
DELETE /issues/:id/subtasks/:sid
```

### Reorder subtasks

```http
PATCH /issues/:id/subtasks/reorder
```

```ts
type ReorderSubtasksInput = {
  items: Array<{
    id: string;
    order: number;
  }>;
};
```

### Subtask behavior required by current UI

- toggle complete/incomplete
- inline rename
- delete
- drag-and-drop reorder
- stable `order` persistence

## Dashboard Dependencies

After Phase 5, the dashboard should be driven by real issue data for:

- `stats.issuesCompleted`
- `stats.openIssues`
- `assignedToMe`
- `upcomingDeadlines`

That means issue queries or the dashboard aggregator must be able to compute:

- completed count
- open count
- assigned-to-current-user list
- due-soon list

## Business Rules The Frontend Depends On

- Issue always belongs to a project, team, and workspace.
- `departmentId` is derived from project/team ownership, not trusted directly from the client.
- `assigneeId` must be a workspace member.
- issue keys like `LIN-101` are unique within a workspace
- keys are never reused
- subtasks keep a stable `order` field for drag-and-drop reordering
- type-specific required fields are validated server-side

## Recommended Error Codes

```ts
ISSUE_NOT_FOUND
PROJECT_NOT_FOUND
PROJECT_NOT_IN_WORKSPACE
ASSIGNEE_NOT_WORKSPACE_MEMBER
INVALID_STATUS
INVALID_PRIORITY
INVALID_TYPE
INVALID_RELATED_ISSUE
SUBTASK_NOT_FOUND
FORBIDDEN
VALIDATION_ERROR
```

Recommended additional handling:

- return field-level `details` for create/update validation failures
- return `404` rather than leaking private resource existence when access is denied through a private project/team scope

## Visible Mock System Parameters UI

The create-issue UI already includes a real mock section for future system metadata:

- `Parent Linkage`
- `Sub-Dependencies`
- `Watchers (Group)`
- `Integration Ref`

This section is currently frontend-only and does not block core Phase 5 completion, but the backend should treat it as the next extension point after core issue CRUD is stable.

Important current frontend behavior:

- the main issue form shows only compact summary rows
- clicking a row opens a small overlay dialog, not an inline expanded panel
- each dialog uses a minimal search-first workflow
- selected items collapse back into short summaries in the main create form

Backend should treat this as a compact-picker contract, not a large page-within-a-page contract.

### Expected future data shape

```ts
type IssueSystemMeta = {
  parentIssueId?: string | null;
  dependencies?: Array<{
    issueId: string;
    relation: 'blocks' | 'blocked-by' | 'related';
  }>;
  watcherIds?: string[];
  integrationRefs?: Array<{
    id: string;
    provider: 'github' | 'jira' | 'slack' | 'notion' | 'custom';
    label?: string | null;
    externalId?: string | null;
    url?: string | null;
  }>;
};
```

### Current frontend interaction contract

#### 1. Parent Linkage

Main form behavior:

- one minimal summary row
- summary shows selected parent issue key or `None`
- click opens a small picker dialog
- selection is single-select
- selection is clearable

Dialog behavior:

- one search field at the top
- compact result rows only
- search by issue key or title
- result row shows:
  - issue key
  - title
  - status
- same-project issues should rank ahead of other issues when possible

Frontend payload needed for the parent picker:

```ts
type IssueCompactPickerRow = {
  id: string;        // public issue key like LIN-101
  title: string;
  status: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
  projectId: string;
};
```

#### 2. Sub-Dependencies

Main form behavior:

- one minimal summary row
- summary shows count like `2 linked` or `None`
- click opens a small picker dialog

Dialog behavior:

- one search field at the top
- current selected dependencies shown first
- each selected dependency exposes a relation selector:
  - `blocks`
  - `blocked-by`
  - `related`
- additional issue search results appear below
- duplicate picks should not be returned or should be filtered cleanly

Frontend payload needed:

```ts
type IssueDependencyPickerRow = {
  id: string;
  title: string;
  status: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
};

type IssueDependencyItem = {
  issueId: string;
  relation: 'blocks' | 'blocked-by' | 'related';
};
```

#### 3. Watchers (Group)

Main form behavior:

- one minimal summary row
- summary shows count like `3 selected` or `None`
- click opens a small picker dialog

Dialog behavior:

- one search field at the top
- compact member rows
- multi-select
- selected state shown inline
- row content is:
  - avatar or initials
  - member name
  - member email
  - role badge or selected state

Frontend payload needed:

```ts
type WatcherPickerRow = {
  id: string;
  name: string;
  email: string;
  avatar?: string | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';
};
```

#### 4. Integration Ref

Main form behavior:

- one minimal summary row
- summary shows count like `2 refs` or `None`
- click opens a small editor dialog

Dialog behavior:

- no search is required
- user can add multiple structured references
- each reference has:
  - provider
  - label
  - external ID
  - URL

Frontend payload needed:

```ts
type IssueIntegrationRef = {
  id: string;
  provider: 'github' | 'jira' | 'slack' | 'notion' | 'custom';
  label?: string | null;
  externalId?: string | null;
  url?: string | null;
};
```

### Backend model guidance

Recommended persistence model:

- `parentIssueId` as a nullable self-reference on `Issue`
- `IssueDependency` join model for issue-to-issue relations
- `IssueWatcher` join model for issue-to-user subscriptions
- `IssueIntegrationRef` child table for external references

Why this shape fits the UI:

- parent linkage is single-select and clearable
- dependencies are multi-select and each linked issue needs a relation type
- watchers are multi-select workspace members
- integration refs can be multiple and each ref needs structured fields, not one free-text string

### Recommended route split

To match the current frontend UI cleanly, backend work can be split into three buckets:

#### Reuse existing issue list route for compact issue pickers

The parent and dependency dialogs do not need separate bespoke endpoints if `GET /issues` supports a compact picker mode.

Recommended query:

```http
GET /issues?view=compact&q=lin&projectId=<projectId>&limit=8
```

Recommended compact response:

```ts
type ApiPaginatedResponse<IssueCompactPickerRow> = {
  success: true;
  data: Array<{
    id: string;
    title: string;
    status: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
    projectId: string;
  }>;
  meta: {
    total: number;
    cursor: string | null;
    hasMore: boolean;
  };
};
```

#### Reuse existing workspace member picker route for watchers

The watcher dialog does not need a new custom search endpoint if the workspace member search endpoint already supports compact results.

Recommended query:

```http
GET /workspaces/:workspaceId/members?view=compact&q=sarah&limit=10&sort=name:asc
```

Recommended compact response:

```ts
type ApiPaginatedResponse<WatcherPickerRow> = {
  success: true;
  data: Array<{
    id: string;
    name: string;
    email: string;
    avatar?: string | null;
    role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';
  }>;
  meta: {
    total: number;
    cursor: string | null;
    hasMore: boolean;
  };
};
```

#### Add issue-specific write routes for persisted system metadata

Once backend decides to persist these fields, the write layer should be explicit and resource-oriented.

### Recommended future routes

These routes are not required to finish core Phase 5, but they align cleanly with the visible UI:

```http
GET    /issues?view=compact&q=...                    — issue picker for parent/dependency dialogs
PATCH  /issues/:id                                  — support parentIssueId in the standard update payload

GET    /issues/:id/dependencies
POST   /issues/:id/dependencies
DELETE /issues/:id/dependencies/:dependencyId

GET    /issues/:id/watchers
POST   /issues/:id/watchers
DELETE /issues/:id/watchers/:userId

GET    /issues/:id/integration-refs
POST   /issues/:id/integration-refs
PATCH  /issues/:id/integration-refs/:refId
DELETE /issues/:id/integration-refs/:refId
```

### Recommended request payloads

Parent linkage can stay on the standard issue update route:

```ts
PATCH /issues/:id

type UpdateIssueParentInput = {
  parentIssueId: string | null;
};
```

Dependencies should use explicit relation payloads:

```ts
POST /issues/:id/dependencies

type CreateIssueDependencyInput = {
  issueId: string;
  relation: 'blocks' | 'blocked-by' | 'related';
};
```

Watchers should be simple member attachments:

```ts
POST /issues/:id/watchers

type AddIssueWatcherInput = {
  userId: string;
};
```

Integration refs should stay structured:

```ts
POST /issues/:id/integration-refs

type CreateIssueIntegrationRefInput = {
  provider: 'github' | 'jira' | 'slack' | 'notion' | 'custom';
  label?: string | null;
  externalId?: string | null;
  url?: string | null;
};
```

### Recommended read shape on issue detail

When these fields become real, `GET /issues/:id` should return them directly in the main issue detail payload so the frontend does not need four extra startup requests just to render one issue.

Recommended extension:

```ts
type IssueDetail = {
  // existing fields...
  parent?: {
    id: string;
    title: string;
    status: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
  } | null;
  dependencies?: Array<{
    issueId: string;
    relation: 'blocks' | 'blocked-by' | 'related';
    issue: {
      id: string;
      title: string;
      status: 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
    };
  }>;
  watchers?: WatcherPickerRow[];
  integrationRefs?: IssueIntegrationRef[];
};
```

### Rules the future backend should enforce

- all linked issues must belong to the same workspace
- parent issue should normally belong to the same workspace and preferably the same project scope unless cross-project parent links are intentionally supported
- parent issue cannot equal the current issue
- a dependency cannot point to the same issue
- duplicate watcher rows should be rejected or de-duplicated
- integration refs should accept either `externalId`, `url`, or both

### What the frontend will expect once this is real

- compact summary rows on the create/edit form
- small pop-up dialogs, not large inline expansion blocks
- search-first selection for issues and watchers
- persisted values returning on detail fetch without special-case hydration logic
- enough compact fields for the UI to render key, title, status, name, email, role, and reference metadata directly

## Out Of Scope For Phase 5

These UI shells exist today, including the visible system-parameters mock UI, but do not require backend completion in Phase 5:

- issue comments and threaded replies
- issue activity feed/history
- watchers
- dependencies and parent linkage
- integration references
- mentions/notifications driven from issue comments

Those belong to later phases even though placeholder UI already exists.
