# Phase 8 Backend Contract (Global Activity Feed)

This document translates Phase 8 from [build-phases.md](./build-phases.md) into a frontend-ready backend contract for Activity across workspace, project, team, and issue scopes.

Phase 0 through Phase 7 are assumed complete.

## Goal

Deliver a production-grade activity timeline that powers:

- global `/activity` page
- project activity tab
- team activity tab
- issue activity tab and issue side panel activity tab

The feed must capture every relevant operational event (issue/task/bug lifecycle, status movement, comments, membership, scope changes) and return consistent payloads for timeline rendering.

## Frontend Surfaces Covered

- global activity page: [ActivityPage.tsx](/Users/admin/Documents/project_management/project_management_react/src/pages/ActivityPage.tsx)
- project detail activity tab: [ProjectDetailPage.tsx](/Users/admin/Documents/project_management/project_management_react/src/features/projects/pages/ProjectDetailPage.tsx)
- team detail activity tab: [TeamDetailPage.tsx](/Users/admin/Documents/project_management/project_management_react/src/features/team/pages/TeamDetailPage.tsx)
- issue detail activity tab: [IssueDetailPage.tsx](/Users/admin/Documents/project_management/project_management_react/src/pages/IssueDetailPage.tsx)
- issue side panel activity tab: [ContextPanel.tsx](/Users/admin/Documents/project_management/project_management_react/src/components/ContextPanel.tsx)
- issue timeline component: [IssueActivityTimeline.tsx](/Users/admin/Documents/project_management/project_management_react/src/features/issues/components/IssueActivityTimeline.tsx)

## In Scope (Phase 8)

- Unified activity storage + query API
- Scope-aware feed queries (`workspace`, `project`, `team`, `issue`)
- Rich filters (type, actor, entity type, date range)
- Pagination for infinite list and "Load more"
- Deterministic human-readable `message` from server
- Metadata payload for FE badges/icons and deep links

## Out Of Scope (Phase 8)

- Realtime push delivery (Phase 10)
- Notification inbox semantics (Phase 9)
- Full text search engine indexing
- Cross-workspace federation

## API Conventions

Reuse existing conventions from Phase 5+:

- authenticated routes
- workspace scoping via `X-Workspace-Id`
- standard success/error envelope
- cursor pagination (`meta.nextCursor`, `meta.hasMore`)

## Data Model

## `ActivityEvent`

Required fields:

- `id` (UUID)
- `workspaceId`
- `actorId` (nullable only for system events)
- `type` (enum)
- `targetType` (`workspace | project | team | issue | comment | label | member`)
- `targetId`
- `parentType` (optional container context, e.g. issue belongs to project)
- `parentId` (optional)
- `message` (server-rendered timeline text)
- `metadata` (JSON; event-specific details)
- `createdAt`

Indexes:

- `(workspaceId, createdAt DESC)`
- `(workspaceId, targetType, targetId, createdAt DESC)`
- `(workspaceId, actorId, createdAt DESC)`
- `(workspaceId, type, createdAt DESC)`

## Activity Types (Minimum Required)

Issue lifecycle and workflow:

- `ISSUE_CREATED`
- `ISSUE_TYPE_CHANGED` (task/issue/bug)
- `ISSUE_STATUS_CHANGED` (todo -> in_progress)
- `ISSUE_PRIORITY_CHANGED`
- `ISSUE_ASSIGNEE_CHANGED`
- `ISSUE_DUE_DATE_CHANGED`
- `ISSUE_SCOPE_CHANGED` (team/project moved)
- `ISSUE_ARCHIVED`

Comment and collaboration:

- `COMMENT_CREATED`
- `COMMENT_EDITED`
- `COMMENT_DELETED`
- `COMMENT_MENTIONED`

Project and team:

- `PROJECT_CREATED`
- `PROJECT_UPDATED`
- `PROJECT_MEMBER_ADDED`
- `PROJECT_MEMBER_REMOVED`
- `TEAM_MEMBER_JOINED`
- `TEAM_MEMBER_REMOVED`
- `TEAM_MEMBER_ROLE_CHANGED`

Workspace:

- `WORKSPACE_MEMBER_JOINED`
- `WORKSPACE_MEMBER_REMOVED`

## Event Metadata Contract

Backend must provide metadata keys consistently so FE can render contextual text/actions:

Common metadata:

