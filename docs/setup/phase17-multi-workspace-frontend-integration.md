# Phase 17 — Multi-Workspace: Frontend Integration Guide

## Overview

This guide tells you exactly what to change in the React frontend to complete multi-workspace support. The backend changes are already shipped. The frontend needs:

1. Update `WorkspaceResponse` and `InvitationAcceptResponse` types to match new backend shapes
2. Update error interceptor to handle `WORKSPACE_NOT_FOUND` (404)
3. Build workspace switcher component + hook
4. Update `InvitePage.tsx` to use new error codes
5. Update `AuthSync.tsx` to pass `unreadNotifications` through
6. Handle cross-workspace notification clicks
7. Handle stale workspace recovery

---

## 1. Type Updates — `workspaceService.ts`

### 1.1 `WorkspaceResponse` — New Fields

The backend `GET /workspaces` now returns `unreadNotifications` and `defaultTeamId` for every workspace.

```typescript
// src/features/workspace/services/workspaceService.ts

export interface WorkspaceResponse {
  id: string;
  name: string;
  slug: string;
  logo?: string;
  role: string;
  defaultTeamId?: string;
  teamSize?: string;
  unreadNotifications?: number;  // NEW — per-workspace unread count
  joinedAt?: string;             // NEW — when user joined this workspace
  createdAt?: string;
}
```

### 1.2 `InvitationAcceptResponse` — Shape Change

The backend now returns a nested `workspace` object instead of flat fields.

**Before (old shape):**
```typescript
export interface InvitationAcceptResponse {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  workspaceLogo?: string | null;
  role: string;
  defaultTeamId?: string;
  alreadyAccepted?: boolean;
}
```

**After (new shape):**
```typescript
export interface InvitationAcceptResponse {
  workspace: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
  };
  role: string;
  alreadyAccepted?: boolean;
}
```

### 1.3 `InvitationResponse` — New Field

`sendInvitation` now returns an `existingUser` flag.

```typescript
export interface InvitationResponse {
  id: string;
  email: string;
  role: InvitationRole;
  teamId: string;
  departmentId?: string | null;
  status?: string;
  existingUser?: boolean;  // NEW — true if invitee already has a platform account
  createdAt?: string;
}
```

---

## 2. Update `InvitePage.tsx`

Two changes needed: new accept response shape + new error codes.

### 2.1 Accept Handler — New Response Shape

```typescript
// src/pages/auth/InvitePage.tsx — handleAccept()

const accepted = await workspaceService.acceptInvitation(token);
window.localStorage.removeItem(PENDING_INVITE_TOKEN_KEY);

// OLD shape: accepted.workspaceId, accepted.workspaceName, etc.
// NEW shape: accepted.workspace.id, accepted.workspace.name, etc.
setWorkspace({
  id: accepted.workspace.id,
  name: accepted.workspace.name,
  slug: accepted.workspace.slug,
  logo: accepted.workspace.logo || undefined,
  role: accepted.role.toLowerCase() as 'owner' | 'admin' | 'member' | 'guest',
});
```

### 2.2 Error Handling — New Error Codes

The backend now returns specific error codes instead of generic `NOT_FOUND`/`CONFLICT`/`FORBIDDEN`.

**Resolve phase** (update the `catch` in `resolveInvite`):

```typescript
} catch (err) {
  const apiError = err as ApiAxiosError;
  const code = apiError.response?.data?.error?.code;
  const message = apiError.response?.data?.error?.message;

  switch (code) {
    case 'INVITATION_NOT_FOUND':
      setError('This invitation is no longer valid.');
      break;
    case 'INVITATION_EXPIRED':
      setError('This invitation has expired. Ask the workspace admin to send a new one.');
      break;
    case 'INVITATION_REVOKED':
      setError('This invitation has been cancelled by the workspace admin.');
      break;
    case 'INVITATION_ALREADY_ACCEPTED':
      setError('This invitation has already been accepted.');
      break;
    default:
      setError(message || 'Could not load this invitation.');
  }
}
```

