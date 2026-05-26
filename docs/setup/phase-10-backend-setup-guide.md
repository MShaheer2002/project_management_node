# Phase 10 Backend Setup Guide (Socket Realtime Notifications)

> Phase 10 adds realtime socket delivery on top of Phase 9 persisted notifications.
> Source of truth remains DB; sockets improve latency and UX.

---

## 1. Prerequisites

These must already be complete:

- Phase 8 activity events and payload standards
- Phase 9 notification persistence APIs and dedupe
- workspace auth/membership middleware
- issue/project/team visibility rules

Required runtime expectations:

- Clerk token verification available server-side
- active `X-Workspace-Id` in HTTP APIs
- backend process with long-lived Socket.IO server

---

## 2. Scope

Phase 10 in-scope:

- Socket.IO bootstrap and auth
- room strategy and authorization
- realtime emits for workspace, issue, and user channels
- notification popup payload (`ui.toast`, `ui.soundKey`)
- reconnect + resync protocol

Out of scope:

- browser/device push (FCM/APNs/Web Push)
- email/slack notification channels

---

## 3. Directory Structure

Create and keep this structure:

```txt
socket/
├── index.ts
├── auth.ts
├── rooms.ts
├── events.ts
├── notification.events.ts
└── serializers.ts
```

Recommended integration points:

- [server.ts](/Users/admin/Documents/project_management/project_management_node/app/server.ts): initialize HTTP + Socket.IO
- [notification.service.ts](/Users/admin/Documents/project_management/project_management_node/modules/notification/notification.service.ts): register delivery handler for `notification:created`

---

## 4. Socket Bootstrap

In `socket/index.ts`:

- create Socket.IO server bound to existing HTTP server
- configure CORS to allowed frontend origins
- enable websocket transport, keep polling fallback
- apply auth middleware from `socket/auth.ts`
- register join/leave handlers from `socket/rooms.ts`

Suggested initialization order:

1. create `httpServer`
2. create `io`
3. attach `io.use(authMiddleware)`
4. register connection handler
5. inside connection, auto-join workspace/user rooms

---

## 5. Authentication Contract

Handshake auth payload:

```ts
type SocketAuth = {
  token: string;
  workspaceId: string;
  clientVersion?: string;
};
```

`socket/auth.ts` responsibilities:

- verify Clerk JWT
- resolve user by JWT `userId`
- verify `workspaceMembership` for handshake `workspaceId`
- attach:

```ts
socket.data = {
  userId: string,
  workspaceId: string,
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST',
}
```

Reject invalid auth with `connect_error`.

---

## 6. Room Strategy

Required rooms:

- `workspace:<workspaceId>`
- `user:<userId>`
- `issue:<issueId>`

Join behavior:

- on connect: join workspace + user room
- issue page open: client emits join issue room
- issue page close: client emits leave issue room

Server-side enforcement:

- issue room joins must validate issue belongs to socket workspace
- user cannot join cross-workspace issue rooms

---

## 7. Standard Event Envelope

All emitted realtime events must be wrapped:

```ts
type RealtimeEnvelope<TPayload> = {
  id: string;
  type: string;
  workspaceId: string;
  createdAt: string;
  dedupeKey?: string;
  payload: TPayload;
};
```

Rules:

- `id` is unique event UUID
- `createdAt` is ISO timestamp
- `type` always mirrors event channel name
- `dedupeKey` included for replay-safe consumers

---

## 8. Event Map

## Workspace room (`workspace:<workspaceId>`)

- `issue:created`
- `issue:updated`
- `issue:deleted`

Payload:

```ts
type IssueUpdatedPayload = {
  issueId: string;
  publicId?: string;
  patch?: Record<string, unknown>;
  full?: Record<string, unknown>;
};
```

## Issue room (`issue:<issueId>`)

- `comment:created`
- `comment:updated`
- `comment:deleted`

Payload must align with Phase 6 comment response model.

## User room (`user:<userId>`)

- `notification:created` (required)
- `notification:read` (recommended)
- `notification:read-all` (recommended)

`notification:created` payload:

```ts
type NotificationCreatedPayload = {
  notification: NotificationItem;
  unread: number;
  ui?: {
    toast: true;
    soundKey?: 'default' | 'mention' | 'assignment' | 'warning';
    priority?: 'low' | 'normal' | 'high';
  };
};
```

