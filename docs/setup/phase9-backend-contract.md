# Phase 9 Backend Contract (Notifications + Inbox)

This document translates Phase 9 from [build-phases.md](./build-phases.md) into a production-grade backend contract for notifications.

Phase 0 through Phase 8 are assumed complete.

## Goal

Deliver reliable, user-scoped notifications that power inbox UX and unread badges across the app:

- inbox page list and filters
- sidebar inbox unread badge
- top navbar inbox entry
- dashboard unread notification stat
- issue/project/team deep-link flows

Notifications are separate from activity history and must represent actionability for the receiving user.

## Frontend Surfaces Covered

- inbox page: [NotificationsPage.tsx](/Users/admin/Documents/project_management/project_management_react/src/pages/NotificationsPage.tsx)
- sidebar unread badge (`badges.inbox`): [Sidebar.tsx](/Users/admin/Documents/project_management/project_management_react/src/components/Sidebar.tsx)
- navbar inbox entry: [TopNavbar.tsx](/Users/admin/Documents/project_management/project_management_react/src/shared/components/layout/TopNavbar.tsx)
- dashboard unread stat: [DashboardPage.tsx](/Users/admin/Documents/project_management/project_management_react/src/pages/DashboardPage.tsx)
- sidebar data contract: [types.ts](/Users/admin/Documents/project_management/project_management_react/src/features/sidebar/types.ts)
- dashboard data contract: [types.ts](/Users/admin/Documents/project_management/project_management_react/src/features/dashboard/types.ts)

## In Scope (Phase 9)

- Persisted notification store (source of truth)
- Inbox list API with cursor pagination and filters
- Unread count API for lightweight badge polling
- Mark-one and mark-all read flows
- Recipient fanout rules for all required trigger types
- Deduplication/idempotency for retried writes and repeated events
- Websocket user-room push for newly created notifications

## Out Of Scope (Phase 9)

- Email/SMS/mobile push delivery channels
- User-level notification preference management UI
- Snooze/mute rules per entity
- Full-text search index

## API Conventions

Reuse app-wide conventions:

- authenticated routes
- workspace scoping via `X-Workspace-Id`
- standard success/error envelope
- cursor pagination (`meta.nextCursor`, `meta.hasMore`)

## Data Model

## `Notification`

Required fields:

- `id` (UUID)
- `workspaceId`
- `recipientUserId` (the user receiving notification)
- `actorUserId` (nullable for system-generated events)
- `type` (enum)
- `category` (`mention | assignment | update | membership | comment`)
- `title` (short heading)
- `message` (timeline/inbox text)
- `targetType` (`issue | comment | project | team | workspace`)
- `targetId`
- `targetPublicId` (optional display key like `LIN-102`)
- `targetUrl` (frontend route)
- `metadata` (JSON)
- `readAt` (nullable)
- `createdAt`

Optional but recommended:

- `eventId` (reference to activity event)
- `dedupeKey` (unique key for idempotency)

Indexes:

- `(workspaceId, recipientUserId, createdAt DESC)`
- `(workspaceId, recipientUserId, readAt, createdAt DESC)`
- `(workspaceId, recipientUserId, type, createdAt DESC)`
- unique `(workspaceId, recipientUserId, dedupeKey)`

## Notification Types (Minimum Required)

- `MENTION`
- `ASSIGNMENT`
- `UPDATE`
- `COMMENT_REPLY`
- `PROJECT_MEMBER`

Recommended extensions for production completeness:

- `TEAM_MEMBER`
- `WORKSPACE_INVITE`
- `ISSUE_DUE_SOON`
- `ISSUE_OVERDUE`

## Recipient Rules and Role Safety

Rules apply after workspace visibility/permissions checks:

- Recipients must be active workspace members.
- Never notify users who cannot access the target entity.
- Actor does not receive self-notification unless explicitly enabled for specific types (default `false`).
- For `UPDATE` fanout (`status/priority/etc`), notify:
  - current assignee (if exists)
  - issue creator
  - issue watchers (if watcher model exists)
  - exclude actor and duplicates
- For `MENTION`, notify each mentioned member once per comment event.
- For `COMMENT_REPLY`, notify parent comment author if not actor.
- For `PROJECT_MEMBER`, notify added/removed member.

Role-specific expectations:

- `OWNER`/`ADMIN` can receive notifications as normal recipients when they are target users.
- `GUEST` should only receive notifications for entities they can view.
- Removed/deactivated members should not receive new notifications.

## Event Metadata Contract

`metadata` must be stable and typed by notification `type`.

Common metadata:

- `entityId` (e.g., `LIN-102`)
- `entityTitle`
- `workspaceId`
- `url` (same as `targetUrl`, optional duplicate for FE ease)

