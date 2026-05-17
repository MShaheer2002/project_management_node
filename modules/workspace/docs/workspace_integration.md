# Workspace Integration Guide

> This guide explains how the workspace system works and what the frontend needs to do to integrate with it.
> No code snippets — this is a behaviour and flow reference.

---

## 1. Core Concept

A workspace is the tenant boundary. Every user must belong to at least one workspace to use the app. All application data (issues, projects, teams) lives inside a workspace. Users can belong to multiple workspaces and switch between them.

---

## 2. Onboarding Flow (New User)

### When to Show Onboarding

After a user signs in (or signs up), the frontend must call `GET /workspaces` to check if the user belongs to any workspaces.

- **Empty response** → user has no workspaces → redirect to onboarding page
- **Non-empty response** → user has workspaces → set the first one as active and go to dashboard

This check must happen on every app load (page refresh, returning session), not just after sign-up. A user could have been removed from all their workspaces while logged out.

### Onboarding Form Fields

| Field | Maps To | Validation | Notes |
|-------|---------|------------|-------|
| Organization name | `name` | Required, 1-100 chars, trimmed | Free text |
| Workspace URL | `slug` | Required, 3-50 chars, lowercase letters/numbers/hyphens only, cannot start or end with hyphen | Appended with `.linearis.app` in the UI (visual only — don't send the suffix) |
| Team size | `teamSize` | Optional enum: `SMALL`, `MEDIUM`, `LARGE`, `ENTERPRISE` | Maps to: 1-5, 6-20, 21-50, 50+ |

### Slug Rules the Frontend Should Enforce

1. Auto-convert to lowercase as user types
2. Replace spaces with hyphens
3. Strip any character that isn't `a-z`, `0-9`, or `-`
4. Don't allow starting or ending with a hyphen
5. Minimum 3 characters, maximum 50
6. Check availability in real-time via `GET /workspaces/check-slug/:slug` (debounce 300ms)
7. These slugs are reserved and will be rejected by the backend: `api`, `app`, `admin`, `www`, `mail`, `help`, `support`, `billing`, `status`, `docs`, `blog`, `login`, `signup`, `auth`, `oauth`, `sso`, `webhook`, `webhooks`, `settings`, `dashboard`, `onboarding`

### Auto-Generating Slug from Name

When the user types the organization name, the slug field should auto-populate (but remain editable). Example: `"Acme Corp"` → `"acme-corp"`. If the user manually edits the slug, stop auto-generating.

### Submission

Send `POST /workspaces` with `{ name, slug, teamSize }`. On success, the response contains the workspace with `role: "OWNER"` and `defaultTeamId`. Store both IDs and redirect to the dashboard.

### What Happens on the Backend (Workspace Creation)

Creating a workspace is not just one record — it sets up the entire initial structure in a single transaction:

1. **Workspace** created with the provided name, slug, teamSize
2. **WorkspaceMembership** created with role `OWNER` for the creator
3. **Default Team** created with the same name as the workspace — the creator becomes the team lead
4. **TeamMembership** created — the creator is added as a member of the default team

This default team is important because all work in Linearis happens inside teams. Issues, projects, and cycles all belong to a team. Without at least one team, the workspace would be unusable.

The response includes `defaultTeamId` — the frontend should store this alongside the workspace ID. It's needed when:
- Inviting members (every invite requires a team assignment)
- Creating the first project or issue (must belong to a team)
- Populating the team dropdown in the sidebar

### Error Handling

| Error Code | HTTP | Meaning | Frontend Action |
|---|---|---|---|
| `WORKSPACE_SLUG_TAKEN` | 409 | Another workspace already uses this slug | Show inline error on the slug field: "This URL is already taken" |
| `VALIDATION_ERROR` | 422 | Input didn't pass validation | Show field-level errors from `error.details` array |
| `UNAUTHORIZED` | 401 | Token expired or missing | Redirect to login |

---

## 3. Active Workspace Context

### How It Works

After onboarding or sign-in, the frontend must track which workspace is "active". This workspace ID is sent with every API request that needs workspace context.

### Where to Store It

Store the active workspace ID in localStorage (persists across page refreshes) and in a React context/state (for reactive updates). On app load, read from localStorage. If the stored workspace no longer exists (user was removed), fall back to the first workspace from `GET /workspaces`, or redirect to onboarding if the list is empty.

### Sending It with Requests

Every API call to workspace-scoped endpoints (issues, projects, teams, departments, etc.) must include the active workspace ID as a header:

```
X-Workspace-Id: <workspace-uuid>
```

Routes that already have the workspace ID in the URL path (like `/workspaces/:workspaceId/members`) don't need the header — the backend reads it from the URL param.

### When the Header is NOT Needed

- `GET /health` — no auth, no workspace
- `POST /webhooks/clerk` — server-to-server, no workspace
- `GET /me` — user profile, not workspace-scoped
- `POST /workspaces` — creating a workspace (none exists yet)
- `GET /workspaces` — listing workspaces (user might have zero)
- `GET /workspaces/check-slug/:slug` — availability check during onboarding
- `GET /invitations/resolve?t=<token>` — public, no auth, no workspace
- `POST /invitations/accept` — authenticated but no workspace context (user is joining one)

---

## 4. Workspace Switcher

### What It Is

Users can belong to multiple workspaces. The sidebar should show a workspace switcher (dropdown or modal) that lists all workspaces the user belongs to.

### Data Source

`GET /workspaces` returns all workspaces with the user's role in each. This powers the switcher dropdown.

### Switching Behaviour

When the user selects a different workspace:

1. Update the stored active workspace ID (localStorage + React context)
2. The `X-Workspace-Id` header on all subsequent API calls automatically changes
3. Reload the current page's data (dashboard stats, issue list, etc.) for the new workspace
4. Do NOT navigate away — stay on the same page but refresh the data

### Display

Each workspace in the switcher should show:
- Workspace name
- Workspace logo (or a fallback initial/icon)
- User's role badge (OWNER, ADMIN, MEMBER, GUEST)

---

## 5. Workspace Settings Page

### Who Can Access

Only ADMIN and OWNER can see the settings page. MEMBER and GUEST should see a "you don't have permission" state or the settings link should not appear in the sidebar for them.

### What Can Be Changed

| Field | Endpoint | Who Can Change |
|-------|----------|----------------|
| Workspace name | `PATCH /workspaces/:id` with `{ name }` | ADMIN, OWNER |
| Workspace logo | `PATCH /workspaces/:id` with `{ logo }` | ADMIN, OWNER |

The slug CANNOT be changed after creation. Show it as read-only on the settings page.

### Danger Zone

The settings page should have a "Danger Zone" section at the bottom with a "Delete Workspace" button. Only visible to OWNER. Show a confirmation dialog that requires the user to type the workspace name to confirm. On confirm, call `DELETE /workspaces/:id`. On success, redirect to `GET /workspaces` and pick another workspace, or redirect to onboarding if no workspaces remain.

---

## 6. Members Page

### Data Source

`GET /workspaces/:workspaceId/members` returns all members with their profiles and roles.

### Display

A table or list showing:
- Avatar (or fallback initials)
- Name
- Email
- Role badge (OWNER shown with a distinct badge like a crown or shield)
- Joined date

### Role Badge Colours

| Role | Suggested Badge |
|------|-----------------|
| OWNER | Orange/gold dot or crown icon |
| ADMIN | Shield icon |
| MEMBER | Default/neutral |
| GUEST | Muted/dimmed |

### Actions (Visible Based on Current User's Role)

If current user is ADMIN or OWNER, show a dropdown per member with:
- **Change role** → opens a role selector (ADMIN, MEMBER, GUEST). Cannot assign OWNER. Cannot change the OWNER's role.
- **Remove** → confirmation dialog, then `DELETE /workspaces/:workspaceId/members/:userId`. Cannot remove the OWNER.

The OWNER's row should have no action dropdown (or a disabled one).

### Invite Flow

An "Invite Member" button (visible only to ADMIN and OWNER) opens a modal with 4 fields:

| Field | Required | Description |
|-------|----------|-------------|
| Email address | Yes | The invitee's email |
| Role | Yes | Dropdown: ADMIN, MEMBER, GUEST (no OWNER option) |
| Team assignment | Yes | Dropdown of teams in this workspace — the invitee will be added to this team on acceptance |
| Department | No | Dropdown of departments (with a "No Department" option) — if selected, the invitee is added to this department on acceptance |

The team dropdown is populated from `GET /workspaces/:workspaceId/members` (or a future teams list endpoint). The department dropdown from department list. Both are workspace-scoped.

On submit, call `POST /workspaces/:workspaceId/invitations` with `{ email, role, teamId, departmentId }`. This sends an invitation EMAIL — it does NOT immediately create a membership. The invitee must click the link and accept. See Section 10 for the full invitation flow.

On acceptance, the backend creates all memberships in one transaction:
- **WorkspaceMembership** — with the selected role
- **TeamMembership** — added to the selected team
- **DepartmentMembership** — added to the selected department (only if one was chosen)

Below the member list, show a "Pending Invitations" section powered by `GET /workspaces/:workspaceId/invitations`. Each pending invite shows the email, role, assigned team, department (if any), who invited them, and a "Revoke" button.

| Error Code | Meaning | Frontend Action |
|---|---|---|
| `MEMBER_ALREADY_EXISTS` | User is already in this workspace | Show: "This user is already a member." |
| `NOT_FOUND` | Team or department doesn't exist in this workspace | Should not happen if dropdowns are populated correctly |
| `INSUFFICIENT_ROLE` | Current user doesn't have permission | Should not happen if UI hides the button correctly |

---

## 7. Role-Based UI Visibility

The frontend should hide or disable UI elements based on the user's role in the active workspace. The role is returned in the `GET /workspaces` response for each workspace.

### Sidebar Visibility

| Sidebar Item | OWNER | ADMIN | MEMBER | GUEST |
|---|---|---|---|---|
| Dashboard | ✅ | ✅ | ✅ | ✅ |
| Issues | ✅ | ✅ | ✅ | ✅ (view only) |
| Projects | ✅ | ✅ | ✅ | Public only |
| Teams | ✅ | ✅ | ✅ | Public only |
| Departments | ✅ | ✅ | ✅ | Public only |
| Members | ✅ | ✅ | ✅ | ✅ (view only) |
| Settings | ✅ | ✅ | ❌ | ❌ |
| Billing | ✅ | ✅ | ❌ | ❌ |
| API Keys | ✅ | ✅ | ❌ | ❌ |
| Templates | ✅ | ✅ | ❌ | ❌ |

### Action Buttons

| Action | OWNER | ADMIN | MEMBER | GUEST |
|---|---|---|---|---|
| Create issue | ✅ | ✅ | ✅ | ❌ |
| Create project | ✅ | ✅ | ✅ | ❌ |
| Create team | ✅ | ✅ | ✅ | ❌ |
| Invite member | ✅ | ✅ | ❌ | ❌ |
| Delete workspace | ✅ | ❌ | ❌ | ❌ |

The backend enforces these rules regardless — UI hiding is for UX, not security.

---

## 8. Workspace Data in the App Header / Sidebar

The active workspace's name and logo should be visible in the sidebar header. This data comes from the workspace object stored when the user selected it (from `GET /workspaces`). No extra API call needed.

If the workspace has no logo, show the first letter of the workspace name in a coloured circle (use a hash of the workspace ID to pick a consistent colour).

---

## 9. Edge Cases the Frontend Must Handle

| Scenario | How to Detect | What to Do |
|---|---|---|
| User has no workspaces | `GET /workspaces` returns empty `[]` | Redirect to onboarding |
| Active workspace was deleted | API calls return `403 NOT_WORKSPACE_MEMBER` | Clear stored workspace ID, call `GET /workspaces`, pick another or redirect to onboarding |
| User was removed from workspace | Same as above — `403 NOT_WORKSPACE_MEMBER` | Same as above |
| Slug taken during onboarding | `POST /workspaces` returns `409 WORKSPACE_SLUG_TAKEN` | Show inline error on slug field |
| Inviting someone already a member | `POST .../invitations` returns `409 MEMBER_ALREADY_EXISTS` | Show: "This user is already a member." |
| Trying to demote owner | `PATCH .../members/:userId` returns `403 CANNOT_DEMOTE_OWNER` | Should not happen if UI hides the option correctly |
| Trying to remove owner | `DELETE .../members/:userId` returns `403 CANNOT_REMOVE_OWNER` | Should not happen if UI hides the option correctly |

### Global 403 Handler

Add a global API response interceptor. If any request returns `403 NOT_WORKSPACE_MEMBER`, the user was removed from the workspace. Clear the active workspace, refetch workspace list, and redirect.

---

## 10. Invitation System

### Architecture

Invitations are SEPARATE from memberships. An invitation is a pending offer — it becomes a membership only when the invitee accepts. This distinction matters for audit trails, revocation, and future features (SSO, domain auto-join).

### Security Model

- **Tokens are hashed** — the database stores a SHA-256 hash. The raw token only exists in the email link. If the DB leaks, attackers cannot reconstruct valid tokens.
- **Email-bound acceptance** — the authenticated user's email MUST match the invitation email. This prevents: Jane gets invite → forwards link to Mike → Mike signs up and joins. Mike would get `403 EMAIL_MISMATCH`.
- **Token in body, not URL** — the accept endpoint receives the token in the request body, not as a URL parameter. Tokens in URLs leak into browser history, proxy logs, and analytics.
- **Rate limited resolve** — the public resolve endpoint is rate limited to prevent brute-force token guessing.

### Invitation Flow (Frontend Perspective)

**Step 1: Admin sends invitation**

Admin opens the members page, clicks "Invite", fills in email, role, team, and optionally department. Frontend calls `POST /workspaces/:id/invitations` with `{ email, role, teamId, departmentId }`. Backend sends an email with an invite link.

**Step 2: Invitee receives email**

Email contains a link: `https://app.linearis.app/invite?token=<raw-token>`

The email shows: "**John Doe** invited you to join **Acme Corp** as a **Member**."

**Step 3: Frontend /invite page**

When invitee clicks the link, the frontend `/invite` page:
1. Reads `token` from the URL query string
2. Calls `GET /invitations/resolve?t=<token>` (public, no auth needed)
3. Receives: `{ workspaceName, workspaceLogo, role, teamName, departmentName, invitedEmail }`
4. Displays the invitation context, for example:
   - "You've been invited to **Acme Corp**"
   - "Role: **Member**"
   - "Team: **Engineering**"
   - "Department: **Product**" (only if a department was assigned)
5. Shows "Accept Invitation" button

**Step 4: Auth check before accept**

Before the user can accept, they must be authenticated:
- If signed in → proceed to accept
- If not signed in → redirect to sign-in/sign-up, preserving the token in a query param or localStorage so the user returns to the invite page after auth

**Step 5: Accept**

Frontend calls `POST /invitations/accept` with `{ token }` (the raw token from the URL). Backend does all of this in a single transaction:

1. Hashes the token and looks up the invitation
2. Verifies `authenticated_user.email === invitation.email`
3. Creates **WorkspaceMembership** (with the invited role)
4. Creates **TeamMembership** (assigns to the invited team)
5. Creates **DepartmentMembership** (if a department was specified in the invitation)
6. Marks invitation as ACCEPTED
7. Returns workspace details: `{ workspaceId, workspaceName, workspaceSlug, role, alreadyAccepted }`

The invitee is immediately a full member of the workspace, team, and department — no further setup needed.

Frontend then sets this workspace as active and redirects to the dashboard.

### Invitation Error Handling

| Error Code | HTTP | When | Frontend Action |
|---|---|---|---|
| `NOT_FOUND` | 404 | Invalid or revoked token | Show: "This invitation is no longer valid" |
| `CONFLICT` | 400 | Already accepted or expired | Show: "This invitation has already been used" or "This invitation has expired" |
| `FORBIDDEN` | 403 | User's email doesn't match invitation | Show: "This invitation was sent to a different email. Please sign in with [invited email]" |
| `MEMBER_ALREADY_EXISTS` | 409 | User already in workspace | Show: "You're already a member of this workspace" |

### Resending Invitations

If an admin resends an invitation to the same email, the backend:
1. Revokes the existing pending invitation (status → REVOKED)
2. Creates a new invitation with a fresh token and expiry
3. Sends a new email

This prevents "immortal invites" where repeatedly resending extends the expiry forever. Each resend creates a clean audit record.

### Revoking Invitations

Admins can cancel pending invitations via `DELETE /workspaces/:id/invitations/:invitationId`. The invitation is marked as REVOKED and can no longer be accepted. The link in the email stops working.

### Listing Invitations

Admins can view all invitations (pending, accepted, expired, revoked) via `GET /workspaces/:id/invitations`. Each invitation includes the assigned team name and department name (if any). The members page should show a "Pending Invitations" section below the member list.

---

## 11. API Reference Summary

### Key Request/Response Payloads

**`POST /workspaces` (create workspace) — request:**
```
{ name, slug, teamSize? }
```
**Response includes:**
```
{ id, name, slug, logo, teamSize, role: "OWNER", defaultTeamId, createdAt }
```
`defaultTeamId` — the auto-created team (same name as workspace). Store this for the invite form's team dropdown.

**`POST /workspaces/:id/invitations` (send invite) — request:**
```
{ email, role, teamId, departmentId? }
```
`teamId` is required — every invitee must be assigned to a team. `departmentId` is optional.

**`GET /invitations/resolve?t=<token>` (resolve invite) — response:**
```
{ workspaceId, workspaceName, workspaceSlug, workspaceLogo, role, teamName, departmentName, invitedEmail }
```
Frontend uses `teamName` and `departmentName` to show: "You'll join the **Engineering** team."

**`POST /invitations/accept` (accept invite) — request:**
```
{ token }
```
Creates WorkspaceMembership + TeamMembership + DepartmentMembership (if applicable) in one transaction.

### No Workspace Context Needed

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/workspaces` | Create workspace + default team (onboarding) |
| `GET` | `/workspaces` | List user's workspaces (determines onboarding vs dashboard) |
| `GET` | `/workspaces/check-slug/:slug` | Check slug availability (onboarding form) |
| `GET` | `/invitations/resolve?t=<token>` | Validate invite token (public, no auth) |
| `POST` | `/invitations/accept` | Accept invite — creates workspace + team + dept memberships |

### Workspace Context from URL Param

| Method | Path | Purpose | Role Required |
|--------|------|---------|---------------|
| `GET` | `/workspaces/:workspaceId` | Get workspace details | Any member |
| `PATCH` | `/workspaces/:workspaceId` | Update workspace | ADMIN, OWNER |
| `DELETE` | `/workspaces/:workspaceId` | Delete workspace | OWNER |
| `GET` | `/workspaces/:workspaceId/members` | List members | Any member |
| `PATCH` | `/workspaces/:workspaceId/members/:userId` | Change role | ADMIN, OWNER |
| `DELETE` | `/workspaces/:workspaceId/members/:userId` | Remove member | ADMIN, OWNER |
| `POST` | `/workspaces/:workspaceId/invitations` | Send invitation (with team + dept) | ADMIN, OWNER |
| `GET` | `/workspaces/:workspaceId/invitations` | List invitations (with team/dept names) | ADMIN, OWNER |
| `DELETE` | `/workspaces/:workspaceId/invitations/:id` | Revoke invitation | ADMIN, OWNER |

### Standard Response Format

All responses follow this shape:

**Success:** `{ "success": true, "data": { ... } }`

**Error:** `{ "success": false, "error": { "code": "ERROR_CODE", "message": "..." } }`

**Validation Error:** `{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [{ "field": "slug", "message": "...", "location": "body" }] } }`

---

## 12. Decisions & Rationale

| Decision | Why |
|---|---|
| Slug cannot be changed after creation | Changing slugs would break bookmarks, shared links, and any external references to `<slug>.linearis.app`. Linear doesn't allow it either. |
| Team size is optional | Not every user wants to answer this during onboarding. It's useful for analytics and plan recommendations but shouldn't block workspace creation. |
| `GET /workspaces` returns role per workspace | Avoids an extra API call. Frontend knows the role immediately and can render UI accordingly. |
| Invitations are separate from memberships | An invite is not membership. Separation allows revocation, audit trails, and future features (SSO auto-join, domain claims) without refactoring. |
| Tokens hashed in DB (SHA-256) | Same pattern as password reset tokens. DB leak doesn't compromise active invitations. |
| Email-bound acceptance | Token alone isn't enough. Prevents forwarded-invite abuse where someone else uses your invite link. |
| Token in body, not URL for accept | URLs leak into browser history, proxy logs, referer headers, and analytics. Body is safer. |
| Revoke + recreate on resend | No immortal invites. Each resend creates a clean audit record with a fresh token and expiry. |
| OWNER cannot be demoted or removed | Prevents lockout. There's always someone who can manage the workspace. Ownership transfer is a future feature. |
| 403 on workspace access after removal | Tells the frontend "your stored workspace ID is stale" — trigger a refetch of the workspace list. |
| Default team auto-created with workspace | Issues, projects, and cycles all belong to a team. Without at least one team, the workspace is unusable. Auto-creating avoids a separate "create your first team" step in onboarding. |
| Invitation requires team assignment | Every member needs to be on at least one team to do any work. Assigning during invite avoids a "you have no team" limbo state after joining. |
| Department is optional on invite | Not every workspace uses departments. Smaller teams may only use teams. Department assignment can happen later. |
| All memberships created in one transaction on accept | Workspace + Team + Department memberships are created atomically. If any fails, the invitee doesn't end up in a partial state (e.g., workspace member but no team). |
| Invite works for non-existing users | Invitee doesn't need an account yet. They sign up via Clerk first, then accept the invite. The invitation waits for them. |
