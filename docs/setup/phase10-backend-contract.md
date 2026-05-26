# Phase 10 Backend Contract (Realtime + Socket Notifications)

This document translates Phase 10 from [build-phases.md](./build-phases.md) into a production-grade realtime contract.

Phase 0 through Phase 9 are assumed complete.

## Goal

Deliver reliable realtime delivery for issue/comment/activity updates and inbox notifications using Socket.IO, with safe fallback to HTTP polling.

This phase must support:

- live workspace updates (issue create/update/delete)
- live issue-room comments
- live user-room notification pushes
- frontend toast-ready payload for top-right notification popup
- optional notification sound trigger via backend-provided `soundKey`

## Dependency and Scope

Depends on:

- Phase 8 (activity event model)
- Phase 9 (persisted notifications, unread counts, read model)

In scope:

- socket auth + room join strategy
- server emit contract and payload shape
- delivery guarantees and dedupe strategy
- reconnect/resync protocol

Out of scope:

- browser push notifications (FCM/APNs/WebPush)
- email/slack external channels

## Frontend Surfaces Impacted

- inbox page live prepend: [NotificationsPage.tsx](/Users/admin/Documents/project_management/project_management_react/src/pages/NotificationsPage.tsx)
- top-right bell + toast popup: [TopNavbar.tsx](/Users/admin/Documents/project_management/project_management_react/src/shared/components/layout/TopNavbar.tsx)
- sidebar unread badge: [Sidebar.tsx](/Users/admin/Documents/project_management/project_management_react/src/components/Sidebar.tsx)
- issue detail and context panel live updates:
  - [IssueDetailPage.tsx](/Users/admin/Documents/project_management/project_management_react/src/pages/IssueDetailPage.tsx)
  - [ContextPanel.tsx](/Users/admin/Documents/project_management/project_management_react/src/components/ContextPanel.tsx)

## Socket Authentication

Transport: Socket.IO over WebSocket (with polling fallback if needed).

Handshake payload:

```ts
type SocketAuth = {
  token: string; // Clerk JWT
  workspaceId: string;
  clientVersion?: string;
};
```

Server requirements:

- verify Clerk JWT on connect
- verify user belongs to `workspaceId`
- attach `socket.data = { userId, workspaceId, role }`
- reject with `connect_error` for invalid/expired token

## Room Strategy

Required rooms:

- `workspace:<workspaceId>`
- `issue:<issueId>`
- `user:<userId>`

Join rules:

- On connect: join `workspace:<workspaceId>` and `user:<userId>`
- On issue page open: client emits join for `issue:<issueId>`
- On issue page leave: client emits leave for `issue:<issueId>`

Security:

- server must authorize issue room membership before join
- no cross-workspace room joins

## Event Envelope (Standard)

All socket events should use one envelope for consistency:

```ts
type RealtimeEnvelope<TPayload> = {
  id: string; // event id (uuid)
  type: string; // event name e.g. notification:created
  workspaceId: string;
  createdAt: string; // ISO timestamp
  dedupeKey?: string;
  payload: TPayload;
};
```

Why:

- dedupe on client
- consistent logging/traceability
- compatibility with retry/replay

## Realtime Events

## Workspace events

- `issue:created`
- `issue:updated`
- `issue:deleted`

Room: `workspace:<workspaceId>`

Payload:

```ts
type IssueUpdatedPayload = {
  issueId: string;
  publicId?: string; // LIN-###
  patch?: Record<string, unknown>;
  full?: Record<string, unknown>; // optional full row for convenience
};
```

## Issue room events

- `comment:created`
- `comment:updated`
- `comment:deleted`

Room: `issue:<issueId>`

Payload should align with Phase 6 comment contract.

## User room notification events (Phase 10 critical)

- `notification:created`
- `notification:read` (optional but recommended)
- `notification:read-all` (optional but recommended)

Room: `user:<userId>`

### `notification:created` payload

```ts
type NotificationToastPayload = {
  notification: {
    id: string;
    type: string;
    category: 'mention' | 'assignment' | 'update' | 'membership' | 'comment';
    title: string;
    message: string;
    createdAt: string;
    readAt: string | null;
    actor?: {
      id: string;
      name: string;
      avatar?: string | null;
    };
    target: {
      type: 'issue' | 'comment' | 'project' | 'team' | 'workspace';
      id: string;
      publicId?: string;
      url: string;
    };
    metadata?: Record<string, unknown>;
  };
  unread: number;
  ui?: {
    toast: true;
    soundKey?: 'default' | 'mention' | 'assignment' | 'warning';
    priority?: 'low' | 'normal' | 'high';
  };
};
```

`ui.soundKey` lets frontend play a sound for top-right popup when user/browser allows audio.

## Delivery Semantics

Required guarantees:

- At-least-once delivery for socket events
- Idempotent persistence in DB (Phase 9 dedupe key)
- Client dedupe by event `id` or notification `id`

Recommended:

- ack callback for critical events (`notification:created`)
- bounded retry (e.g., 3 attempts with backoff)

## Resync Strategy (must-have)

On reconnect or tab focus:

1. client re-authenticates socket
2. client rejoins workspace/user/issue rooms
3. client refetches:
   - `/notifications?limit=30`
   - `/notifications/unread-count`
4. client reconciles by `notification.id`

Do not rely solely on sockets for correctness.

## Client UI Strategy (Top-right Popup + Sound)

When receiving `notification:created`:

- prepend notification in inbox cache if id not present
- update unread badge with `unread`
- show top-right toast with actor/title/message
- if `ui.soundKey` exists and user has enabled sounds, play mapped sound asset

Sound policy:

- default muted until user interaction or explicit preference
- graceful fallback if autoplay blocked

## Failure Handling

- `connect_error` -> show subtle offline indicator and retry with exponential backoff
- token expiry -> refresh Clerk token and reconnect
- unauthorized room join -> emit error and do not join

## Observability

Server logs for each emitted event:

- `eventId`, `type`, `workspaceId`, `recipient/room`, `dedupeKey`

Metrics:

- active socket connections
- emit success/failure counts by event type
- reconnect rate
- notification delivery latency (db insert -> socket emit -> client ack)

## Module Structure

```
socket/
├── index.ts                  # Socket.IO bootstrap
├── auth.ts                   # Clerk auth middleware
├── rooms.ts                  # join/leave with authorization
├── events.ts                 # event bus bindings
├── notification.events.ts    # user-room notification emits
└── serializers.ts            # envelope + payload serializers
```

## Done When

- [ ] Socket auth verifies Clerk JWT and workspace membership
- [ ] `workspace`, `issue`, and `user` room strategy enforced server-side
- [ ] `notification:created` emits with unread count and toast/sound metadata
- [ ] Client can show top-right realtime popup and optional sound trigger
- [ ] Reconnect flow rehydrates notification state via REST refetch
- [ ] Event dedupe prevents duplicate UI entries
- [ ] Unauthorized room joins are blocked and logged
