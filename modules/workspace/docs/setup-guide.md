# Workspace Module — Setup Guide

> This guide covers everything needed before implementing the workspace module.
> Workspaces are the multi-tenancy boundary — every piece of data in Linearis belongs to exactly one workspace.

---

## 1. What is a Workspace

A workspace is the **top-level tenant** in Linearis. It's equivalent to an "Organization" in Linear or a "Team" in Slack.

- Every user can belong to **multiple workspaces** (personal, work, client projects)
- All data (issues, projects, teams, departments) is **scoped to a workspace**
- The workspace URL is globally unique: `<slug>.linearis.app`
- The user who creates a workspace automatically becomes the **OWNER**

---

## 2. Database Models Involved

### 2.1 Workspace

```prisma
model Workspace {
  id           String    @id @default(uuid())
  name         String                          // "Acme Corp"
  slug         String    @unique               // "acme" → acme.linearis.app
  logo         String?                         // URL to workspace logo
  teamSize     TeamSize?                       // Selected during onboarding
  issueCounter Int       @default(0)           // Atomic counter for issue IDs (LIN-N)
  createdById  String                          // FK → User who created it
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
}
```

### 2.2 WorkspaceMembership

```prisma
model WorkspaceMembership {
  id          String        @id @default(uuid())
  userId      String
  workspaceId String
  role        WorkspaceRole @default(MEMBER)   // OWNER, ADMIN, MEMBER, GUEST
  joinedAt    DateTime      @default(now())

  @@unique([userId, workspaceId])              // User can only be in a workspace once
}
```

### 2.3 TeamSize Enum

```prisma
enum TeamSize {
  SMALL       // 1-5 members
  MEDIUM      // 6-20 members
  LARGE       // 21-50 members
  ENTERPRISE  // 50+ members
}
```

### 2.4 WorkspaceRole Enum

```prisma
enum WorkspaceRole {
  OWNER       // Created the workspace. Full control. Cannot be demoted. Exactly 1 per workspace.
  ADMIN       // Full management access. Can manage billing, API keys, templates, integrations.
  MEMBER      // Standard team member. Can create/edit issues, join teams, view analytics.
  GUEST       // View-only with limited write access. Cannot see admin areas.
}
```

---

## 3. API Endpoints

### 3.1 Workspace CRUD

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| `POST` | `/workspaces` | ✅ | Any authenticated user | Create workspace (becomes OWNER) |
| `GET` | `/workspaces` | ✅ | Any authenticated user | List user's workspaces |
| `GET` | `/workspaces/:workspaceId` | ✅ | Any member | Get workspace details |
| `PATCH` | `/workspaces/:workspaceId` | ✅ | ADMIN, OWNER | Update workspace (name, logo) |
| `DELETE` | `/workspaces/:workspaceId` | ✅ | OWNER only | Delete workspace (cascades everything) |

### 3.2 Membership Management

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| `POST` | `/workspaces/:workspaceId/members/invite` | ✅ | ADMIN, OWNER | Invite member by email |
| `GET` | `/workspaces/:workspaceId/members` | ✅ | Any member | List workspace members |
| `PATCH` | `/workspaces/:workspaceId/members/:userId` | ✅ | ADMIN, OWNER | Change member role |
| `DELETE` | `/workspaces/:workspaceId/members/:userId` | ✅ | ADMIN, OWNER | Remove member |

### 3.3 Slug Availability Check

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| `GET` | `/workspaces/check-slug/:slug` | ✅ | Any authenticated user | Check if slug is available (real-time validation) |

---

## 4. Business Rules

### 4.1 Workspace Creation

- Authenticated user sends `POST /workspaces` with `{ name, slug, teamSize }`
- Backend creates `Workspace` + `WorkspaceMembership` (role: OWNER) in a **single transaction**
- If transaction fails, neither record is created (no orphaned workspaces)
- `issueCounter` starts at 0
- Every workspace gets a FREE subscription by default (created in Phase 10)

### 4.2 Slug Validation

