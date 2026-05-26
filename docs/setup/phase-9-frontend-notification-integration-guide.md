# Phase 9 Frontend Notification Integration Guide

This document defines frontend integration for Phase 9 notifications (in-app inbox + unread badges + optional realtime).

Backend references:
- [phase-9-backend-setup-guide.md](./phase-9-backend-setup-guide.md)
- [phase9-backend-contract.md](./phase9-backend-contract.md)
- [build-phases.md](./build-phases.md)

## Preconditions

- Auth/session flow is working.
- Active workspace is selected.
- `X-Workspace-Id` header is sent on workspace-scoped requests.
- Sidebar and dashboard are already integrated from earlier phases.

## Scope Clarification

Phase 9 provides:
- persisted in-app notifications (source of truth)
- unread count APIs for badges
- optional websocket event delivery for live insert

Phase 9 does **not** require browser/device push (FCM/APNs/Web Push).

## Core Routes

```txt
GET    /notifications
GET    /notifications/unread-count
PATCH  /notifications/:id/read
PATCH  /notifications/read-all
PATCH  /notifications/read
```

All routes are authenticated and workspace-scoped.

## Query Contract

`GET /notifications` supports:

- `cursor?: string`
- `limit?: number` (default 30, max 100)
- `unreadOnly?: boolean`
- `category?: 'mention' | 'assignment' | 'update' | 'membership' | 'comment'`
- `types?: string` (comma-separated enum values)
- `actorId?: string`
- `targetType?: 'issue' | 'comment' | 'project' | 'team' | 'workspace'`
- `from?: string` (ISO datetime)
- `to?: string` (ISO datetime)

Rules:

- use cursor pagination only
- list is newest-first
- when filter set changes, reset cursor and list state
- backend returns `422 VALIDATION_ERROR` for invalid values

## Response Contract

```ts
type NotificationActor = {
  id: string;
  name: string;
  email?: string;
  avatar?: string | null;
};

type NotificationItem = {
  id: string;
  type: string;
  category: 'mention' | 'assignment' | 'update' | 'membership' | 'comment';
  title: string;
  message: string;
  createdAt: string;
  readAt: string | null;
  actor?: NotificationActor;
  target: {
    type: 'issue' | 'comment' | 'project' | 'team' | 'workspace';
    id: string;
    publicId?: string;
    url: string;
  };
  metadata?: Record<string, unknown>;
};

type ListNotificationsResponse = {
  success: true;
  data: NotificationItem[];
  meta: {
    nextCursor: string | null;
    hasMore: boolean;
  };
};
```

Unread count:

```ts
type UnreadCountResponse = {
  success: true;
  data: { unread: number };
};
```

## Full Type Coverage

Frontend must support icon/label mapping for required and recommended types:

- `MENTION`
- `ASSIGNMENT`
- `UPDATE`
- `COMMENT_REPLY`
- `PROJECT_MEMBER`
- `TEAM_MEMBER` (recommended extension)
- `WORKSPACE_INVITE` (recommended extension)
- `ISSUE_DUE_SOON` (recommended extension)
- `ISSUE_OVERDUE` (recommended extension)

Fallback rule:

- unknown future `type` values must render using generic icon + backend `title/message`

## Metadata Usage Contract

Read `metadata` defensively as unknown JSON.

Common keys:
- `entityId`
- `entityTitle`
- `workspaceId`
- `url`

Type-specific keys (if present):

`MENTION`:
- `commentId`
- `commentExcerpt`
- `mentionedBy`

`ASSIGNMENT`:
- `issueId`
- `fromAssignee`
- `toAssignee`

`UPDATE`:
- `issueId`
- `field`
- `from`
- `to`

`COMMENT_REPLY`:
- `commentId`
- `parentCommentId`
- `commentExcerpt`

`PROJECT_MEMBER`:
- `projectId`
- `member`
- `action`

## UI Surface Mapping

Notifications page:
- list via `GET /notifications`
- filters map to query params
- infinite scroll via cursor

Header/sidebar badge:
- poll/refetch `GET /notifications/unread-count`
- sync with read actions optimistically, then reconcile from API

Dashboard stat:
- `stats.unreadNotifications` from dashboard API should align with unread-count endpoint

Deep-link behavior:
- primary navigation target is `notification.target.url`

## Read/Unread Actions

Mark one read:
- `PATCH /notifications/:id/read`
- optional body `{ read: true }`

Mark all read:
- `PATCH /notifications/read-all`

Batch read (recommended):
- `PATCH /notifications/read`
- body `{ ids: string[] }`

Frontend behavior:
- optimistic UI update is allowed
- always reconcile from API response payload
- keep action idempotent (re-click/read-again should not break UI)

## Realtime Integration (Optional but Recommended)

Backend websocket contract:

- room: `user:<recipientUserId>`
- event: `notification:created`
- payload:

```ts
type NotificationCreatedEvent = {
  notification: NotificationItem;
  unread: number;
};
```

Client rules:
- append incoming notification to top if not already present by `id`
- update unread badge from event payload
- still refetch `/notifications` periodically or on tab focus for reconciliation

## Suggested Query Keys

- inbox list: `['notifications', workspaceId, params]`
- unread count: `['notifications-unread', workspaceId]`

Pagination flow:

1. initial fetch without cursor
2. append `data`
3. use `meta.nextCursor` for next page
4. stop when `hasMore = false`

Deduplicate rows by `id` while merging pages and websocket inserts.

## Error Handling

Handle by status + `error.code`:

- `401` unauthenticated
- `403` not workspace member / forbidden
- `404` notification not found (for read action)
- `422` invalid query/body

UX recommendation:
- non-blocking toast for single read failure
- retry affordance for feed/unread fetch failure

## Permission & Isolation Expectations

Backend enforces:
- current user can only list/update own notifications
- workspace scoping is mandatory

Frontend should:
- never pass another user's ID for inbox behavior
- clear notification cache on workspace switch

## Suggested Hook Surface

Recommended hooks:

- `useNotifications(params)`
- `useUnreadNotificationsCount()`
- `useMarkNotificationRead()`
- `useMarkAllNotificationsRead()`
- `useMarkNotificationsBatchRead()`
- `useNotificationRealtime()` (websocket listener, optional)