**Accept phase** (update the `catch` in `handleAccept`):

```typescript
} catch (err) {
  const apiError = err as ApiAxiosError;
  const code = apiError.response?.data?.error?.code;
  const message = apiError.response?.data?.error?.message;

  switch (code) {
    case 'INVITATION_EMAIL_MISMATCH':
      setError(`This invitation was sent to ${invite.invitedEmail}. Please sign in with that email.`);
      break;
    case 'ALREADY_MEMBER':
      setError("You're already a member of this workspace.");
      break;
    case 'INVITATION_NOT_FOUND':
      setError('This invitation is no longer valid.');
      break;
    case 'INVITATION_EXPIRED':
      setError('This invitation has expired. Ask the workspace admin to send a new one.');
      break;
    case 'INVITATION_REVOKED':
      setError('This invitation has been cancelled.');
      break;
    case 'INVITATION_ALREADY_ACCEPTED':
      setError('This invitation has already been accepted.');
      break;
    default:
      setError(message || 'Could not accept this invitation.');
  }
}
```

### 2.3 Full Error Code Reference

| Code | HTTP | When | User Message |
|------|------|------|-------------|
| `INVITATION_NOT_FOUND` | 404 | Invalid/missing token | "This invitation is no longer valid." |
| `INVITATION_EXPIRED` | 410 | TTL exceeded (7 days) | "This invitation has expired." |
| `INVITATION_REVOKED` | 410 | Admin cancelled it | "This invitation has been cancelled." |
| `INVITATION_ALREADY_ACCEPTED` | 400 | Token already used | "This invitation has already been accepted." |
| `INVITATION_EMAIL_MISMATCH` | 403 | Forwarded-invite abuse | "Sign in with the invited email." |
| `ALREADY_MEMBER` | 409 | User already in workspace | "You're already a member." |

---

## 3. Update Error Interceptor — Stale Workspace Recovery

The `requireWorkspace` middleware now returns distinct codes:
- `404 WORKSPACE_NOT_FOUND` — workspace was deleted
- `403 NOT_WORKSPACE_MEMBER` — user was removed

The error interceptor currently only handles `NOT_WORKSPACE_MEMBER`. Add handling for `WORKSPACE_NOT_FOUND`.

```typescript
// src/shared/services/interceptors/errorInterceptor.ts

case 403:
  if (errorCode === 'NOT_WORKSPACE_MEMBER') {
    console.warn('[ErrorInterceptor] NOT_WORKSPACE_MEMBER — user removed from workspace');
    useAuthStore.getState().setAuth(
      useAuthStore.getState().currentUser!,
      null
    );
    if (typeof window !== 'undefined') {
      window.location.href = '/org-creation';
    }
  } else if (errorCode !== 'USER_NOT_SYNCED' && !skipGlobalErrorToast) {
    showToast("You don't have permission to perform this action.", 'error', 'Access denied');
  }
  break;

// ADD this new case:
case 404:
  if (errorCode === 'WORKSPACE_NOT_FOUND') {
    console.warn('[ErrorInterceptor] WORKSPACE_NOT_FOUND — workspace deleted');
    useAuthStore.getState().setAuth(
      useAuthStore.getState().currentUser!,
      null
    );
    if (typeof window !== 'undefined') {
      window.location.href = '/org-creation';
    }
  } else if (!skipGlobalErrorToast) {
    // Don't toast generic 404s — let the page handle "not found" UI
  }
  break;
```

**Why both 403 AND 404?** The frontend needs to distinguish:
- "Workspace was deleted" → show "This workspace no longer exists"
- "You were removed" → show "You no longer have access to [workspace name]"

Both trigger the same recovery flow (clear workspace → redirect to org-creation or next workspace), but the toast message differs.

---

## 4. Workspace Switcher — New Hook

### 4.1 `useWorkspaceSwitch` Hook