| Rule | Regex / Check | Error |
|------|---------------|-------|
| Format | `^[a-z0-9][a-z0-9-]*[a-z0-9]$` | Only lowercase letters, numbers, hyphens. Cannot start/end with hyphen |
| Min length | 3 characters | Too short |
| Max length | 50 characters | Too long |
| Uniqueness | DB unique constraint on `slug` | Slug already taken |
| Reserved words | Block: `api`, `app`, `admin`, `www`, `mail`, `help`, `support`, `billing`, `status`, `docs` | Reserved slug |

Frontend should validate format client-side AND check availability via `GET /workspaces/check-slug/:slug` as the user types (debounced).

### 4.3 Role Hierarchy & Permissions

```
OWNER (highest — exactly 1 per workspace)
  └── ADMIN (unlimited — full management)
       └── MEMBER (unlimited — standard access)
            └── GUEST (unlimited — view-only)
```

| Action | OWNER | ADMIN | MEMBER | GUEST |
|--------|-------|-------|--------|-------|
| Edit workspace settings | ✅ | ✅ | ❌ | ❌ |
| Delete workspace | ✅ | ❌ | ❌ | ❌ |
| Invite members | ✅ | ✅ | ❌ | ❌ |
| Remove members | ✅ | ✅ | ❌ | ❌ |
| Change member roles | ✅ | ✅ | ❌ | ❌ |
| View workspace data | ✅ | ✅ | ✅ | ✅ (limited) |

### 4.4 Protection Rules

- OWNER **cannot be demoted** — they are always OWNER
- OWNER **cannot be removed** from their own workspace
- Only **1 OWNER** per workspace (ownership transfer is a future feature)
- ADMIN **cannot change another ADMIN's role** — only OWNER can
- Deleting a workspace **cascades everything**: departments, teams, projects, issues, comments, labels, cycles, notifications, activity logs

### 4.5 Returning User Logic

When a user signs in:

```
GET /workspaces → returns list of workspaces user belongs to

If empty  → frontend redirects to /onboarding (create workspace)
If 1+     → frontend sets first workspace as active, redirects to / (dashboard)
```

The backend does NOT handle navigation — it returns data. The frontend decides where to go.

---

## 5. Middleware: Workspace Context

After Phase 2, most routes need workspace context. Two new middlewares:

### 5.1 `requireWorkspace`

Reads the active workspace from the request and verifies the user is a member.

**Where the workspace ID comes from:**
1. Route parameter: `/workspaces/:workspaceId/members` → `req.params.workspaceId`
2. Header: `X-Workspace-Id` → for routes like `/issues`, `/projects` that don't have workspace in the URL

**What it does:**
```
Read workspaceId from param or header
  → Look up WorkspaceMembership for (userId, workspaceId)
  → If not found → 403 NOT_WORKSPACE_MEMBER
  → If found → attach req.workspace = { id, role }
  → next()
```

### 5.2 `requireRole(...roles)`

Checks if the user's role in the workspace is sufficient.

```typescript
// Usage in routes:
router.delete("/:workspaceId", authenticate, requireWorkspace, requireRole("OWNER"), controller.delete);
router.post("/:workspaceId/members/invite", authenticate, requireWorkspace, requireRole("ADMIN", "OWNER"), controller.invite);
```

---

## 6. Frontend Integration

### 6.1 Onboarding Form → API Call

```typescript
// POST /workspaces
const response = await apiCall("/workspaces", {
  method: "POST",
  body: JSON.stringify({
    name: "Acme Corp",         // from Organization name input
    slug: "acme",              // from Workspace URL input (without .linearis.app)
    teamSize: "SMALL",         // from team size selector (SMALL | MEDIUM | LARGE | ENTERPRISE)
  }),
});

// Response:
// {
//   success: true,
//   data: {
//     id: "uuid",
//     name: "Acme Corp",
//     slug: "acme",
//     teamSize: "SMALL",
//     role: "OWNER",
//     createdAt: "2026-05-17T..."
//   }
// }
```

### 6.2 Checking Slug Availability (Real-Time)

```typescript
// GET /workspaces/check-slug/acme
// Debounce this call (300ms) as user types in the slug input

const response = await apiCall(`/workspaces/check-slug/${slug}`);
// { success: true, data: { available: true } }
// { success: true, data: { available: false } }
```

