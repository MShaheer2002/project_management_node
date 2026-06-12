# Phase 17 — Multi-Workspace: Full Implementation Guide

## Overview

This phase turns the existing single-active-workspace experience into a fully functional multi-workspace system. A single user (one Clerk identity) can own multiple workspaces AND be a member of workspaces owned by others, each with an independent role.

**What this phase is NOT:**
- Not a schema migration phase — `User ↔ WorkspaceMembership ↔ Workspace` already supports many-to-many
- Not a new permission system — per-workspace roles already work
- Not a backend rewrite — `requireWorkspace` middleware already validates membership per request

**What this phase IS:**
- Completing the workspace switcher UI
- Handling invite-accept flow for existing platform users
- Detecting and recovering from stale/deleted workspaces
- Cross-workspace notification awareness
- Edge case handling for every lifecycle scenario

---

## 1. Architecture — What Already Exists

### Backend (Phase 2 baseline)

| Component | Status | Notes |
|---|---|---|
| `User` model | Done | Global identity from Clerk |
| `Workspace` model | Done | Independent tenant boundary |
| `WorkspaceMembership` model | Done | Many-to-many with role per membership |
| `GET /workspaces` | Done | Returns all workspaces for authenticated user |
| `POST /workspaces` | Done | Creates workspace, caller becomes OWNER |
| `POST /workspaces/:id/invitations` | Done | Sends invitation with role |
| `POST /invitations/accept` | Done | Accepts invitation, creates membership |
| `X-Workspace-Id` header | Done | Every request scoped to one workspace |
| `requireWorkspace` middleware | Done | Verifies membership, attaches role to `req.workspace` |

### Frontend (Current state)

| Component | Status | Notes |
|---|---|---|
| Zustand `useAuthStore` | Done | Holds `workspace: AuthWorkspace \| null` |
| `workspaceInterceptor.ts` | Done | Injects `X-Workspace-Id` from store into every request |
| `useWorkspaces()` hook | Done | Fetches all workspaces via React Query |
| Sidebar workspace area | Placeholder | Shows workspace name, "Switch workspace" toast on click |
| `InvitePage.tsx` | Done | Handles invitation token resolution and acceptance |
| `CreateWorkspacePage.tsx` | Done | Workspace creation with slug validation |

---

## 2. Workspace Switcher Component

### 2.1 UI Specification

**Trigger:** Click on workspace name/logo area in sidebar header.

**Dropdown/Modal content:**
```
┌─────────────────────────────────┐
│  ● Agency X            OWNER   │  ← active (highlighted)
│    Startup Z           ADMIN   │
│    Client Corp         GUEST   │
│    Side Project        MEMBER  │
│─────────────────────────────────│
│  + Create new workspace        │
└─────────────────────────────────┘
```

Each row shows:
- Workspace logo (or initials fallback)
- Workspace name
- Role badge (OWNER / ADMIN / MEMBER / GUEST)
- Active indicator on current workspace

**Keyboard support:**
- Arrow keys to navigate
- Enter to select
- Escape to close
- Optional: `Cmd+K` or dedicated shortcut to open switcher from anywhere

### 2.2 Data Source

```typescript
// Already exists
const { data: workspaces } = useWorkspaces();

// Shape from GET /workspaces
interface WorkspaceResponse {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  role: 'owner' | 'admin' | 'member' | 'guest';
  defaultTeamId: string;
  teamSize: number;
  createdAt: string;
}
```

### 2.3 Switch Action

```typescript
// New hook: useWorkspaceSwitch
function useWorkspaceSwitch() {
  const { setWorkspace } = useAuthStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return (workspace: WorkspaceResponse) => {
    // 1. Update Zustand store (interceptor picks up new ID immediately)
    setWorkspace({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      logo: workspace.logo,
      role: workspace.role,
      defaultTeamId: workspace.defaultTeamId,
    });

    // 2. Invalidate ALL workspace-scoped queries
    queryClient.invalidateQueries();
    // Or more targeted:
    // queryClient.removeQueries({ predicate: isWorkspaceScopedQuery });

    // 3. Navigate to new workspace dashboard
    navigate('/dashboard', { replace: true });
  };
}
```