Create a new hook that encapsulates the full switch logic.

**File:** `src/features/workspace/hooks/useWorkspaceSwitch.ts`

```typescript
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore, type AuthWorkspace } from '@/app/stores/useAuthStore';
import { realtimeSocket } from '@shared/services/realtimeSocket';
import { useAuth } from '@clerk/clerk-react';
import type { WorkspaceResponse } from '../services/workspaceService';

/**
 * Encapsulates the full workspace switch sequence:
 *   1. Update Zustand store (interceptor picks up new ID immediately)
 *   2. Disconnect + reconnect Socket.IO to new workspace room
 *   3. Invalidate ALL workspace-scoped React Query cache
 *   4. Navigate to /dashboard (deep routes reference workspace-specific entities)
 */
export function useWorkspaceSwitch() {
  const setWorkspace = useAuthStore((s) => s.setWorkspace);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { getToken } = useAuth();

  const switchWorkspace = useCallback(
    async (workspace: WorkspaceResponse) => {
      const activeWorkspace = useAuthStore.getState().workspace;

      // No-op if switching to the same workspace
      if (activeWorkspace?.id === workspace.id) return;

      // 1. Update Zustand store
      const authWorkspace: AuthWorkspace = {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        logo: workspace.logo,
        role: workspace.role.toLowerCase() as AuthWorkspace['role'],
        defaultTeamId: workspace.defaultTeamId,
      };
      setWorkspace(authWorkspace);

      // 2. Reconnect Socket.IO to new workspace
      const token = await getToken();
      if (token) {
        realtimeSocket.disconnect();
        realtimeSocket.connect({ token, workspaceId: workspace.id });
      }

      // 3. Invalidate all queries — stale data from old workspace must not leak
      //    invalidateQueries marks data stale and refetches on next access
      //    (smoother than removeQueries which causes loading spinners everywhere)
      queryClient.invalidateQueries();

      // 4. Navigate to dashboard — deep routes like /projects/abc123 reference
      //    entities that don't exist in the new workspace
      navigate('/dashboard', { replace: true });
    },
    [setWorkspace, queryClient, navigate, getToken],
  );

  return switchWorkspace;
}
```

### 4.2 Key Design Decisions

**Why `invalidateQueries()` instead of `removeQueries()`?**
- `invalidateQueries` marks data as stale — components keep showing current data while refetching
- `removeQueries` deletes cached data — every component shows a loading spinner simultaneously
- Invalidate is smoother UX; the old workspace data flashes briefly but is replaced quickly

**Why reconnect Socket.IO?**
- The socket auth handshake includes `workspaceId` — the server joins the socket to the correct workspace room
- Without reconnecting, you'd receive events from the old workspace

**Why navigate to `/dashboard`?**
- URLs like `/projects/abc123` or `/issues/LIN-42` reference entities in the old workspace
- Keeping the URL would cause 404 errors in the new workspace context
- `/dashboard` is always safe — it loads fresh data for the active workspace

---

## 5. Workspace Switcher — Component

### 5.1 `WorkspaceSwitcher.tsx`

**File:** `src/features/workspace/components/WorkspaceSwitcher.tsx`