### 6.3 Listing Workspaces (After Login)

```typescript
// GET /workspaces
const response = await apiCall("/workspaces");

if (response.data.length === 0) {
  // New user — no workspaces yet
  navigate("/onboarding");
} else {
  // Returning user — set active workspace and go to dashboard
  setActiveWorkspace(response.data[0]);
  navigate("/");
}
```

### 6.4 Setting Active Workspace

After selecting a workspace, the frontend stores the active workspace ID and sends it in every API call:

```typescript
// Store active workspace (localStorage or React context)
localStorage.setItem("activeWorkspaceId", workspace.id);

// Send with every API request
headers: {
  "Authorization": `Bearer ${token}`,
  "X-Workspace-Id": activeWorkspaceId,
}
```

### 6.5 Switching Workspaces

Users can belong to multiple workspaces. The sidebar shows a workspace switcher:

```typescript
// GET /workspaces → shows all workspaces in dropdown
// User clicks a different workspace → update activeWorkspaceId
// All subsequent API calls use the new X-Workspace-Id
// Frontend reloads dashboard data for the new workspace
```

---

## 7. Module File Structure

```
modules/workspace/
├── docs/
│   ├── setup-guide.md              ← THIS FILE
│   ├── workspace_integration.md    ← Written after implementation
│   └── api-reference.md            ← Written during implementation
├── workspace.routes.ts             ← Route definitions + middleware chains
├── workspace.controller.ts         ← Request handlers (create, list, getById, update, delete)
├── workspace.service.ts            ← Business logic (create with membership, slug check)
├── workspace.schemas.ts            ← Zod schemas (createWorkspace, updateWorkspace, slug validation)
└── membership.service.ts           ← Membership CRUD (invite, list, changeRole, remove)
```

---

## 8. Dependencies on Previous Phases

| Dependency | From | Status |
|------------|------|--------|
| User table with Clerk sync | Phase 1 (Auth) | ✅ Done |
| `authenticate` middleware | Phase 1 (Auth) | ✅ Done |
| `AppError` + error codes | Phase 0 (Foundation) | ✅ Done |
| `validate` middleware | Phase 0 (Foundation) | ✅ Done |
| Standard response helpers | Phase 0 (Foundation) | ✅ Done |

No new packages needed. No external service setup required.

---

## 9. Request Flow Diagram

### Creating a Workspace (Onboarding)

```
Frontend                                    Backend
────────                                    ───────

POST /workspaces                    →  [authenticate] verify JWT
{ name, slug, teamSize }                      │
                                         [validate] check Zod schema
                                              │
                                         [controller] parse request
                                              │
                                         [service] $transaction:
                                           1. Check slug uniqueness
                                           2. Check reserved slugs
                                           3. Create Workspace
                                           4. Create WorkspaceMembership (OWNER)
                                              │
                                    ←    201: { id, name, slug, role: "OWNER" }

Store workspace ID
Set X-Workspace-Id header
Navigate to /dashboard
```

### Subsequent API Calls

```
Frontend                                    Backend
────────                                    ───────

GET /issues                         →  [authenticate] verify JWT → req.user
Headers:                                      │
  Authorization: Bearer <token>          [requireWorkspace] read X-Workspace-Id
  X-Workspace-Id: <uuid>                   verify membership → req.workspace
                                              │
                                         [requireRole] check role (if needed)
                                              │
                                         [controller] → [service] → DB
                                           (all queries include workspaceId)
                                              │
                                    ←    200: { issues: [...] }
```

---

## 10. Pre-Implementation Checklist

Before writing workspace code, verify:

- [ ] Phase 1 (Auth) is fully working — `/me` returns user profile
- [ ] Webhook sync works — users exist in DB after Clerk sign-up
- [ ] Workspace and WorkspaceMembership models exist in schema (with `teamSize`)
- [ ] Migration applied successfully
- [ ] Prisma client regenerated
- [ ] Understand the slug validation rules (format, reserved words, uniqueness)
- [ ] Understand the role hierarchy (OWNER > ADMIN > MEMBER > GUEST)
- [ ] Understand the middleware chain: `authenticate → requireWorkspace → requireRole → validate → controller`
