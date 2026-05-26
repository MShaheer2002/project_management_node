# Phase 10 Frontend Socket Notification Integration Guide

This guide defines frontend integration for Phase 10 realtime events (Socket.IO) on top of Phase 9 notifications.

Backend references:
- [phase-10-backend-setup-guide.md](./phase-10-backend-setup-guide.md)
- [phase10-backend-contract.md](./phase10-backend-contract.md)
- [phase-9-frontend-notification-integration-guide.md](./phase-9-frontend-notification-integration-guide.md)

## Preconditions

- Phase 9 inbox APIs are already integrated.
- Clerk auth/session is stable.
- Active workspace selection is stable.
- Frontend query cache is already used for notifications and issue/comment views.

## Transport and Auth

Use Socket.IO client.

Connect with handshake auth:

```ts
type SocketAuth = {
  token: string;         // fresh Clerk JWT
  workspaceId: string;   // active workspace
  clientVersion?: string;
};
```

Rules:

- reconnect when token changes
- reconnect when workspace changes
- do not send userId in auth payload

## Rooms and Join Flow

Server auto-joins on connect:

- `workspace:<workspaceId>`
- `user:<userId>`

Client-managed issue room:

- on issue detail mount: emit `issue:join` with `{ issueId }`
- on issue detail unmount: emit `issue:leave` with `{ issueId }`

## Envelope Contract

All events arrive in envelope:

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

Client dedupe:

- first by `envelope.id`
- for notifications additionally by `payload.notification.id`

## Notification Realtime Events

### `notification:created`

Payload:

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

Client behavior:

1. prepend notification in inbox cache if new
2. update unread cache/badge with `unread`
3. show top-right toast using `notification.title/message/actor`
4. if allowed by browser + user preference, play sound for `ui.soundKey`

### `notification:read`

Payload:

```ts
{ workspaceId: string; id: string; readAt: string | null }
```

Client behavior:

- patch matching notification row
- decrement unread count only if transitioning unread -> read

### `notification:read-all`

Payload:

```ts
{ workspaceId: string; updated: number; readAt: string }
```

Client behavior:

- set all loaded notifications to `readAt`
- set unread count to `0`
- optional: trigger background refetch for reconciliation

## Workspace Events

- `issue:created`
- `issue:updated`
- `issue:deleted`

Use these to keep issue lists and detail pages fresh.

Recommended:

- patch in place when issue exists in cache
- soft refetch if payload is not enough for local merge

## Issue Room Comment Events

- `comment:created`
- `comment:updated`
- `comment:deleted`

Use these to live-update issue comment thread without manual refresh.

## Reconnect and Resync (Required)

On reconnect or tab focus:

1. reconnect socket with fresh token
2. rejoin issue room if on issue page
3. refetch REST sources:
   - `GET /notifications?limit=30`
   - `GET /notifications/unread-count`
4. reconcile by IDs

Never rely on socket state alone.

## Query Cache Keys (Recommended)

- `['notifications', workspaceId, params]`
- `['notifications-unread', workspaceId]`
- `['issues', workspaceId, params]`
- `['issue', workspaceId, issueId]`
- `['comments', workspaceId, issueId, params]`

## Error Handling

Socket:

- `connect_error`: show subtle offline indicator
- retry with exponential backoff
- refresh Clerk token then reconnect on auth failures

REST fallback:

- keep existing polling/refetch logic as safety net

## Performance Rules

- create one socket per app session (not per component)
- register listeners once and cleanup on unmount
- avoid duplicate listeners on React rerenders
- debounce optional noisy UI refreshes

## UI Rules for Toast + Sound

- default sounds OFF until user interaction or explicit opt-in
- if autoplay blocked, show toast without sound
- map unknown `soundKey` to silent/default fallback

## End-to-End Checklist

- [ ] socket connects with valid Clerk token
- [ ] unread badge updates on `notification:created`
- [ ] top-right popup renders for new notifications
- [ ] mention/assignment/update/membership/comment notifications appear live
- [ ] issue list/detail updates on issue realtime events
- [ ] comments update live in issue room
- [ ] reconnect performs REST resync and recovers missed events