- `entityId` (public resource id like `LIN-105`)
- `entityTitle`
- `url` (frontend route for click-through)

Status change metadata:

- `fromStatus`
- `toStatus`

Assignment metadata:

- `fromAssignee` `{ id, name } | null`
- `toAssignee` `{ id, name } | null`

Scope change metadata:

- `fromProject` / `toProject`
- `fromTeam` / `toTeam`

Comment metadata:

- `commentId`
- `commentExcerpt` (max 140 chars)
- `parentCommentId` (for replies)

Membership metadata:

- `member` `{ id, name, email }`
- `roleBefore`
- `roleAfter`

## Feed Endpoints

## 1) Unified Activity Feed

`GET /activity`

Query:

```ts
type ListActivityQuery = {
  scope?: 'workspace' | 'project' | 'team' | 'issue';
  scopeId?: string;
  actorId?: string;
  types?: string; // comma-separated
  entityTypes?: string; // comma-separated targetType values
  from?: string; // ISO datetime
  to?: string; // ISO datetime
  cursor?: string;
  limit?: number; // default 50, max 100
};
```

Rules:

- If `scope=workspace`, `scopeId` is optional.
- If `scope` is `project|team|issue`, `scopeId` is required.
- Results are newest-first.

Response:

```ts
type ActivityActor = {
  id: string;
  name: string;
  email?: string;
  avatar?: string | null;
};

type ActivityItem = {
  id: string;
  type: string;
  message: string;
  createdAt: string;
  actor?: ActivityActor;
  target: {
    type: 'workspace' | 'project' | 'team' | 'issue' | 'comment' | 'label' | 'member';
    id: string;
    entityId?: string;
    name?: string;
    url?: string;
  };
  metadata?: Record<string, unknown>;
};

type ListActivityResponse = {
  data: ActivityItem[];
  meta: {
    nextCursor: string | null;
    hasMore: boolean;
  };
};
```

## 2) Issue-Scoped Compatibility Route

`GET /issues/:issueId/activity?cursor=<c>&limit=<n>`

This route remains available for [IssueActivityTimeline.tsx](/Users/admin/Documents/project_management/project_management_react/src/features/issues/components/IssueActivityTimeline.tsx), but should internally reuse the unified activity service with `scope=issue`.

## FE Rendering Requirements

Each row must provide enough data for the UI shown in the design:

- actor avatar + name (left cluster)
- event badge label from `type`
- timeline message text (e.g. `Shaheer created issue LIN-105`)
- relative timestamp source (`createdAt`)
- optional deep link target (`target.url`)

Backend owns message correctness. FE should not reconstruct business meaning from raw fields.

## Mapping for Current FE Components

For [ActivityPage.tsx](/Users/admin/Documents/project_management/project_management_react/src/pages/ActivityPage.tsx):

- replace mock `activity.description` with `message`
- replace mock `activity.timestamp` with formatted `createdAt`
- replace `activity.type` badge with backend `type`

For [IssueActivityTimeline.tsx](/Users/admin/Documents/project_management/project_management_react/src/features/issues/components/IssueActivityTimeline.tsx):

- expand type union from comment-only types to full issue timeline types
- keep pagination behavior (`Load more activity`)

## Side Effect Logging Rules

Activity creation is a side effect and must be emitted only after the primary transaction succeeds.

- create issue -> emit `ISSUE_CREATED`
- change status (todo/in progress/done/etc.) -> emit `ISSUE_STATUS_CHANGED`
- add/edit/delete comment -> emit matching comment event
- move issue across project/team -> emit `ISSUE_SCOPE_CHANGED`
- member joins/leaves team/project -> emit membership event

All emitters should call a single shared helper in `shared/utils/activity.ts`.

## Non-Functional Requirements

- Cursor pagination must be stable (no duplicates across pages)
- Query p95 under 200ms for typical workspace (10k-100k events)
- Metadata payload must be forward-compatible (unknown keys allowed)
- Message generation must be deterministic and localized-ready

## Done When

- [ ] Global `/activity` is fully backend-driven
- [ ] Project/team/issue activity tabs read from same unified store
- [ ] Issue events include type-aware messages (task/issue/bug + id)
- [ ] Status movement events include `from` and `to`
- [ ] Comment, scope, and membership events appear in feed
- [ ] FE can render avatar, badge, message, and timestamp with no mock fallback