---

## 9. Notification Type Coverage (Realtime)

Socket delivery must cover all currently generated backend notification types:

- `MENTION`
- `ASSIGNMENT`
- `UPDATE`
- `COMMENT_REPLY`
- `PROJECT_MEMBER`
- `TEAM_MEMBER`

Recommended future-compatible handling:

- tolerate and emit unknown types without breaking serializer
- map default UI metadata for unknown type (`soundKey: default`, `priority: normal`)

---

## 10. Delivery Wiring with Phase 9 Service

Use existing hook from notification service:

- `setNotificationDeliveryHandler(handler)` in
  [notification.service.ts](/Users/admin/Documents/project_management/project_management_node/modules/notification/notification.service.ts)

`handler` implementation (Phase 10):

1. build envelope with `type: 'notification:created'`
2. enrich payload with `ui` metadata by notification type
3. emit to `user:<recipientUserId>`
4. optional ack tracking and bounded retry

Important:

- emit **after** DB insert succeeds
- never emit notification that failed DB persistence

---

## 11. Dedupe, Retry, and Acks

Required:

- at-least-once socket delivery
- no duplicate DB rows (Phase 9 dedupe key remains primary guard)
- client dedupe by `envelope.id` and/or `notification.id`

Recommended:

- ack callback for `notification:created`
- retry up to 3 times with small backoff if ack missing
- mark emit attempt metrics regardless of ack outcome

---

## 12. Resync Protocol (Must-Have)

On reconnect, tab focus, or temporary disconnect:

1. reconnect socket with fresh token
2. rejoin workspace/user/issue rooms
3. refetch REST:
   - `GET /notifications?limit=30`
   - `GET /notifications/unread-count`
4. reconcile by `notification.id`

Do not rely on socket-only state.

---

## 13. Security Rules

- never trust client-provided `userId` for room naming
- derive user room from verified JWT only
- reject room join if workspace mismatch
- reject issue-room join if issue not visible to user scope
- avoid leaking target metadata across workspace boundaries

---

## 14. Performance Guidance

- emit room-targeted payloads only (no global broadcasts)
- keep envelope small; omit heavy nested objects
- batch low-priority workspace updates when noisy
- avoid per-event synchronous expensive queries on hot paths
- keep unread count query indexed (Phase 9 indexes already required)

---

## 15. Failure Handling

- `connect_error`: frontend retries with exponential backoff
- expired token: frontend refreshes Clerk token, reconnects
- unauthorized room join: emit specific socket error event and ignore join
- emit failure: log with `eventId`, `room`, `type`, retry attempt

---

## 16. Observability and Metrics

Log fields on emit:

- `eventId`
- `type`
- `workspaceId`
- `room`
- `recipientUserId` (if user room)
- `notificationId` (for notification events)
- `dedupeKey`

Track metrics:

- connected sockets total
- sockets per workspace
- emits by event type
- emit failure rate
- notification emit latency (`db_created_at -> emit_time`)
- reconnect frequency

---

## 17. Frontend Integration Expectations

Frontend should:

- subscribe once per session to workspace/user channels via socket client
- join/leave issue rooms on issue detail mount/unmount
- prepend incoming notification if new
- update badge from `payload.unread`
- show toast using `payload.ui`
- continue REST reconciliation despite realtime

Reference:

- [phase-9-frontend-notification-integration-guide.md](/Users/admin/Documents/project_management/project_management_node/docs/setup/phase-9-frontend-notification-integration-guide.md)

---

## 18. Rollout Plan (Recommended)

1. Deploy socket auth + room join only (no emits)
2. Enable `notification:created` emits
3. Enable workspace/issue realtime events
4. Enable optional `notification:read`/`read-all` emits
5. Monitor errors/latency and tune retries

Use feature flags for staged rollout if production traffic is high.

---

## 19. Validation Checklist

- [ ] Socket auth validates JWT + workspace membership
- [ ] Auto-join `workspace:<id>` and `user:<id>` on connect
- [ ] Secure issue room join/leave implemented
- [ ] Standard envelope used for all events
- [ ] `notification:created` emitted from persisted notification flow
- [ ] `ui.toast` and `ui.soundKey` included for popup UX
- [ ] Reconnect resync path documented and tested
- [ ] Logs and metrics added for emit observability
- [ ] No cross-workspace data leakage in room emissions

