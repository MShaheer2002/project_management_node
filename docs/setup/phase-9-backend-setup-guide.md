# Phase 9 Backend Setup Guide (Notifications + Inbox)

> Phase 9 notifications are persisted and user-scoped.
> This guide defines backend setup for inbox APIs, unread counters, fanout, and websocket delivery.

---

## 1. Prerequisites

These pieces must already be working:

- Phase 8 activity feed and event side-effects
- workspace auth + membership middleware chain
- stable workspace scoping via `X-Workspace-Id`
- issue/project/team/workspace visibility rules implemented

Required headers for notification routes:

- `Authorization: Bearer <clerk-session-token>`
- `X-Workspace-Id: <workspace-uuid>`

---

## 2. Backend Prerequisites

Notification integration depends on:

- `Notification` model fields aligned to Phase 9 contract
- indexes for unread list and count performance
- routes mounted for notification module
- shared notification fanout helper/service
- websocket user room support (`user:<recipientUserId>`) for push

After schema changes:

```bash
npx prisma generate
npx prisma migrate deploy
npm run build
```

---

## 3. Module Structure

Create and keep this structure:

```txt
modules/notification/
├── notification.routes.ts
├── notification.controller.ts
├── notification.service.ts
└── notification.schemas.ts
```

Optional split for maintainability (recommended when file grows):

```txt
modules/notification/
├── notification.service.ts
├── notification-fanout.service.ts
└── notification-delivery.service.ts
```

Rule alignment:

- Route -> Middleware -> Controller -> Service -> DB
- no business logic in controllers
- no Prisma usage in controllers
- all workspace/user isolation inside service queries

---

## 4. Data Model Contract

`Notification` required fields:

- `id`
- `workspaceId`
- `recipientUserId`
- `actorUserId` (nullable for system events)
- `type`
- `category`
- `title`
- `message`
- `targetType`
- `targetId`
- `targetPublicId` (optional)
- `targetUrl`
- `metadata` (JSON)
- `readAt` (nullable)
- `createdAt`

Recommended fields:

- `eventId`
- `dedupeKey`

Indexes (required for performance):

- `(workspaceId, recipientUserId, createdAt DESC)`
- `(workspaceId, recipientUserId, readAt, createdAt DESC)`
- `(workspaceId, recipientUserId, type, createdAt DESC)`
- unique `(workspaceId, recipientUserId, dedupeKey)`

---

## 5. Route Scope

Implement these routes:

```txt
GET    /notifications
GET    /notifications/unread-count
PATCH  /notifications/:id/read
PATCH  /notifications/read-all
PATCH  /notifications/read      # optional batch endpoint (recommended)
```

Route access:

- all notification routes are authenticated
- all routes are scoped to active workspace
- user can only read/update their own notifications

---

## 6. Query and Response Contract

### List notifications

`GET /notifications` query:

- `cursor?: string`
- `limit?: number` (default 30, max 100)
- `unreadOnly?: boolean`
- `category?: 'mention' | 'assignment' | 'update' | 'membership' | 'comment'`
- `types?: string` (comma-separated)
- `actorId?: string`
- `targetType?: 'issue' | 'comment' | 'project' | 'team' | 'workspace'`
- `from?: string` (ISO datetime)
- `to?: string` (ISO datetime)

Response:

- `success: true`
- `data: NotificationItem[]`
- `meta: { nextCursor, hasMore }`

### Unread count

`GET /notifications/unread-count`

Response:

- `success: true`
- `data: { unread: number }`

### Mark one read/unread

`PATCH /notifications/:id/read`

Body:

- `read?: boolean` (default `true`)

Response:

- `success: true`
- `data: { id, readAt }`

### Mark all read

`PATCH /notifications/read-all`

Response:

- `success: true`
- `data: { updated, readAt }`

### Batch mark read (optional)

`PATCH /notifications/read`

Body:

- `ids: string[]`

Response:

- `success: true`
- `data: { updated }`

---

## 7. Validation Rules

`notification.schemas.ts` must validate:

- cursor UUID format
- limit bounds
- category enum
- targetType enum
- ISO datetime for `from` / `to`
- comma-list parsing for `types`
- mark-one payload boolean shape
- batch IDs array shape and max size guard

Reject invalid inputs with `422 VALIDATION_ERROR`.

---

## 8. Workspace and Ownership Isolation

Every notification query MUST include:

- `workspaceId = req.workspace.id`
- `recipientUserId = req.user.id`

Never allow:

- reading another user inbox
- marking another user notifications read
- counting unread for another user

