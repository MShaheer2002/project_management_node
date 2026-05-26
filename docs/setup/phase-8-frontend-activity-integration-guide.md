# Phase 8 Frontend Activity Integration Guide

This document defines how frontend should integrate Activity for Phase 8, including global feed, scoped timelines, and issue compatibility route.

Backend references:
- [phase-8-backend-setup-guide.md](./phase-8-backend-setup-guide.md)
- [phase8-backend-contract.md](./phase8-backend-contract.md)
- [build-phases.md](./build-phases.md)

## Preconditions

- Auth/session flow is working.
- Active workspace is selected.
- `X-Workspace-Id` is sent on workspace-scoped requests.
- Issue/project/team pages are already integrated from previous phases.

## Core Routes

```txt
GET /activity
GET /issues/:issueId/activity
```

Both routes are authenticated and workspace-scoped (`X-Workspace-Id` required).

## Query Contract

`GET /activity` supports:

- `scope?: 'workspace' | 'project' | 'team' | 'issue'`
- `scopeId?: string`
- `actorId?: string`
- `types?: string` (comma-separated)
- `entityTypes?: string` (comma-separated)
- `from?: string` (ISO datetime)
- `to?: string` (ISO datetime)
- `cursor?: string`
- `limit?: number` (default 50, max 100)

Rules:

- if `scope` is `project|team|issue`, send `scopeId`
- use cursor pagination only
- list is newest-first
- if scope filters are invalid, backend returns `422 VALIDATION_ERROR`