```typescript
import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { useAuthStore } from '@/app/stores/useAuthStore';
import { useWorkspaces } from '../hooks/useWorkspaceDetails';
import { useWorkspaceSwitch } from '../hooks/useWorkspaceSwitch';
import type { WorkspaceResponse } from '../services/workspaceService';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
};

const ROLE_COLORS: Record<string, string> = {
  owner: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  admin: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  member: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  guest: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
};

export const WorkspaceSwitcher: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const activeWorkspace = useAuthStore((s) => s.workspace);
  const { data: workspaces } = useWorkspaces();
  const switchWorkspace = useWorkspaceSwitch();

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    if (isOpen) document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const handleSelect = async (ws: WorkspaceResponse) => {
    setIsOpen(false);
    await switchWorkspace(ws);
  };

  const handleCreateNew = () => {
    setIsOpen(false);
    navigate('/org-creation');
  };

  if (!activeWorkspace) return null;

  return (
    <div ref={dropdownRef} className="relative">
      {/* Trigger */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg
                   hover:bg-gray-100 dark:hover:bg-white/5 transition-colors text-left"
      >
        <WorkspaceLogo name={activeWorkspace.name} logo={activeWorkspace.logo} size="sm" />
        <span className="font-semibold text-sm text-gray-900 dark:text-white truncate flex-1">
          {activeWorkspace.name}
        </span>
        <ChevronDown size={14} className="text-gray-400 shrink-0" />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute left-0 top-full mt-1 w-72 z-50
                        bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark
                        rounded-xl shadow-lg overflow-hidden">
          <div className="py-1 max-h-64 overflow-y-auto">
            {workspaces?.map((ws) => {
              const role = ws.role.toLowerCase();
              const isActive = ws.id === activeWorkspace.id;

              return (
                <button
                  key={ws.id}
                  onClick={() => handleSelect(ws)}
                  className={`flex items-center gap-3 w-full px-3 py-2.5 text-left
                    hover:bg-gray-50 dark:hover:bg-white/5 transition-colors
                    ${isActive ? 'bg-primary/5' : ''}`}
                >
                  <WorkspaceLogo name={ws.name} logo={ws.logo} size="md" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
                        {ws.name}
                      </span>
                      {isActive && <Check size={14} className="text-primary shrink-0" />}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${ROLE_COLORS[role] || ROLE_COLORS.member}`}>
                        {ROLE_LABELS[role] || role}
                      </span>
                      {(ws.unreadNotifications ?? 0) > 0 && !isActive && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400">
                          {ws.unreadNotifications} unread
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="border-t border-gray-100 dark:border-border-dark">
            <button
              onClick={handleCreateNew}
              className="flex items-center gap-2 w-full px-3 py-2.5 text-sm
                         text-gray-600 dark:text-gray-400
                         hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
            >
              <Plus size={16} />
              Create new workspace
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const WorkspaceLogo: React.FC<{ name: string; logo?: string; size: 'sm' | 'md' }> = ({ name, logo, size }) => {
  const dim = size === 'sm' ? 'w-7 h-7' : 'w-9 h-9';
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm';

  if (logo) {
    return <img src={logo} alt={name} className={`${dim} rounded-lg object-cover`} />;
  }
  return (
    <div className={`${dim} rounded-lg bg-primary/10 text-primary flex items-center justify-center ${textSize} font-bold shrink-0`}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
};
```

### 5.2 Mount in Sidebar

Replace the existing workspace dropdown in `Sidebar.tsx` with the new `WorkspaceSwitcher`.

```typescript
// src/components/Sidebar.tsx
import { WorkspaceSwitcher } from '@features/workspace/components/WorkspaceSwitcher';

// In the sidebar header area, replace the existing workspace name/dropdown with:
<WorkspaceSwitcher />
```

The existing sidebar workspace dropdown likely has a "Switch workspace" placeholder or toast — replace that entire block with `<WorkspaceSwitcher />`.

---

## 6. Update `AuthSync.tsx`

`AuthSync` already fetches `GET /workspaces` and maps them to `AuthWorkspace`. The backend now returns `unreadNotifications` — no AuthSync change is needed since `AuthWorkspace` doesn't store unread counts (they're consumed by the switcher via `useWorkspaces()` hook separately).

However, ensure the workspace mapping handles the `defaultTeamId` field which was already returned but may not have been mapped in all code paths:

```typescript
// src/app/providers/AuthSync.tsx — in the workspace mapping

backendWorkspaces = data.data.map((ws: any) => ({
  id: ws.id,
  name: ws.name,
  slug: ws.slug,
  logo: ws.logo || undefined,
  role: ws.role?.toLowerCase() || 'member',
  defaultTeamId: ws.defaultTeamId || undefined,  // Ensure this is mapped
}));
```

This is already correct in the current code — no change needed.

---

## 7. Stale Workspace Recovery — Full Flow

The error interceptor changes from section 3 handle the redirect. But the `/org-creation` page needs to handle a scenario where the user still has OTHER workspaces (they were removed from one, but have others).

### 7.1 Enhanced Recovery Flow

Instead of always redirecting to `/org-creation`, redirect to a smarter recovery:

```typescript
// src/shared/services/interceptors/errorInterceptor.ts
// Replace the redirect logic for both WORKSPACE_NOT_FOUND and NOT_WORKSPACE_MEMBER:

const handleStaleWorkspace = async (errorCode: string) => {
  const currentUser = useAuthStore.getState().currentUser;
  if (!currentUser) return;

  console.warn(`[ErrorInterceptor] ${errorCode} — triggering workspace recovery`);

  // Clear the stale workspace
  useAuthStore.getState().setAuth(currentUser, null);

  // AuthSync will re-run on next render cycle:
  //   - Fetches GET /workspaces
  //   - If workspaces exist → picks first one, navigates to /dashboard
  //   - If no workspaces → navigates to /org-creation
  if (typeof window !== 'undefined') {
    window.location.href = '/org-creation';
  }
};
```

`AuthSync` already handles the "has other workspaces" case — when it runs with `workspace: null` in the store, it fetches `GET /workspaces` and auto-selects the first one.

---

## 8. Cross-Workspace Notification Handling

The user receives notifications from ALL workspaces via the `user:<userId>` Socket.IO room. When a notification arrives from a different workspace, the UI needs to:

1. Show the workspace name alongside the notification
2. On click: switch workspace first, then navigate to the target

### 8.1 Notification Item — Show Workspace Context

In your notification list/inbox component, check if the notification's `workspaceId` (from `metadata`) differs from the active workspace:

```typescript
// In your notification item component

const activeWorkspaceId = useAuthStore((s) => s.workspace?.id);
const notificationWorkspaceId = notification.metadata?.workspaceId as string | undefined;
const isCrossWorkspace = notificationWorkspaceId && notificationWorkspaceId !== activeWorkspaceId;
const workspaceName = notification.metadata?.workspaceName as string | undefined;

// Render workspace badge if cross-workspace
{isCrossWorkspace && workspaceName && (
  <span className="text-[10px] text-gray-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">
    {workspaceName}
  </span>
)}
```

### 8.2 Notification Click — Switch + Navigate

```typescript
const switchWorkspace = useWorkspaceSwitch();
const { data: workspaces } = useWorkspaces();

const handleNotificationClick = async (notification: NotificationItem) => {
  const targetWorkspaceId = notification.metadata?.workspaceId as string | undefined;
  const activeWorkspaceId = useAuthStore.getState().workspace?.id;

  // If cross-workspace: switch first, then the URL will load in the new context
  if (targetWorkspaceId && targetWorkspaceId !== activeWorkspaceId) {
    const targetWorkspace = workspaces?.find((ws) => ws.id === targetWorkspaceId);
    if (targetWorkspace) {
      await switchWorkspace(targetWorkspace);
      // After switch, navigate to the notification target
      navigate(notification.target.url);
      return;
    }
    // Workspace not in list (removed?) — just navigate, let error interceptor handle
  }

  // Same workspace — navigate directly
  navigate(notification.target.url);
};
```

---

## 9. Invitation Notification — Accept from Inbox

When an existing user is invited to a workspace, they now receive an in-app notification (type: `WORKSPACE_INVITATION`). Add handling for this notification type.

### 9.1 Notification Type Constant

```typescript
// src/features/notifications/types.ts

export type NotificationType =
  | 'MENTION'
  | 'ASSIGNMENT'
  | 'UPDATE'
  | 'COMMENT_REPLY'
  | 'PROJECT_MEMBER'
  | 'TEAM_MEMBER'
  | 'WORKSPACE_INVITE'
  | 'WORKSPACE_INVITATION'  // NEW — in-app invitation notification
  | 'ISSUE_DUE_SOON'
  | 'ISSUE_OVERDUE';
```

### 9.2 Notification Click for Invitations

When the user clicks a `WORKSPACE_INVITATION` notification, navigate them to the invite page:

```typescript
// In your notification click handler:

if (notification.type === 'WORKSPACE_INVITATION') {
  // target.url is /invite?token=<rawToken>
  navigate(notification.target.url);
  return;
}
```

### 9.3 Notification Icon

Add the icon mapping for the new type:

```typescript
case 'WORKSPACE_INVITATION':
  return <Mail size={16} className="text-sky-500" />;
```

---

## 10. Send Invitation — Show `existingUser` Feedback

The `sendInvitation` response now includes `existingUser: boolean`. Use this to show appropriate success messaging:

```typescript
// In your invitation form's onSuccess handler:

const result = await workspaceService.sendInvitation({ ... });

if (result.existingUser) {
  showToast(
    `Invitation sent to ${result.email}. They'll receive an in-app notification.`,
    'success',
    'Invitation sent'
  );
} else {
  showToast(
    `Invitation sent to ${result.email}. They'll need to create an account first.`,
    'success',
    'Invitation sent'
  );
}
```

---

## 11. Socket.IO — Reconnect on Workspace Switch

The `useWorkspaceSwitch` hook already handles socket reconnection. But ensure the `RealtimeNotificationProvider` or `useNotificationRealtime` hook reconnects properly when the workspace changes.

The current `realtimeSocket.connect()` checks the auth key (`workspaceId:token`) and only creates a new connection if it changed. Since `useWorkspaceSwitch` calls `disconnect()` then `connect()` with the new workspace ID, this should work automatically.

**Verify:** After switching workspaces, the Socket.IO `connect` event log should show the new `workspaceId`.

---

## 12. Implementation Order

Follow this order to avoid breaking the app during development:

### Step 1: Type Updates (non-breaking)
- Update `WorkspaceResponse` type (add `unreadNotifications`, `joinedAt`)
- Update `InvitationAcceptResponse` type (nested `workspace` object)
- Update `InvitationResponse` type (add `existingUser`)

### Step 2: `InvitePage.tsx` Error Codes
- Update resolve and accept error handling to use new codes
- Test: resolve expired/revoked/accepted invitations, accept with wrong email

### Step 3: Error Interceptor — Stale Workspace
- Add `404 WORKSPACE_NOT_FOUND` handling
- Test: manually delete a workspace in DB → verify redirect

### Step 4: Workspace Switcher Hook
- Create `useWorkspaceSwitch.ts`
- Test: call from console → verify store update, query invalidation, navigation

### Step 5: Workspace Switcher Component
- Create `WorkspaceSwitcher.tsx`
- Mount in Sidebar header
- Test: switch between workspaces, verify sidebar/data updates, no stale data

### Step 6: Cross-Workspace Notifications
- Add workspace badge to notification items
- Add switch-then-navigate on cross-workspace notification click
- Add `WORKSPACE_INVITATION` notification type handling

### Step 7: Invitation Feedback
- Show `existingUser` messaging in invitation success toast

### Step 8: Full Integration Test
- Test all edge cases from the testing matrix below

---

## 13. Testing Matrix

### Workspace Switching

| Test | Expected |
|------|----------|
| Switch from A to B | Store updates, all queries invalidate, sidebar shows B's teams, URL → /dashboard |
| Switch from A to B, then back to A | Both switches clean, no stale data from B visible in A |
| Rapid switch (A → B → C) | Final state is C, no race conditions |
| Switch while on deep route `/projects/abc` | Navigates to `/dashboard` (not 404) |
| Browser back after switch | Returns to previous workspace's route (may cause mismatch — handled by error interceptor) |

### Invitation Flow

| Test | Expected |
|------|----------|
| Invite existing platform user | `existingUser: true` in response, "They'll receive an in-app notification" toast |
| Invite new user (no account) | `existingUser: false`, "They'll need to create an account" toast |
| Invite existing workspace member | `409 ALREADY_MEMBER`, form error shown |
| Resolve expired invitation | `410 INVITATION_EXPIRED`, "expired" message shown |
| Resolve revoked invitation | `410 INVITATION_REVOKED`, "cancelled" message shown |
| Resolve already-accepted invitation | `400 INVITATION_ALREADY_ACCEPTED`, "already accepted" message shown |
| Accept with wrong email | `403 INVITATION_EMAIL_MISMATCH`, "sign in with invited email" message |
| Accept already-accepted invitation | Idempotent success, `alreadyAccepted: true`, navigates to dashboard |
| Accept while not signed in | Redirects to /signup with redirect back to /invite |

### Stale Workspace Recovery

| Test | Expected |
|------|----------|
| Active workspace deleted by owner | Next API call → 404 WORKSPACE_NOT_FOUND → workspace cleared → AuthSync picks next workspace or /org-creation |
| User removed from active workspace | Next API call → 403 NOT_WORKSPACE_MEMBER → same recovery as above |
| User removed from inactive workspace | Next `GET /workspaces` fetch → workspace drops from switcher list silently |
| All workspaces removed | Recovery → AuthSync finds empty list → /org-creation |
| API 404 for a normal resource (e.g. issue not found) | NOT treated as stale workspace — only `WORKSPACE_NOT_FOUND` code triggers recovery |

### Cross-Workspace Notifications

| Test | Expected |
|------|----------|
| Notification from active workspace | Standard behavior, no workspace badge |
| Notification from different workspace | Shows workspace name badge |
| Click notification from different workspace | Switches to that workspace, then navigates to target |
| `WORKSPACE_INVITATION` notification | Shows "invited you to join [workspace]", click navigates to /invite page |
| Unread badges in switcher | Per-workspace counts shown, active workspace has no badge (already visible) |

### Workspace Isolation

| Test | Expected |
|------|----------|
| Create issue in A, switch to B | Issue not visible in B's issue list |
| Search in B | Does not return A's data |
| Sidebar in B | Shows only B's teams and projects |
| Cached data after switch | No stale data from A appears in B (all queries invalidated) |

---

## 14. Backend API Changes Reference

For completeness — these are the backend changes already shipped that this guide integrates with:

### `GET /workspaces` — Enhanced Response

```json
[
  {
    "id": "ws_1",
    "name": "Agency X",
    "slug": "agency-x",
    "logo": null,
    "teamSize": "SMALL",
    "role": "OWNER",
    "defaultTeamId": "team_abc",
    "unreadNotifications": 3,
    "joinedAt": "2026-01-15T...",
    "createdAt": "2026-01-15T..."
  }
]
```

### `POST /workspaces/:id/invitations` — Enhanced Response

```json
{
  "id": "inv_1",
  "email": "sarah@example.com",
  "role": "MEMBER",
  "status": "PENDING",
  "existingUser": true,
  "expiresAt": "2026-06-16T...",
  "createdAt": "2026-06-09T..."
}
```

### `POST /invitations/accept` — New Response Shape

```json
{
  "workspace": {
    "id": "ws_1",
    "name": "Agency X",
    "slug": "agency-x",
    "logo": null
  },
  "role": "MEMBER",
  "alreadyAccepted": false
}
```

### `requireWorkspace` Middleware — Distinct Error Codes

| Scenario | Status | Code | Frontend Action |
|----------|--------|------|-----------------|
| Workspace ID missing | 400 | `VALIDATION_ERROR` | Show generic error |
| Workspace doesn't exist | 404 | `WORKSPACE_NOT_FOUND` | Stale workspace recovery |
| User not a member | 403 | `NOT_WORKSPACE_MEMBER` | Stale workspace recovery |