**Why `invalidateQueries()` instead of `removeQueries()`?**
- `invalidateQueries` marks data as stale and refetches on next access
- `removeQueries` deletes cached data, causing loading spinners on every component
- Prefer invalidate for smoother UX; use remove only if stale data from old workspace could cause confusion

---

## 3. Invite Flow — Existing Users vs New Users

### 3.1 Decision Tree

```
Invite sent (email + role)
  │
  ├─ Email matches existing User in DB?
  │   │
  │   ├─ YES → Is user already a member of this workspace?
  │   │   │
  │   │   ├─ YES → Return 409 "Already a member"
  │   │   │
  │   │   └─ NO → Create invitation (status: PENDING)
  │   │          → Send in-app notification (Socket.IO: user:<userId>)
  │   │          → Send email notification
  │   │          → User accepts → WorkspaceMembership created
  │   │          → New workspace appears in switcher
  │   │
  │   └─ NO → Create invitation (status: PENDING)
  │          → Send email with sign-up link + invitation token
  │          → User creates Clerk account
  │          → Webhook creates User row
  │          → User accepts invitation → WorkspaceMembership created
  │          → User lands in new workspace
```

### 3.2 Existing User Accept Flow (Frontend)

**Via notification inbox:**
1. User sees "You've been invited to join [Workspace Name] as [Role]"
2. User clicks "Accept" button
3. `POST /invitations/accept` with invitation token
4. Backend creates `WorkspaceMembership`
5. Frontend refetches `useWorkspaces()` query → new workspace appears in switcher
6. Optional: toast "You've joined [Workspace Name]" with "Switch now" action

**Via email link:**
1. User clicks invitation link → navigates to `/invite?token=xxx`
2. `InvitePage.tsx` resolves token via `GET /invitations/resolve?token=xxx`
3. If user is already logged in → show accept/decline UI
4. If user is not logged in → redirect to login → return to invite page → accept
5. After accept → same as step 5 above

### 3.3 Invitation States

| Status | Meaning |
|---|---|
| `PENDING` | Sent, not yet accepted or declined |
| `ACCEPTED` | User accepted, membership created |
| `DECLINED` | User explicitly declined |
| `EXPIRED` | TTL exceeded (e.g., 7 days) |
| `REVOKED` | Admin cancelled the invitation |

### 3.4 Backend Endpoint Behavior

**`POST /workspaces/:id/invitations`**
```json
// Request
{ "email": "sarah@example.com", "role": "MEMBER", "teamIds": ["team_1"], "departmentIds": [] }

// Response (existing user)
{ "success": true, "data": { "id": "inv_xxx", "email": "sarah@example.com", "role": "MEMBER", "status": "PENDING", "existingUser": true } }

// Response (new user)
{ "success": true, "data": { "id": "inv_xxx", "email": "sarah@example.com", "role": "MEMBER", "status": "PENDING", "existingUser": false } }

// Error: already a member
{ "success": false, "error": { "code": "ALREADY_MEMBER", "message": "sarah@example.com is already a member of this workspace" } }
```

**`POST /invitations/accept`**
```json
// Request
{ "token": "inv_token_xxx" }

// Response
{ "success": true, "data": { "workspace": { "id": "ws_xxx", "name": "Agency X", "slug": "agency-x", "role": "member" } } }

// Error: expired
{ "success": false, "error": { "code": "INVITATION_EXPIRED", "message": "This invitation has expired" } }

// Error: already accepted
{ "success": false, "error": { "code": "INVITATION_ALREADY_ACCEPTED", "message": "This invitation has already been accepted" } }
```