For fanout recipients:

- recipients must be current workspace members
- recipients must pass target visibility checks
- actor self-notification excluded by default

---

## 9. Notification Types and Categories

Minimum required types:

- `MENTION` (`mention`)
- `ASSIGNMENT` (`assignment`)
- `UPDATE` (`update`)
- `COMMENT_REPLY` (`comment`)
- `PROJECT_MEMBER` (`membership`)

Recommended extensions:

- `TEAM_MEMBER`
- `WORKSPACE_INVITE`
- `ISSUE_DUE_SOON`
- `ISSUE_OVERDUE`

Frontend must tolerate unknown future types.

---

## 10. Recipient Fanout Rules

### `MENTION`

Trigger:

- mention detected on comment create/edit

Recipients:

- mentioned users who are workspace members and can view target issue

Rules:

- dedupe per comment event and recipient
- exclude actor (default)

### `ASSIGNMENT`

Trigger:

- issue assignee changed

Recipients:

- new assignee (if any and not actor)

### `UPDATE`

Trigger:

- issue status/priority/due date/scope updates

Recipients:

- assignee
- creator
- watchers (if watcher model enabled)

Rules:

- dedupe recipients
- exclude actor

### `COMMENT_REPLY`

Trigger:

- comment created with `parentCommentId`

Recipients:

- parent comment author (if not actor)

### `PROJECT_MEMBER`

Trigger:

- project member add/remove

Recipients:

- target member

---

## 11. Metadata Contract

Common metadata:

- `entityId`
- `entityTitle`
- `workspaceId`
- `url`

`MENTION` metadata:

- `commentId`
- `commentExcerpt` (max 140 chars)
- `mentionedBy` `{ id, name }`

`ASSIGNMENT` metadata:

- `issueId`
- `fromAssignee`
- `toAssignee`

`UPDATE` metadata:

- `issueId`
- `field`
- `from`
- `to`

`COMMENT_REPLY` metadata:

- `commentId`
- `parentCommentId`
- `commentExcerpt`

`PROJECT_MEMBER` metadata:

- `projectId`
- `member` `{ id, name, email }`
- `action` (`added | removed`)

Unknown metadata keys must not break consumers.

---

## 12. Idempotency and Dedupe

Notification generation must be idempotent for retries/replays.

Recommended dedupe key:

- `type:eventId:recipientUserId`

Alternative:

- `type:workspaceId:targetId:recipientUserId:hash(corePayload)`

Rules:

- enforce unique dedupe key per recipient/workspace
- if duplicate insert attempted, treat as success/no-op
- dedupe before websocket push

---

## 13. Websocket Delivery Contract

Room:

- `user:<recipientUserId>`

Event:

- `notification:created`

Payload:

- `notification: NotificationItem`
- `unread: number`

Delivery rules:

- at-least-once delivery
- API is source of truth for reconciliation
- websocket duplicates must not create duplicate DB rows

---

## 14. Performance and Query Shape

Requirements:

- list query uses cursor pagination only
- unread count query uses indexed `readAt IS NULL`
- newest-first deterministic ordering (`createdAt desc`, `id desc`)
- avoid N+1 actor/target fetches (single query with joins/selects)

Recommended defaults:

- list limit default 30
- upper cap 100

---

## 15. Error Handling

Use consistent codes:

- `NOT_FOUND` (notification not found in user scope)
- `FORBIDDEN`
- `VALIDATION_ERROR`
- `CONFLICT` (dedupe collision handling only if surfaced)

Always return standard envelope.

---

## 16. App Wiring

In `app/app.ts` mount notification routes when module is implemented:

```ts
app.use(notificationRoutes);
```

Also update OpenAPI paths/schemas after route implementation is live.

---

## 17. Frontend Readiness Checklist

Frontend should be ready for:

- inbox list with filters and infinite pagination
- unread badge polling from `/notifications/unread-count`
- mark one / mark all read actions
- deep linking via `target.url`
- websocket optimistic insert + API reconciliation

---

## 18. Done-When Checklist

- [ ] Notification module routes/controllers/services/schemas implemented
- [ ] Inbox list API works with filters + cursor pagination
- [ ] Unread count endpoint is accurate and fast
- [ ] Mark one and mark all read flows are idempotent
- [ ] Fanout works for mention/assignment/update/reply/project-member triggers
- [ ] Dedupe key strategy prevents duplicates in DB and push
- [ ] Websocket notification push works to `user:<id>` room
- [ ] Build passes and endpoint behavior verified manually