`MENTION`:

- `commentId`
- `commentExcerpt` (max 140 chars)
- `mentionedBy` `{ id, name }`

`ASSIGNMENT`:

- `issueId`
- `fromAssignee` `{ id, name } | null`
- `toAssignee` `{ id, name } | null`

`UPDATE`:

- `issueId`
- `field` (`status | priority | dueDate | ...`)
- `from`
- `to`

`COMMENT_REPLY`:

- `commentId`
- `parentCommentId`
- `commentExcerpt`

`PROJECT_MEMBER`:

- `projectId`
- `member` `{ id, name, email }`
- `action` (`added | removed`)

## Endpoints

## 1) List Notifications

`GET /notifications`

Query:

```ts
type ListNotificationsQuery = {
  cursor?: string;
  limit?: number; // default 30, max 100
  unreadOnly?: boolean;
  category?: 'mention' | 'assignment' | 'update' | 'membership' | 'comment';
  types?: string; // comma-separated enum values
  actorId?: string;
  targetType?: 'issue' | 'comment' | 'project' | 'team' | 'workspace';
  from?: string; // ISO datetime
  to?: string; // ISO datetime
};
```

Response:

```ts
type NotificationActor = {
  id: string;
  name: string;
  email?: string;
  avatar?: string | null;
};

type NotificationItem = {
  id: string;
  type: 'MENTION' | 'ASSIGNMENT' | 'UPDATE' | 'COMMENT_REPLY' | 'PROJECT_MEMBER';
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
  data: NotificationItem[];
  meta: {
    nextCursor: string | null;
    hasMore: boolean;
  };
};
```

## 2) Unread Count

`GET /notifications/unread-count`

Response:

```ts
type UnreadCountResponse = {
  data: {
    unread: number;
  };
};
```

## 3) Mark One as Read

`PATCH /notifications/:id/read`

Body (optional idempotent form):

```ts
type MarkReadInput = {
  read?: boolean; // default true
};
```

Response:

```ts
{ success: true, data: { id: string; readAt: string | null } }
```

## 4) Mark All as Read

`PATCH /notifications/read-all`

Response:

```ts
{ success: true, data: { updated: number; readAt: string } }
```

## 5) Optional: Mark Batch as Read (recommended)

`PATCH /notifications/read`

Body:

```ts
type MarkBatchReadInput = {
  ids: string[];
};
```

Response:

```ts
{ success: true, data: { updated: number } }
```

## Websocket Contract (Phase 9 Requirement)

Room:

- `user:<recipientUserId>`

Event:

- `notification:created`

Payload:

```ts
type NotificationCreatedEvent = {
  notification: NotificationItem;
  unread: number; // recipient unread count after insert
};
```

Delivery requirements:

- At-least-once delivery to connected user room.
- Client must still rely on API polling/refetch for reconciliation.
- Duplicate websocket events must not create duplicate DB rows (dedupe key enforced server-side).

## Idempotency and Dedupe

Generation must be idempotent for retries/replays.

Recommended dedupe key pattern:

- `type:eventId:recipientUserId`
- or `type:workspaceId:targetId:recipientUserId:hash(metadata-core)`

Rules:

- Same dedupe key for same recipient cannot insert twice.
- Different recipients still get distinct rows.
- Changing meaningful payload (e.g., new comment) should generate new dedupe key.

## Integration With Existing App Data

To support current app surfaces:

- `GET /sidebar` must return `badges.inbox = unread count`.
- `GET /dashboard` must return `stats.unreadNotifications` from same unread source.
- Inbox list rows must include actor/avatar, message, read state, and target URL.

## Error Handling

- `401` unauthenticated
- `403` target workspace/resource forbidden
- `404` notification not found (or not owned by recipient)
- `422` invalid query/body

Ownership rule:

- A user can only read/update their own notifications.

## Non-Functional Requirements

- Unread count query p95 < 80ms for typical user mailbox.
- Inbox list query p95 < 200ms for 10k+ rows/user with proper indexes.
- Mark-all should be set-based single query (not row-by-row loop).
- Payload must be forward-compatible for new notification types.

## Done When

- [ ] Notifications generated for mention, assignment, update, reply, and project member events
- [ ] Inbox list endpoint supports cursor pagination and filters
- [ ] Unread count endpoint powers sidebar/dashboard badges consistently
- [ ] Mark one and mark all read flows are idempotent and ownership-safe
- [ ] Notification rows include deep links (`target.url`) for direct navigation
- [ ] Websocket `notification:created` emits to `user:<id>` room
- [ ] Dedupe key strategy prevents duplicate notifications under retries