---

## 4. Workspace Lifecycle — Every Edge Case

### 4.1 Creation Scenarios

| Scenario | Behavior |
|---|---|
| First-time user, no workspaces | After Clerk sign-up → redirect to `/create-workspace` → becomes OWNER |
| User creates additional workspace | `POST /workspaces` → becomes OWNER → optionally switch to it |
| User creates workspace while in another workspace | Current workspace unaffected; new one appears in switcher |
| Workspace slug conflict | `GET /workspaces/check-slug/:slug` returns 409; user picks different slug |

### 4.2 Deletion Scenarios

| Scenario | Behavior |
|---|---|
| Owner deletes their own workspace | All data cascade-deleted; owner's other workspaces unaffected |
| Owner deletes workspace that has other members | Members lose that workspace from their switcher on next fetch |
| User's **active** workspace is deleted by its owner | Next API call returns 403/404 → stale workspace recovery kicks in |
| User's **inactive** workspace is deleted | Next `GET /workspaces` fetch drops it from the list silently |
| Owner with one workspace deletes it | After deletion → zero workspaces → redirect to create workspace page |

### 4.3 Removal Scenarios (Member Kicked)

| Scenario | Behavior |
|---|---|
| Admin removes a member | Member's `WorkspaceMembership` deleted; workspace disappears from their switcher |
| Member removed from their **active** workspace | Next API call returns 403 → stale workspace recovery |
| Member removed from an **inactive** workspace | Drops from list on next fetch |
| Owner tries to remove themselves | Backend rejects: OWNER cannot be removed (transfer ownership first) |
| Admin tries to remove another Admin | Depends on policy: typically only OWNER can remove ADMINs |

### 4.4 Role Change Scenarios

| Scenario | Behavior |
|---|---|
| OWNER demotes ADMIN to MEMBER | Membership role updated; UI reflects new permissions on next navigation |
| ADMIN promotes MEMBER to ADMIN | Membership role updated; new permissions available immediately |
| User's role changes in their **active** workspace | Sidebar permissions may change; permission-gated UI updates on refetch |
| User's role changes in an **inactive** workspace | Role badge updates in switcher on next `GET /workspaces` |

### 4.5 Stale Workspace Detection & Recovery

**When does a workspace become stale?**
- Workspace deleted by its owner
- User removed from workspace by admin
- Workspace suspended (future: billing-related)

**Detection:**
- Any workspace-scoped API call returns `403 FORBIDDEN` or `404 NOT_FOUND`
- The workspace interceptor or a global Axios response interceptor catches this

**Recovery flow:**
```
API call returns 403/404 for workspace-scoped request
  → Check: is this the active workspace?
  → YES:
      1. Clear active workspace from Zustand store
      2. Refetch GET /workspaces
      3. If workspaces.length > 0 → auto-select first workspace, navigate to dashboard
      4. If workspaces.length === 0 → navigate to /create-workspace
      5. Show toast: "You no longer have access to [Workspace Name]"
  → NO:
      1. Refetch GET /workspaces (removes stale entry from list)
      2. No navigation change needed
```

**Implementation:**
```typescript
// src/features/workspace/hooks/useStaleWorkspaceRecovery.ts
// Axios response interceptor or React Query global error handler

function useStaleWorkspaceRecovery() {
  // Listen for 403/404 on workspace-scoped requests
  // Distinguish between "resource not found" (normal 404) and "workspace access lost"
  // Heuristic: if the error response includes code "WORKSPACE_NOT_FOUND" or
  // "NOT_A_MEMBER", trigger recovery
}
```

**Important:** Not every 404 means stale workspace. The backend should return distinct error codes:
- `WORKSPACE_NOT_FOUND` — workspace doesn't exist
- `NOT_A_MEMBER` — user is not a member of this workspace
- `NOT_FOUND` — the specific resource (issue, project, etc.) doesn't exist within the workspace