## Response Contract

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
  success: true;
  data: ActivityItem[];
  meta: {
    nextCursor: string | null;
    hasMore: boolean;
  };
};
```

Issue compatibility route (`GET /issues/:issueId/activity`) returns same shape.

## Full Activity Type Coverage

Frontend must support badge/icon mapping for all currently emitted and contract-defined types:

- `ISSUE_CREATED`
- `ISSUE_TYPE_CHANGED`
- `ISSUE_STATUS_CHANGED`
- `ISSUE_PRIORITY_CHANGED`
- `ISSUE_ASSIGNEE_CHANGED`
- `ISSUE_DUE_DATE_CHANGED`
- `ISSUE_SCOPE_CHANGED`
- `ISSUE_ARCHIVED`
- `COMMENT_CREATED`
- `COMMENT_EDITED`
- `COMMENT_DELETED`
- `LABEL_CREATED`
- `LABEL_UPDATED`
- `LABEL_DELETED`
- `ISSUE_LABEL_ADDED`
- `ISSUE_LABEL_REMOVED`
- `PROJECT_CREATED`
- `PROJECT_UPDATED`
- `PROJECT_MEMBER_ADDED`
- `PROJECT_MEMBER_REMOVED`
- `TEAM_MEMBER_JOINED`
- `TEAM_MEMBER_REMOVED`
- `TEAM_MEMBER_ROLE_CHANGED`
- `WORKSPACE_MEMBER_JOINED`
- `WORKSPACE_MEMBER_REMOVED`

Fallback rule:

- unknown `type` values must still render (generic badge + server `message`)

## UI Surface Mapping

Global activity page:
- call `GET /activity?scope=workspace`
- apply filters via query params

Project activity tab:
- `GET /activity?scope=project&scopeId=<projectId>`

Team activity tab:
- `GET /activity?scope=team&scopeId=<teamId>`

Issue activity tab / context panel:
- preferred: `GET /activity?scope=issue&scopeId=<issueId>`
- compatibility: `GET /issues/:issueId/activity`

Routing note:

- use compatibility route where existing issue timeline code already expects it
- migrate to unified route when consolidating feed hooks/shared data layer

## Rendering Rules

Each row uses backend payload directly:

- avatar/name from `actor`
- badge from `type`
- description from `message`
- timestamp from `createdAt`
- optional deep link from `target.url`

Do not reconstruct business messages in frontend.

## Metadata Usage Contract

`metadata` is event-specific. Frontend should read keys defensively (`unknown` safe parse).

Common keys:

- `entityId`
- `entityTitle`
- `url`
- `issueId`
- `projectId`
- `teamId`

Issue workflow keys:

- `fromType`, `toType`
- `fromStatus`, `toStatus`
- `fromPriority`, `toPriority`
- `fromAssigneeId`, `toAssigneeId`
- `fromDueDate`, `toDueDate`
- `fromProjectId`, `toProjectId`
- `fromTeamId`, `toTeamId`

Comment keys:

- `commentId`
- `parentCommentId`
- `commentExcerpt`

Label keys:

- `labelId`
- `labelName`
- `labelIds`
- `labelNames`
- `color`

Membership keys:

- `member`
- `roleBefore`
- `roleAfter`

## Filters Integration

Type filter:
- pass selected type list as comma-separated `types`

Entity filter:
- pass selected entity types via comma-separated `entityTypes`

Actor filter:
- send `actorId`

Date range filter:
- send `from` and `to` in ISO format

Scope filter UX:

- workspace feed: `scope=workspace` (default)
- project feed: `scope=project&scopeId=<projectId>`
- team feed: `scope=team&scopeId=<teamId>`
- issue feed: `scope=issue&scopeId=<issueId>`

## Pagination & State

Recommended query keys:

- global feed: `['activity', workspaceId, params]`
- issue feed: `['activity-issue', workspaceId, issueId, params]`

Pagination flow:

1. first request without cursor
2. append `data` rows
3. use `meta.nextCursor` for next request
4. stop when `hasMore` is `false`

Deduplicate by `id` when merging pages.

Cursor safety:

- if filter/scope changes, reset cursor and clear prior pages
- keep request params in query key so caches do not bleed across scopes

## Error Handling

Handle by HTTP + `error.code`:

- `401` unauthenticated
- `403` forbidden
- `404` scope entity not found
- `422` invalid query

Use generic timeline error states for feed failures and retry support.

## Permission & Visibility Expectations

- backend already enforces workspace/scope visibility
- frontend should still avoid exposing scope filters the current user cannot access
- handle `403`/`404` by showing empty or restricted-state timeline (not crash)

## Suggested Hook Surface

Recommended frontend data hooks:

- `useActivityFeed(params)` -> unified `/activity`
- `useIssueActivity(issueId, params)` -> compatibility route for existing issue timeline

Recommended mutation invalidations:

- on issue/comment/label/project/team/member mutations, invalidate relevant activity keys:
  - workspace feed key
  - scoped feed key(s) for affected entity

## Example Query Shapes

Workspace feed:

```http
GET /activity?scope=workspace&limit=50
```

Issue feed (unified):

```http
GET /activity?scope=issue&scopeId=LIN-104&limit=25
```

Issue feed (compat route):

```http
GET /issues/LIN-104/activity?limit=25
```

Project feed with type filter:

```http
GET /activity?scope=project&scopeId=proj_uuid&types=PROJECT_UPDATED,ISSUE_STATUS_CHANGED
```

Team feed with date range:

```http
GET /activity?scope=team&scopeId=team_uuid&from=2026-05-01T00:00:00.000Z&to=2026-05-31T23:59:59.999Z
```

## Done-When Checklist

- [ ] Global activity feed loads with cursor pagination
- [ ] Project/team/issue scoped feeds load from unified route
- [ ] Issue timeline works with compatibility route
- [ ] Filter controls (type, actor, date, entity) map to query params
- [ ] Row rendering uses server `message` + actor + timestamp + badge
- [ ] Infinite load uses `meta.nextCursor`/`hasMore` without duplicates
- [ ] All activity types render with stable badge/icon fallbacks
- [ ] Metadata parsing is defensive and does not break on unknown keys
- [ ] Scope changes reset paging/caches correctly