### 4.6 Zero-Workspace State

When a user has no workspaces at all (removed from all, or fresh account that hasn't created one):

```
App loads → GET /workspaces returns empty array
  → Redirect to /create-workspace
  → User creates workspace → becomes OWNER → lands in dashboard
```

**Pages that should handle zero-workspace gracefully:**
- Dashboard → redirect to create workspace
- Any workspace-scoped page → redirect to create workspace
- Sidebar → show minimal state with "Create workspace" prompt

---

## 5. Cross-Workspace Notifications

### 5.1 Delivery Model

Notifications are delivered via the `user:<userId>` Socket.IO room, which is workspace-agnostic. This means a user receives notifications from ALL their workspaces regardless of which one is active.

### 5.2 Notification Payload

Each notification already includes `workspaceId`. The frontend uses this to:
- Show workspace name/logo alongside the notification if it's from a different workspace
- Determine whether clicking the notification requires a workspace switch

### 5.3 Click Behavior

```
User clicks notification from Workspace B while in Workspace A
  → Switch to Workspace B (full switch: store update + cache invalidate)
  → Navigate to notification target (issue, project, comment, etc.)
```

### 5.4 Badge Count

**Option A (Simple):** Single aggregate badge across all workspaces — shown on the bell icon.

**Option B (Rich):** Per-workspace badge in the switcher dropdown. Each workspace row shows its unread count.

Recommended: Start with Option A. Add Option B later if users find it valuable.

### 5.5 Unread Count API

Current: `GET /notifications/unread-count` returns count for active workspace.

For cross-workspace awareness, either:
- **Option A:** New endpoint `GET /notifications/unread-counts` (plural) returns `{ [workspaceId]: count }`
- **Option B:** Include unread count in `GET /workspaces` response as a field per workspace

Option B is cleaner — one fewer API call.

```json
// Enhanced GET /workspaces response
[
  {
    "id": "ws_1",
    "name": "Agency X",
    "slug": "agency-x",
    "role": "owner",
    "unreadNotifications": 3,
    ...
  },
  {
    "id": "ws_2",
    "name": "Client Corp",
    "slug": "client-corp",
    "role": "guest",
    "unreadNotifications": 0,
    ...
  }
]
```

---

## 6. Route & Navigation Design

### 6.1 URL Strategy

Workspaces are resolved via the `X-Workspace-Id` header, **not** via URL path segments. This means:

- `/dashboard` always shows the active workspace's dashboard
- `/projects/abc123` always resolves within the active workspace
- There is no `/workspaces/ws_1/projects/abc123` URL pattern

**Reason:** Simpler routing, no need to parse workspace from URL on every route, consistent with how the app already works.

**Trade-off:** Deep-linking to a specific workspace requires the user to switch first. If a user shares a URL, the recipient sees it in their own active workspace context. Cross-workspace deep links are a future enhancement.

### 6.2 Navigation on Switch

When user switches from Workspace A to Workspace B:

```
1. Update store → interceptor now sends Workspace B's ID
2. Invalidate all queries
3. Navigate to /dashboard (replace current history entry)
```

**Why reset to dashboard?** Routes like `/projects/abc123` reference entities that don't exist in the new workspace. Keeping the URL would cause 404 errors.

### 6.3 Browser History

- Switching workspace pushes `/dashboard` to history
- Browser back button → returns to previous workspace's last route
- This may cause a workspace mismatch (URL from Workspace A, but header sends Workspace B)
- **Mitigation:** On route change, verify the active workspace matches the one expected by the page. If mismatch → re-switch or redirect.

---

## 7. Backend Changes Required

Despite the schema already supporting multi-workspace, a few backend additions are needed:

### 7.1 Enhanced Invitation Response

`POST /workspaces/:id/invitations` should return whether the invitee is an existing platform user:

```typescript
// Add to invitation service
const existingUser = await prisma.user.findUnique({ where: { email } });

return {
  ...invitation,
  existingUser: !!existingUser,
};
```

This helps the frontend show appropriate messaging ("Invitation sent" vs "Invitation sent — they'll need to create an account first").

### 7.2 Distinct Error Codes for Stale Workspace

The `requireWorkspace` middleware should return specific error codes:

```typescript
// If workspace doesn't exist
throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found');

// If user is not a member
throw new AppError(403, 'NOT_A_MEMBER', 'You are not a member of this workspace');
```

### 7.3 Unread Count in Workspaces List (Optional)

Enhance `GET /workspaces` to include per-workspace unread notification count:

```typescript
// In workspace.service.ts — listWorkspaces
const workspaces = await prisma.workspaceMembership.findMany({
  where: { userId },
  include: {
    workspace: true,
    // Subquery or separate query for unread count
  },
});

// For each workspace, count unread notifications
const unreadCounts = await prisma.notification.groupBy({
  by: ['workspaceId'],
  where: { recipientId: userId, readAt: null },
  _count: true,
});
```

### 7.4 Invitation Notification for Existing Users

When inviting an existing user, emit a Socket.IO event:

```typescript
// In invitation.service.ts — after creating invitation
if (existingUser) {
  socketService.emitToUser(existingUser.id, 'invitation:received', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    role: invitation.role,
    invitedBy: actor.name,
    invitationId: invitation.id,
  });
}
```

---

## 8. Frontend Component Breakdown

### 8.1 New Components

| Component | Location | Purpose |
|---|---|---|
| `WorkspaceSwitcher.tsx` | `src/features/workspace/components/` | Dropdown/modal for listing and switching workspaces |
| `WorkspaceSwitcherItem.tsx` | `src/features/workspace/components/` | Single workspace row with logo, name, role badge |
| `InvitationNotification.tsx` | `src/features/workspace/components/` | Accept/decline UI for workspace invitations |

### 8.2 New Hooks

| Hook | Location | Purpose |
|---|---|---|
| `useWorkspaceSwitch.ts` | `src/features/workspace/hooks/` | Encapsulates switch logic: store + cache + navigate |
| `useStaleWorkspaceRecovery.ts` | `src/features/workspace/hooks/` | Global error handler for detecting lost workspace access |
| `useWorkspaceInvitations.ts` | `src/features/workspace/hooks/` | Fetches pending invitations for current user across all workspaces |

### 8.3 Modified Components

| Component | Change |
|---|---|
| `Sidebar.tsx` | Replace placeholder with `<WorkspaceSwitcher />` |
| `AppContext.tsx` or root layout | Mount `useStaleWorkspaceRecovery()` at app level |
| Notification components | Handle cross-workspace notification click (switch + navigate) |

---

## 9. Testing Matrix

### 9.1 Workspace Switching

| Test | Expected |
|---|---|
| Switch from Workspace A to B | Store updates, queries invalidate, navigates to dashboard |
| Switch and check sidebar | Sidebar shows Workspace B's teams and projects |
| Switch and check API calls | All subsequent requests carry Workspace B's ID in header |
| Switch back to A | Workspace A's data loads correctly from fresh queries |
| Rapid switching (A → B → A) | No race conditions, final state is A |

### 9.2 Invitation Flow

| Test | Expected |
|---|---|
| Invite existing user | Invitation created, notification sent, no sign-up required |
| Invite non-existing user | Invitation created, email sent with sign-up link |
| Invite existing member | 409 error, "Already a member" message |
| Accept invitation | Membership created, workspace appears in switcher |
| Decline invitation | Invitation marked declined, no membership created |
| Accept expired invitation | 410 error, "Invitation expired" message |
| Accept revoked invitation | Error, "Invitation no longer valid" |
| Accept invitation while logged out | Redirect to login → return to invite page → accept |

### 9.3 Stale Workspace Recovery

| Test | Expected |
|---|---|
| Active workspace deleted by owner | User redirected to next workspace or create page |
| User removed from active workspace | Same as above |
| User removed from inactive workspace | Workspace drops from switcher on next fetch |
| All workspaces removed | Redirect to create workspace page |
| API returns 403 for non-workspace reason | Does NOT trigger workspace recovery (e.g., permission denied on a specific action) |

### 9.4 Cross-Workspace Notifications

| Test | Expected |
|---|---|
| Notification from active workspace | Standard notification behavior |
| Notification from different workspace | Shows workspace context, click triggers switch + navigate |
| Unread count reflects all workspaces | Badge shows aggregate count |

### 9.5 Workspace Isolation

| Test | Expected |
|---|---|
| Create issue in Workspace A, switch to B | Issue not visible in B |
| Teams from A not visible in B | Sidebar shows only B's teams |
| Search in B does not return A's data | Search scoped to active workspace |
| Switching doesn't leak cached data | No stale data from A shown in B's views |

---

## 10. Implementation Order

### Step 1: Workspace Switcher (Frontend Only)
- Build `WorkspaceSwitcher` component
- Build `useWorkspaceSwitch` hook
- Replace sidebar placeholder
- Test switching between workspaces

### Step 2: Cache Invalidation on Switch
- Implement `queryClient.invalidateQueries()` on switch
- Verify all workspace-scoped queries refetch
- Verify no stale data leaks between workspaces

### Step 3: Route Reset on Switch
- Navigate to `/dashboard` on switch
- Handle browser back button edge case

### Step 4: Stale Workspace Detection
- Add distinct error codes to backend `requireWorkspace` middleware
- Build `useStaleWorkspaceRecovery` hook
- Mount at app level
- Test deletion and removal scenarios

### Step 5: Enhanced Invitation Flow
- Backend: return `existingUser` flag on invitation creation
- Backend: emit Socket.IO event for existing user invitations
- Frontend: show appropriate invitation notification
- Frontend: refetch workspaces after accepting invitation
- Test full flow for existing and new users

### Step 6: Cross-Workspace Notifications (Optional Enhancement)
- Backend: include `unreadNotifications` in `GET /workspaces` response
- Frontend: show per-workspace badge in switcher
- Frontend: handle cross-workspace notification click
- Test notification delivery and navigation

### Step 7: Zero-Workspace State
- Handle empty workspaces list on app load
- Redirect to create workspace page
- Test fresh account with no workspaces
- Test account where all workspaces were removed

---

## 11. Permissions Reference

No new permission model is needed. The existing system applies:

| Context | How role is determined |
|---|---|
| API request | `requireWorkspace` reads `X-Workspace-Id`, finds membership, attaches `req.workspace.role` |
| Frontend UI | `useAuthStore().workspace.role` drives permission checks |
| Sidebar permissions | `SidebarData.permissions` computed from active workspace role |
| Shared permission helpers | `canCreateTeam(role)`, `canManageSettings(role)`, etc. — all take the active workspace role |

**Key rule:** Being OWNER in Workspace A gives you ZERO privileges in Workspace B where you are GUEST. Roles are strictly per-workspace.

---

## 12. Future Considerations (Out of Scope for Phase 17)

| Feature | Why deferred |
|---|---|
| Workspace URL paths (`/ws/agency-x/projects/...`) | Adds routing complexity; header-based scoping works for now |
| Cross-workspace search | Breaks workspace isolation principle; revisit if users request it |
| Workspace transfer (change owner) | Complex ownership transfer; defer to post-launch |
| Workspace archival (soft delete) | Current delete is cascade; archival needs separate retention policy |
| Plan-based workspace limits | Billing (Phase 13) can gate this; not needed for core multi-workspace |
| Cross-workspace deep links | Requires URL-based workspace resolution; defer |
| Workspace groups / organizations | Meta-grouping of workspaces; enterprise feature |
