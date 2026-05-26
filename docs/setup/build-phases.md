# Linearis — Backend Build Phases

## Overview

This document defines the phased delivery plan for the Linearis backend. Each phase is a **vertical slice** — it includes DB models, API routes, service logic, middleware, and tests. No phase is started until the previous one is fully working.

**Architecture:** Modular monolith (Express + Prisma + PostgreSQL + Clerk)

**Every phase delivers:**
- DB — Prisma models + migration
- API — Express routes
- Service — Business logic layer
- Middleware — Auth/guards/validation
- Contract — Request/response types (Zod schemas) the frontend can code against

**Mental Model:**

```
Phase 0  → Stability       (nothing breaks)
Phase 1  → Identity        (who is calling)
Phase 2  → Boundary        (which workspace)
Phase 3  → Structure       (teams & departments)
Phase 4  → Work Container  (projects)
Phase 5  → Work Unit       (issues — the core product)
Phase 6  → Collaboration   (comments & threads)
Phase 7  → Power Features  (labels, relations, subtasks)
Phase 8  → Activity        (audit timeline across issues/projects/teams)
Phase 9  → Notifications   (inbox, unread counts, delivery channels)
Phase 10 → Realtime        (Socket.IO live updates)
Phase 11 → Business        (cycles, templates, billing, integrations)
Phase 12 → Intelligence    (MCP server, AI assistant — future scope)
```

---

## Phase 0 — Foundation

**Goal:** Make the backend stable before any feature code exists.

**Rule:** Zero feature code in this phase. Only infrastructure.

### 0.1 Architecture — Modular Monolith + Clean Layering

**Pattern:** Feature-based modules (vertical slices) with clean internal layering per module.

**Flow (enforced everywhere):**
```
Route → Middleware chain → Controller → Service → DB (Prisma)
```

**Rules:**
- Controllers are dumb — parse request, call service, send response
- Services contain ALL business logic — receive typed params, return data or throw `AppError`
- Services talk to Prisma directly (no repository layer unless query complexity warrants it)
- Zod schemas are the single source of truth for validation + TypeScript types (no DTOs)
- Prisma generated types ARE your models (no wrapper domain models)
- `infra/` added only when needed (Phase 8+ for Redis, queues, email)

### 0.2 Project Structure

```
app/
├── server.ts                  # Entry point — starts HTTP server
├── app.ts                     # Express app setup (global middleware stack)
├── generated/prisma/          # Prisma client (auto-generated, gitignored)

config/
├── env.ts                     # Typed env var loader (dotenv + Zod validation)
├── cors.ts                    # CORS configuration
└── clerk.ts                   # Clerk SDK configuration

modules/                       # Feature modules — one per domain entity
├── auth/
│   ├── auth.routes.ts         # Route definitions + per-route middleware chain
│   ├── auth.controller.ts     # Request handler (parse → delegate → respond)
│   ├── auth.service.ts        # Business logic (user sync, lookup)
│   ├── auth.schemas.ts        # Zod schemas (validation + types)
│   └── webhook.handler.ts     # Clerk webhook signature verify + dispatch
├── workspace/
│   ├── workspace.routes.ts
│   ├── workspace.controller.ts
│   ├── workspace.service.ts
│   ├── workspace.schemas.ts
│   └── membership.service.ts  # Sub-service when module has multiple concerns
├── issue/
│   ├── issue.routes.ts
│   ├── issue.controller.ts
│   ├── issue.service.ts
│   ├── issue.schemas.ts
│   ├── issue.repository.ts   # ONLY if queries become complex/reusable
│   └── subtask.service.ts
├── department/
├── team/
├── project/
├── comment/
├── label/
├── cycle/
├── notification/
├── activity/
├── template/
├── integration/
├── api-key/
└── billing/

shared/
├── middleware/
│   ├── authenticate.ts        # Verify Clerk JWT, attach req.user
│   ├── require-workspace.ts   # Resolve workspaceId, verify membership, attach req.workspace
│   ├── require-role.ts        # Role-based permission guard factory
│   ├── require-ownership.ts   # Check if user owns the resource
│   ├── validate.ts            # Zod schema validation (body/params/query)
│   ├── rate-limiter.ts        # Rate limiting (express-rate-limit)
│   ├── request-logger.ts      # Request logging (Morgan or custom)
│   ├── not-found.ts           # 404 handler for unmatched routes
│   └── error-handler.ts       # Global error catcher → standard response
├── utils/
│   ├── prisma.ts              # Prisma client singleton
│   ├── api-response.ts        # Standardized { success, data, error } helper
│   ├── api-error.ts           # Custom AppError class with status codes
│   └── activity.ts            # Activity log helper (used across modules)
├── types/
│   └── express.d.ts           # Extended Request type (user, workspace context)
└── errors/
    └── error-codes.ts         # Centralized error code constants

infra/                          # Added in Phase 8+ when needed
├── redis/                     # Cache + pub/sub
├── queue/                     # Background job queue (BullMQ)
├── email/                     # Email sending (SMTP/Resend)
└── storage/                   # File uploads (S3/R2)

socket/                         # Socket.IO handlers (Phase 10)
├── index.ts                   # Server setup
├── auth.ts                    # Socket auth middleware
├── rooms.ts                   # Room join/leave
└── events.ts                  # Event emitter integration

tests/                          # Test files mirror module structure
├── auth/
├── workspace/
├── issue/
└── helpers/                   # Test utilities, fixtures, factories

prisma/
├── schema.prisma
└── migrations/

docs/
├── product/
└── setup/
```

### 0.3 Middleware Architecture

#### Global Middlewares (applied to ALL routes in `app.ts`, order matters)

```
app.ts middleware stack:
1. helmet()                    — security headers (XSS, clickjacking, MIME sniffing)
2. cors(corsConfig)            — CORS policy (allow frontend origin)
3. express.json()              — parse JSON request bodies
4. rateLimiter                 — global rate limit (100 req/min per IP)
5. requestLogger              — log method, path, status, duration
6. --- route mounting ---      — modules register their routes here
7. notFoundHandler             — 404 for unmatched routes (standard format)
8. errorHandler                — catches all thrown/next(err) errors (standard format)
```

#### Route-Level Middlewares (per-route or per-module)

| Middleware | Purpose | Signature |
|---|---|---|
| `authenticate` | Verify Clerk JWT, look up User in DB, attach `req.user = { id, email, name }` | Returns 401 if invalid |
| `requireWorkspace` | Read `workspaceId` from header/param, verify membership, attach `req.workspace = { id, role }` | Returns 403 if not a member |
| `requireRole(...roles)` | Check `req.workspace.role` against allowed roles | Returns 403 if insufficient |
| `requireOwnership(getter)` | Check if authenticated user owns the resource (e.g., comment author) | Returns 403 if not owner |
| `validate(schema)` | Validate `req.body`, `req.params`, `req.query` against Zod schema | Returns 422 with field errors |

#### Middleware Composition per Route (examples)

```typescript
// Admin-only: invite a member
router.post(
  "/:workspaceId/members/invite",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  validate(inviteMemberSchema),
  controller.inviteMember
);

// Any member: create an issue
router.post(
  "/",
  authenticate,
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  validate(createIssueSchema),
  controller.create
);

// Author or admin: delete a comment
router.delete(
  "/:id",
  authenticate,
  requireWorkspace,
  requireOwnership(getCommentAuthor),  // checks author first
  controller.delete                     // OR falls through if admin
);

// Webhook: no auth middleware (verified by signature internally)
router.post("/webhooks/clerk", webhookHandler.handle);
```

### 0.4 Environment Config

Typed env validation using Zod:

```typescript
// config/env.ts
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  CLERK_PUBLISHABLE_KEY: z.string().startsWith("pk_"),
  CLERK_SECRET_KEY: z.string().startsWith("sk_"),
  CLERK_WEBHOOK_SECRET: z.string(),
  PORT: z.coerce.number().default(8000),
  NODE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
});
```

Fail-fast: server refuses to start if env is invalid.

### 0.5 Error Handling

Standardized API response format:

```typescript
// Success
{ "success": true, "data": { ... } }

// Error
{ "success": false, "error": { "code": "NOT_FOUND", "message": "Issue not found" } }

// Validation Error
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Invalid input", "details": [...] } }
```

Custom `AppError` class:

```typescript
class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) { super(message); }
}
```

### 0.6 Database Connection

- Prisma client singleton in `shared/utils/prisma.ts`
- Connection verified on server start (before listening)
- Graceful shutdown: `prisma.$disconnect()` on `SIGTERM`/`SIGINT`

### 0.7 Health Check

```
GET /health
→ { "success": true, "data": { "status": "ok", "db": "connected", "uptime": 1234 } }
```

Checks actual DB connectivity (runs `SELECT 1`), not just "server is up".

### 0.8 Dev Tooling

| Tool        | Purpose                    | Config              |
|-------------|----------------------------|---------------------|
| `tsx watch` | Dev server with hot reload | `npm run dev`       |
| `tsc`       | Type checking / build      | `npm run build`     |
| ESLint      | Linting                    | `eslint.config.js`  |
| Prettier    | Formatting                 | `.prettierrc`       |

### Done When

- [ ] `npm run dev` starts clean, no warnings
- [ ] `GET /health` returns `200` with `db: "connected"`
- [ ] Invalid env vars crash the server immediately with a clear message
- [ ] Hitting an unknown route returns `404` in standard format
- [ ] Throwing an error in any route returns `500` in standard format
- [ ] Prisma client generates successfully
- [ ] First migration runs (`prisma migrate dev --name init`)

---

## Phase 1 — Authentication (Clerk Integration)

**Goal:** Backend knows *who* is calling. Every request after this phase has a verified identity.

**Critical Rule:** Backend NEVER trusts a `userId` from the frontend. Only the Clerk JWT is trusted.

### 1.1 Clerk Webhook System

**Endpoint:** `POST /webhooks/clerk`

Clerk sends events when users sign up, update their profile, or delete their account. We use these to keep our `User` table in sync.

| Clerk Event     | Our Action                                       |
|-----------------|--------------------------------------------------|
| `user.created`  | Insert `User` row (id = Clerk user_id)           |
| `user.updated`  | Update `name`, `email`, `avatar` from payload    |
| `user.deleted`  | Delete `User` row (cascades memberships)          |

**Security:**
- Verify webhook signature using `CLERK_WEBHOOK_SECRET` (use `svix` library)
- Reject unsigned or replayed requests
- This endpoint is NOT behind auth middleware (Clerk calls it, not a user)

**Idempotency:**
- `user.created` with existing id → upsert (don't fail)
- `user.deleted` with missing id → no-op (don't fail)

### 1.2 User Table

Prisma model (from [database-setup.md](./database-setup.md)):

```prisma
model User {
  id           String    @id     // Clerk user_id
  email        String    @unique
  name         String
  avatar       String?
  lastActiveAt DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
}
```

### 1.3 Auth Middleware

```typescript
// shared/middleware/auth.ts
// Uses @clerk/express to verify session JWT
// Extracts userId from verified token
// Attaches to req.user = { id: clerkUserId }
// Returns 401 if no valid session
```

**Flow:**
```
Request → Clerk JWT in cookie/header
       → @clerk/express verifies signature + expiry
       → Extract userId from claims
       → Look up User in DB (ensure webhook has synced)
       → Attach to req.user
       → next()
```

**Edge case:** If Clerk JWT is valid but User doesn't exist in our DB yet (webhook race condition), return `403` with `"User not synced. Try again."` — the webhook will arrive shortly.

### 1.4 Routes

```
POST /webhooks/clerk          — Clerk webhook receiver (unprotected)
GET  /me                      — Returns authenticated user's profile from DB (protected)
```

### 1.5 Module Structure

```
modules/auth/
├── auth.routes.ts            # Route definitions
├── auth.controller.ts        # Request handlers
├── auth.service.ts           # Business logic (user sync, lookup)
├── auth.schemas.ts           # Zod schemas for webhook payloads
└── webhook.handler.ts        # Clerk webhook signature verification + dispatch
```

### Done When

- [ ] Signing up in Clerk creates a `User` row in DB automatically
- [ ] Updating profile in Clerk updates the `User` row
- [ ] Deleting account in Clerk removes the `User` row
- [ ] `GET /me` returns `401` without a valid session
- [ ] `GET /me` returns user profile with a valid session
- [ ] Webhook signature verification rejects tampered requests
- [ ] Auth middleware blocks all protected routes without valid JWT

---

## Phase 2 — Workspace (Multi-Tenancy Core)

**Goal:** Define the ownership boundary of the entire system. After this phase, every data query is scoped to a workspace.

**This is the most critical phase.** Get multi-tenancy wrong here and every future phase inherits the bug.

### 2.1 Models

```
Workspace              — top-level tenant
WorkspaceMembership    — links User ↔ Workspace with a role
```

### 2.2 Routes

```
POST   /workspaces                    — Create workspace (user becomes OWNER)
GET    /workspaces                    — List workspaces for authenticated user
GET    /workspaces/:workspaceId       — Get workspace details
PATCH  /workspaces/:workspaceId       — Update workspace (name, logo)
DELETE /workspaces/:workspaceId       — Delete workspace (OWNER only)
```

**Membership routes:**
```
POST   /workspaces/:workspaceId/members/invite   — Invite member (ADMIN+)
GET    /workspaces/:workspaceId/members           — List members
PATCH  /workspaces/:workspaceId/members/:userId   — Change role (ADMIN+)
DELETE /workspaces/:workspaceId/members/:userId   — Remove member (ADMIN+)
```

### 2.3 Workspace Context Middleware

Every request after auth must resolve:

```
User → Workspace → Role → Permissions
```

**Implementation:**
```typescript
// shared/middleware/workspace.ts
// Reads workspaceId from:
//   1. Route param (:workspaceId)
//   2. Header (X-Workspace-Id)
// Verifies user is a member of that workspace
// Attaches to req.workspace = { id, role }
```

### 2.4 Permission Guard

Reusable middleware factory:

```typescript
// Usage: requireRole("ADMIN", "OWNER")
// Checks req.workspace.role against allowed roles
// Returns 403 if insufficient
```

### 2.5 Business Rules

- Creating a workspace auto-creates a `WorkspaceMembership` with `role: OWNER`
- Workspace `slug` must be globally unique, validated with regex: `^[a-z0-9-]+$`
- OWNER cannot be removed or demoted
- Only 1 OWNER per workspace (transfer is a future feature)
- Deleting a workspace cascades everything (departments, teams, projects, issues)
- `issueCounter` starts at 0, incremented atomically per issue created

### 2.6 Module Structure

```
modules/workspace/
├── workspace.routes.ts
├── workspace.controller.ts
├── workspace.service.ts
├── workspace.schemas.ts       # Zod: createWorkspace, updateWorkspace, inviteMember
└── membership.service.ts      # Membership CRUD + role checks
```

### Done When

- [ ] User can create a workspace and becomes OWNER
- [ ] Workspace slug is validated and unique
- [ ] User can list their workspaces
- [ ] ADMIN can invite members
- [ ] ADMIN can change member roles
- [ ] OWNER cannot be demoted
- [ ] All routes require workspace context (no data leaks across tenants)
- [ ] Permission guard blocks unauthorized role actions
- [ ] Deleting workspace cascades all children

---

## Phase 3 — Teams & Departments (Structure Layer)

**Goal:** Organize workspace members into groups. Departments contain teams, teams own projects.

**Dependency:** Phase 2 (workspace + membership must work)

### 3.1 Models

```
Department              — organizational division
DepartmentMembership    — links User ↔ Department
Team                    — group of members that owns projects
TeamMembership          — links User ↔ Team
```

### 3.2 Department Routes

```
POST   /departments                   — Create department (ADMIN+)
GET    /departments                   — List departments in workspace
GET    /departments/:id               — Get department details + stats
PATCH  /departments/:id               — Update department (ADMIN+ or HEAD)
DELETE /departments/:id               — Delete department (ADMIN+)

POST   /departments/:id/members       — Add member
DELETE /departments/:id/members/:uid   — Remove member
GET    /departments/:id/members        — List members
```

### 3.3 Team Routes

```
POST   /teams                         — Create team (MEMBER+)
GET    /teams                          — List teams in workspace
GET    /teams/:id                      — Get team details
PATCH  /teams/:id                      — Update team (ADMIN+ or LEAD)
DELETE /teams/:id                      — Delete team (ADMIN+)

POST   /teams/:id/members             — Join/add member
DELETE /teams/:id/members/:uid         — Leave/remove member
GET    /teams/:id/members              — List members
```

### 3.4 Business Rules

- Department names are unique within a workspace
- Team names are unique within a workspace
- A team can optionally belong to a department
- Department HEAD can edit their own department's settings
- Team LEAD can edit their own team's settings
- Default department: new members auto-join if `isDefault = true`
- Visibility: `PRIVATE` departments/teams hidden from GUESTs

### 3.5 Module Structure

```
modules/department/
├── department.routes.ts
├── department.controller.ts
├── department.service.ts
├── department.schemas.ts
└── department-membership.service.ts

modules/team/
├── team.routes.ts
├── team.controller.ts
├── team.service.ts
├── team.schemas.ts
└── team-membership.service.ts
```

### Done When

- [ ] Departments can be created, updated, deleted within a workspace
- [ ] Teams can be created under a department (or standalone)
- [ ] Members can join/leave teams and departments
- [ ] Department HEAD can edit their department
- [ ] Team LEAD can edit their team
- [ ] Names are unique within workspace
- [ ] GUEST cannot see PRIVATE departments/teams
- [ ] Deleting a department sets `departmentId = null` on its teams (SetNull)

---

## Phase 4 — Projects (Work Container)

**Goal:** Projects group related issues under a team. This is the last entity before the core product (issues).

**Dependency:** Phase 3 (teams must exist to own projects)

Frontend/backend contract reference:

- [phase4-backend-contract.md](./phase4-backend-contract.md)
- [../features/projects-features/phase-4-frontend-project-ui-test-guide.md](../features/projects-features/phase-4-frontend-project-ui-test-guide.md)

### 4.1 Routes

```
POST   /projects                      — Create project (MEMBER+)
GET    /projects                      — List projects (filterable by team, status, visibility)
GET    /projects/:id                  — Get project details
PATCH  /projects/:id                  — Update project (ADMIN+ or LEAD)
DELETE /projects/:id                  — Delete/archive project (ADMIN+ or LEAD)
GET    /projects/:id/members          — Get project team members
```

### 4.2 Business Rules

- Project belongs to exactly one team and one workspace
- `departmentId` is derived from the team's department (denormalized for query performance)
- Project names are unique within a workspace
- Project LEAD can edit their project's settings
- Status transitions: `ACTIVE` → `ARCHIVED` / `COMPLETED`
- Archiving a project does NOT delete its issues
- Deleting a project cascades its issues (hard delete)
- Visibility: `PRIVATE` projects hidden from GUESTs

### 4.3 Filtering & Pagination

```
GET /projects?teamId=<teamId>&status=ACTIVE&visibility=PUBLIC&cursor=<projectId>&limit=20
```

### 4.4 Module Structure

```
modules/project/
├── project.routes.ts
├── project.controller.ts
├── project.service.ts
└── project.schemas.ts
```

### 4.5 Setup Guide (Backend Integration)

Implement Phase 4 in this exact order:

1. **Prisma model + migration**
   - Add `Project` model with `workspaceId`, `teamId`, `departmentId?`, `leadId?`, `name`, `slug`, `description?`, `status`, `visibility`, timestamps
   - Add unique constraints for workspace scope: `@@unique([workspaceId, name])`, `@@unique([workspaceId, slug])`
   - Add indexes used by list API: `[workspaceId, teamId]`, `[workspaceId, status]`
   - Run migration with descriptive name (example: `add-project-model-phase-4`)

2. **Schemas (`project.schemas.ts`)**
   - `createProjectSchema`, `updateProjectSchema`, `listProjectsSchema`, `projectIdParamsSchema`
   - Validate and normalize `slug` (`^[a-z0-9-]+$`)
   - List schema supports: `teamId?`, `status?`, `visibility?`, `cursor?`, `limit?`

3. **Service (`project.service.ts`)**
   - Enforce workspace scoping in every query (`where: { workspaceId: req.workspace.id, ... }`)
   - Validate `teamId` belongs to same workspace
   - Derive `departmentId` from selected team
   - Create/update/archive/delete logic in service only (no business logic in controller)
   - Implement cursor pagination contract for list endpoint

4. **Controller (`project.controller.ts`)**
   - Parse validated inputs and call service
   - Return standardized response shape (`success/data/error/meta`)

5. **Routes (`project.routes.ts`)**
   - Apply middleware chain on protected routes:
   - `authenticate → requireWorkspace → requireRole(...) → validate(...)`
   - Recommended permissions:
   - `POST /projects`: `MEMBER | LEAD | ADMIN | OWNER`
   - `GET /projects`, `GET /projects/:id`: `GUEST+` (with PRIVATE filtering)
   - `PATCH`, `DELETE`: `LEAD | ADMIN | OWNER`

6. **App wiring**
   - Register project routes in main router/app module
   - Ensure 404/error handlers remain global and last in chain

7. **Test coverage**
   - Create project under valid team in workspace
   - Reject cross-workspace team/project access
   - Enforce role rules for update/delete
   - Verify list filters and cursor pagination
   - Verify delete cascade behavior on issues

### 4.6 Frontend Integration Guide

Use this contract so frontend can integrate immediately after backend ships.

**Workspace context**
- Send workspace context on every project request:
- Prefer path-param routes when available; otherwise include `X-Workspace-Id` header
- Never send arbitrary `userId` for auth decisions; backend derives identity from session/JWT

**API contracts**
- Create:
```http
POST /projects
Content-Type: application/json
X-Workspace-Id: <workspaceId>
```
```json
{
  "name": "Platform Revamp",
  "slug": "platform-revamp",
  "teamId": "team_xxx",
  "description": "Q3 platform work",
  "visibility": "PUBLIC"
}
```

- List (cursor-based):
```http
GET /projects?teamId=<teamId>&status=ACTIVE&visibility=PUBLIC&cursor=<projectId>&limit=20
X-Workspace-Id: <workspaceId>
```

- Success response shape:
```json
{
  "success": true,
  "data": [
    {
      "id": "proj_xxx",
      "name": "Platform Revamp",
      "slug": "platform-revamp",
      "status": "ACTIVE",
      "visibility": "PUBLIC",
      "teamId": "team_xxx"
    }
  ],
  "meta": { "cursor": "proj_next", "hasMore": true, "total": 42 }
}
```

**Frontend state flow**
- Projects page loads with `GET /projects` using active workspace
- Filter changes (`team/status/visibility`) reset cursor and refetch
- Infinite scroll / load-more uses `meta.cursor` and `meta.hasMore`
- Project detail page calls `GET /projects/:id`
- Edit/archive actions call `PATCH /projects/:id`
- Delete action calls `DELETE /projects/:id` and removes item from UI list

**Frontend error handling**
- Handle standard error envelope:
```json
{ "success": false, "error": { "code": "FORBIDDEN", "message": "..." } }
```
- Expected codes for UI branches: `401`, `403`, `404`, `409`, `422`
- On `422`, map field-level validation issues to form errors

**Frontend done-when checklist**
- [ ] User can create project from UI and see it in list
- [ ] Team/status/visibility filters work
- [ ] Cursor pagination works without duplicates
- [ ] Unauthorized actions are hidden/disabled and server-denied if attempted
- [ ] PRIVATE projects are hidden for GUEST role
- [ ] Archive/delete actions update UI consistently

### Done When

- [ ] Projects can be created under a team
- [ ] Projects are workspace-scoped (no cross-tenant access)
- [ ] LEAD/ADMIN can update and archive projects
- [ ] Filtering by team and status works
- [ ] Cursor-based pagination works
- [ ] Project deletion cascades issues

---

## Phase 5 — Issues (Core Product Engine)

**Goal:** This is the product. Issues are the atomic work unit. Everything built before this was scaffolding for this phase.

**Dependency:** Phase 4 (projects must exist to contain issues)

Frontend/backend contract reference:

- [phase5-backend-contract.md](./phase5-backend-contract.md)

### 5.1 Routes

```
POST   /issues                        — Create issue
GET    /issues                        — List issues (rich filtering)
GET    /issues/:id                    — Get issue detail (with subtasks, labels)
PATCH  /issues/:id                    — Update issue fields
DELETE /issues/:id                    — Delete issue (ADMIN+)
PATCH  /issues/:id/status             — Quick status update (kanban drag)
```

### 5.2 Issue ID System

Human-readable IDs: `LIN-1`, `LIN-2`, ..., `LIN-101`

```typescript
// Atomic within $transaction:
// 1. Increment workspace.issueCounter
// 2. Create issue with id = `LIN-${counter}`
```

- IDs are never reused
- Unique within workspace: `@@unique([workspaceId, number])`

### 5.3 Issue Types

| Type   | Extra Fields                                          |
|--------|-------------------------------------------------------|
| `TASK` | Standard fields only                                  |
| `BUG`  | `stepsToReproduce`, `expectedBehavior`, `actualBehavior`, `severity` |
| `ISSUE`| `acceptanceCriteria`, `notes`                         |

Type-specific fields are nullable columns on the same table (no separate tables). Zod validation enforces required fields per type.

### 5.4 Filtering & Sorting

```
GET /issues?status=IN_PROGRESS&assignee=<userId>&project=<projectId>&priority=URGENT&type=BUG&sort=createdAt:desc&cursor=<id>&limit=25
```

Supported filters: `status`, `priority`, `type`, `assigneeId`, `projectId`, `teamId`, `cycleId`, `creatorId`

### 5.5 Subtasks

```
POST   /issues/:id/subtasks           — Add subtask
PATCH  /issues/:id/subtasks/:sid      — Update subtask (title, completed, order)
DELETE /issues/:id/subtasks/:sid      — Delete subtask
PATCH  /issues/:id/subtasks/reorder   — Bulk reorder (drag-and-drop)
```

### 5.6 Business Rules

- Issue always belongs to a project, team, and workspace
- `departmentId` derived from team (denormalized)
- `assigneeId` must be a workspace member
- Status flow: `BACKLOG → TODO → IN_PROGRESS → REVIEW → DONE` (not enforced as linear — any transition allowed)
- Subtask `order` field for drag-and-drop reordering
- Issue creation validates required fields per type using Zod discriminated unions

### 5.7 Module Structure

```
modules/issue/
├── issue.routes.ts
├── issue.controller.ts
├── issue.service.ts
├── issue.schemas.ts           # Discriminated union by type
└── subtask.service.ts
```

### Done When

- [ ] Issues created with atomic `LIN-N` ID generation
- [ ] All three issue types work with correct field validation
- [ ] Filtering by status, assignee, project, priority, type works
- [ ] Cursor-based pagination works
- [ ] Subtasks CRUD with reordering works
- [ ] Status updates work (for kanban drag)
- [ ] Workspace isolation: no cross-tenant issue access
- [ ] Assignee validated as workspace member

---

## Phase 6 — Comments (Collaboration)

**Goal:** Discussion layer on issues. Threaded replies for organized conversations.

**Dependency:** Phase 5 (issues must exist)

Detailed implementation contract: [phase6-backend-contract.md](./phase6-backend-contract.md)

### 6.1 Routes

```
POST   /issues/:id/comments           — Create comment (GUEST can comment)
GET    /issues/:id/comments            — List comments (threaded)
PATCH  /comments/:id                   — Edit comment (author only)
DELETE /comments/:id                   — Delete comment (author or ADMIN+)
```

### 6.2 Threading

- `parentId` creates reply chains
- API returns flat list — frontend builds the tree
- Deleting a parent cascades all replies

### 6.3 Business Rules

- GUESTs can comment (per permission matrix)
- Only the author can edit their comment
- ADMIN+ can delete any comment
- Comments are ordered by `createdAt` ascending

### 6.4 Module Structure

```
modules/comment/
├── comment.routes.ts
├── comment.controller.ts
├── comment.service.ts
└── comment.schemas.ts
```

### Done When

- [ ] Comments can be created on issues
- [ ] Threaded replies work (parentId)
- [ ] Author can edit their own comments
- [ ] ADMIN can delete any comment
- [ ] Deleting parent cascades replies
- [ ] GUESTs can comment

---

## Phase 7 — Labels & Issue Relations (Power Features)

**Goal:** Make the issue system powerful. Labels for categorization, relations for dependency tracking.

**Dependency:** Phase 5 (issues must exist)

Detailed labels contract: [phase7-labels-backend-contract.md](./phase7-labels-backend-contract.md)

### 7.1 Label Routes

```
POST   /labels                        — Create label (workspace-scoped)
GET    /labels                        — List labels in workspace
PATCH  /labels/:id                    — Update label (name, color)
DELETE /labels/:id                    — Delete label

POST   /issues/:id/labels             — Attach label(s) to issue
DELETE /issues/:id/labels/:labelId    — Remove label from issue
```

### 7.2 Issue Relation Routes

```
POST   /issues/:id/relations          — Create relation (blocks, related, duplicate)
DELETE /issues/:id/relations/:rid     — Remove relation
GET    /issues/:id/relations           — List relations for an issue
```

### 7.3 Business Rules

- Label names unique within workspace
- Labels have a `color` (hex string)
- An issue can have multiple labels (many-to-many via `IssueLabel`)
- Relation types: `RELATED`, `BLOCKS`, `BLOCKED_BY`, `DUPLICATE`
- Creating `BLOCKS` on A→B auto-creates `BLOCKED_BY` on B→A (or handle in query layer)
- Cannot relate an issue to itself

### 7.4 Module Structure

```
modules/label/
├── label.routes.ts
├── label.controller.ts
├── label.service.ts
└── label.schemas.ts

modules/issue/
└── issue-relation.service.ts     # Added to existing issue module
```

### Done When

- [ ] Labels CRUD works
- [ ] Labels can be attached/removed from issues
- [ ] Issue relations work (blocks, related, duplicate)
- [ ] No self-referential relations
- [ ] Label names unique within workspace

---

## Phase 8 — Activity Feed (UX Layer)

**Goal:** Users can see exactly what happened across issues, projects, teams, and workspace entities in a production-grade activity timeline.

**Dependency:** Phase 5+ (needs issues, comments, memberships)

Detailed frontend-ready contract: [phase8-backend-contract.md](./phase8-backend-contract.md)

### 8.1 Activity Routes

```
GET /activity                         — Workspace activity feed (paginated)
GET /activity?target=issue&targetId=<id>  — Activity for specific entity
GET /activity?target=project&targetId=<id> — Activity for specific project
GET /activity?target=team&targetId=<id>    — Activity for specific team
```

### 8.2 Activity Generation

Activities are created as **side effects** of other operations. Not a separate user action.

| Trigger                                | Activity Type            |
|----------------------------------------|--------------------------|
| Issue created (task/issue/bug)         | `ISSUE_CREATED`          |
| Issue status changed (e.g. Todo→Doing) | `ISSUE_STATUS_CHANGED`   |
| Issue priority changed                 | `ISSUE_PRIORITY_CHANGED` |
| Issue reassigned                       | `ISSUE_ASSIGNEE_CHANGED` |
| Issue moved project/team               | `ISSUE_SCOPE_CHANGED`    |
| Comment posted                         | `COMMENT_ADDED`          |
| Comment edited/deleted                 | `COMMENT_UPDATED/DELETED`|
| Label added/removed                    | `ISSUE_LABEL_UPDATED`    |
| Member added/removed in project        | `PROJECT_MEMBER_UPDATED` |
| Project created/updated/archived       | `PROJECT_UPDATED`        |
| Team membership/role changed           | `TEAM_MEMBER_UPDATED`    |
| User joined workspace                  | `MEMBER_JOINED`          |

**Implementation:** Service functions emit activities after the primary action succeeds. Use a helper:

```typescript
// shared/utils/activity.ts
async function logActivity(params: {
  workspaceId: string;
  actorId: string;
  type: ActivityType;
  targetId: string;
  targetType: ActivityTargetType;
  description: string;
  metadata?: Record<string, unknown>;
})
```

### 8.3 Feed UX Contract (Linear/Jira-style)

- Timeline entries must render actor avatar/name, event badge, human-readable message, and relative timestamp.
- Issue detail must show issue-scoped timeline (example: "Shaheer created issue LIN-4", "Shaheer moved Todo → In Progress", "John commented").
- Project detail must show project-scoped timeline with cross-issue activity in that project.
- Team pages must show team-scoped timeline for assignments, membership, and workflow changes.
- Workspace/global activity must aggregate all entities with filters (`actor`, `type`, `target`, `dateRange`).
- Every activity payload includes `actor`, `target`, `type`, `message`, `metadata`, `createdAt`.

### 8.4 Module Structure

```
modules/activity/
├── activity.routes.ts
├── activity.controller.ts
├── activity.service.ts
└── activity.schemas.ts
```

### Done When

- [ ] Activity log records issue/project/team/workspace actions automatically
- [ ] Activity feed API returns paginated results
- [ ] Activity can be filtered by entity and target (`issue|project|team|workspace`)
- [ ] Activity timeline UI contract supports avatar + actor + action badge + timestamp
- [ ] Status transition messages include both previous and next status
- [ ] Comment and label changes are represented as activities

---

## Phase 9 — Notifications (Inbox Layer)

**Goal:** Users get reliable, production-grade notifications separated from activity feed, delivered via API and websocket in this phase.

**Dependency:** Phase 8 complete (notifications are derived from activity-worthy events and mention/assignment logic).

### 9.1 Notification Routes

```
GET    /notifications                  — List notifications for user (paginated)
GET    /notifications/unread-count     — Unread badge count
PATCH  /notifications/:id/read        — Mark as read
PATCH  /notifications/read-all        — Mark all as read
```

### 9.2 Notification Generation

| Trigger               | Notification Type | Recipient          |
|------------------------|-------------------|--------------------|
| @mention in comment   | `MENTION`         | Mentioned user     |
| Issue assigned to user| `ASSIGNMENT`      | Assignee           |
| Issue status changed  | `UPDATE`          | Assignee + creator |
| Comment reply         | `COMMENT_REPLY`   | Parent author      |
| Project invite/add    | `PROJECT_MEMBER`  | Target member      |

### 9.3 Delivery and Read Model

- Source of truth is persisted DB notifications (`readAt`, `createdAt`, `type`, `target`).
- API polling support is mandatory.
- Websocket push for notifications is included in this phase.
- Must support idempotent generation (avoid duplicate notifications for same event key).
- Must support cursor pagination and unread counter performance at scale.

### 9.4 Module Structure

```
modules/notification/
├── notification.routes.ts
├── notification.controller.ts
├── notification.service.ts
└── notification.schemas.ts

socket/
└── notification.events.ts       # user:<id> realtime notification delivery
```

### Done When

- [ ] Notifications generated on mention, assignment, status, replies, and project member events
- [ ] Unread count endpoint works
- [ ] Mark as read / mark all as read works
- [ ] Notifications are deduplicated and pagination-safe
- [ ] Notification payloads include deep links to issue/project/team targets
- [ ] Notification websocket delivery works for connected clients (`user:<id>` room)

---

## Phase 10 — Realtime (Socket.IO)

**Goal:** Live updates across clients. When one user changes an issue, others see it instantly.

**Dependency:** Phase 8 and Phase 9 (activity and notifications already in place)

### 10.1 Architecture

```
Client ← Socket.IO → Server
                        ↓
              Event Bus (in-process)
                        ↑
              Service layer emits events
```

### 10.2 Events

| Event                    | Payload                     | Room               |
|--------------------------|-----------------------------|---------------------|
| `issue:created`          | Issue object                | `workspace:<id>`    |
| `issue:updated`          | Issue diff                  | `workspace:<id>`    |
| `issue:deleted`          | Issue ID                    | `workspace:<id>`    |
| `comment:created`        | Comment object              | `issue:<id>`        |

### 10.3 Authentication

Socket.IO connections authenticated using Clerk session token:

```typescript
io.use(async (socket, next) => {
  // Verify Clerk JWT from socket handshake auth
  // Attach userId to socket.data
});
```

### 10.4 Room Strategy

- `workspace:<workspaceId>` — all members of workspace (issue updates)
- `issue:<issueId>` — users viewing a specific issue (comments)
- `user:<userId>` — private channel (notifications)

Clients join workspace room on connect, issue rooms on navigation.

### 10.5 Module Structure

```
socket/
├── index.ts                  # Socket.IO server setup
├── auth.ts                   # Socket auth middleware
├── rooms.ts                  # Room join/leave handlers
└── events.ts                 # Event emitter integration
```

### Done When

- [ ] Socket.IO server starts alongside Express
- [ ] Connections authenticated via Clerk JWT
- [ ] Issue changes broadcast to workspace room
- [ ] New comments broadcast to issue room
- [ ] Notifications pushed to user room
- [ ] Disconnects handled gracefully

---

## Phase 11 — Advanced Features (Business Layer)

**Goal:** Features that make the product competitive. Only built after the core product is solid.

**Dependency:** All previous phases complete and stable.

### 11.1 Cycles (Sprints)

```
POST   /cycles                        — Create cycle
GET    /cycles                        — List cycles (filterable by status, team)
GET    /cycles/:id                    — Get cycle detail with issues
PATCH  /cycles/:id                    — Update cycle
DELETE /cycles/:id                    — Delete cycle

POST   /issues/:id/cycle              — Assign issue to cycle
DELETE /issues/:id/cycle              — Remove issue from cycle
```

**Business rules:**
- Cycles have `startDate` and `endDate`
- Status auto-transitions: `UPCOMING → CURRENT → COMPLETED` (background job checks dates)
- An issue can belong to one cycle at a time

### 11.2 Templates

```
POST   /templates                     — Create template (ADMIN+)
GET    /templates                     — List templates
GET    /templates/:id                 — Get template
PATCH  /templates/:id                 — Update template
DELETE /templates/:id                 — Delete template
POST   /templates/:id/apply           — Create issue from template
```

### 11.3 API Keys

```
POST   /api-keys                      — Generate new key (ADMIN+)
GET    /api-keys                      — List keys (masked)
DELETE /api-keys/:id                  — Revoke key
```

**Business rules:**
- Key format: `lin_live_*` (production), `lin_test_*` (development)
- Store only the hash — show full key once on creation, never again
- Track `lastUsedAt` on each API request
- API key auth as alternative to Clerk JWT (for external integrations)

### 11.4 Integrations

```
POST   /integrations/:provider/connect     — Connect integration
DELETE /integrations/:provider/disconnect   — Disconnect
GET    /integrations                        — List integration status
```

Providers: GitHub, Slack, Discord, Figma. Each has provider-specific OAuth + webhook config.

### 11.5 Billing (Stripe)

```
GET    /billing                       — Current plan + subscription status
POST   /billing/checkout              — Create Stripe checkout session
POST   /billing/portal                — Create Stripe billing portal link
POST   /webhooks/stripe               — Stripe webhook receiver
```

**Business rules:**
- Free plan by default on workspace creation
- Plan limits enforced at service layer (member count, project count, etc.)
- Stripe webhooks update `Subscription`, `Invoice`, `PaymentMethod` tables
- Downgrade blocks features but doesn't delete data

### Done When

- [ ] Cycles CRUD with auto-status transition works
- [ ] Templates can create pre-filled issues
- [ ] API keys can authenticate requests
- [ ] At least one integration (GitHub) connects end-to-end
- [ ] Stripe checkout + webhook flow works
- [ ] Plan limits enforced (free tier restrictions)

---

## Phase 12 — AI & MCP Server (Intelligence Layer) `FUTURE SCOPE`

**Goal:** Expose workspace data to AI agents via the Model Context Protocol (MCP), and provide an in-app AI assistant that can read, create, and manage issues through natural language.

**Dependency:** Phase 11 complete. The entire product must be stable — AI is a layer *on top* of working features, not a replacement for them.

**Plan tier:** Basic AI on Standard plan, full AI on Plus plan.

### 11.1 What is MCP

MCP (Model Context Protocol) is an open standard that lets AI models (Claude, GPT, etc.) call **tools** exposed by your server. Instead of the AI scraping your UI, it calls structured endpoints with typed parameters and gets structured responses.

Think of it as: **an API designed for AI agents, not humans.**

### 11.2 MCP Server Setup

The MCP server runs as a separate module alongside the Express API. It exposes workspace data as tools that any MCP-compatible AI client can call.

```
mcp/
├── index.ts                  # MCP server initialization
├── auth.ts                   # Authenticate MCP sessions (API key or Clerk token)
├── tools/
│   ├── issues.ts             # Issue tools (list, create, update, assign)
│   ├── projects.ts           # Project tools (status, list)
│   ├── cycles.ts             # Cycle tools (current sprint, progress)
│   ├── members.ts            # Member tools (lookup, workload)
│   └── search.ts             # Full-text search across workspace
└── resources/
    ├── issue.ts              # Issue as readable resource
    ├── project.ts            # Project as readable resource
    └── workspace.ts          # Workspace summary resource
```

### 11.3 MCP Tools

These are the actions an AI agent can perform:

| Tool                    | Description                                           | Parameters                                      |
|-------------------------|-------------------------------------------------------|--------------------------------------------------|
| `list_issues`           | Query issues with filters                             | `status`, `assignee`, `project`, `priority`, `limit` |
| `get_issue`             | Get full issue detail                                 | `issueId`                                        |
| `create_issue`          | Create a new issue                                    | `title`, `type`, `project`, `priority`, `assignee`, `description` |
| `update_issue`          | Modify issue fields                                   | `issueId`, `fields` (partial update)             |
| `assign_issue`          | Assign issue to a user                                | `issueId`, `userId`                              |
| `change_issue_status`   | Move issue through workflow                           | `issueId`, `status`                              |
| `add_comment`           | Post a comment on an issue                            | `issueId`, `body`                                |
| `list_projects`         | List projects with status                             | `teamId?`, `status?`                             |
| `get_project_status`    | Project summary (progress, open issues, blockers)     | `projectId`                                      |
| `get_current_cycle`     | Current sprint with progress                          | `teamId?`                                        |
| `search`                | Full-text search across issues, projects, comments    | `query`, `scope?`                                |
| `get_my_issues`         | Issues assigned to the authenticated user             | `status?`                                        |
| `get_team_workload`     | Issue distribution across team members                | `teamId`                                         |

### 11.4 MCP Resources (Read-Only Context)

Resources are data the AI can read to understand the workspace context before taking action:

| Resource                | URI Pattern                  | Content                                   |
|-------------------------|------------------------------|-------------------------------------------|
| Workspace overview      | `linearis://workspace`       | Name, member count, active projects, stats|
| Issue detail            | `linearis://issues/{id}`     | Full issue with subtasks, comments, labels|
| Project summary         | `linearis://projects/{id}`   | Status, progress, recent activity         |
| Current sprint          | `linearis://cycles/current`  | Active cycle, issue breakdown by status   |

### 11.5 Authentication for MCP

MCP sessions authenticate via:

1. **API Key** — for external AI agents (Claude Desktop, custom agents). Uses the same `lin_live_*` keys from Phase 11.3.
2. **Clerk session** — for the in-app AI assistant (user's own permissions apply).

All MCP tool calls are **workspace-scoped** and **permission-checked** — an AI agent cannot do anything the authenticated user can't do themselves.

### 11.6 In-App AI Assistant

A guided chatbot in the Linearis UI that uses the MCP tools internally:

**Capabilities:**
- Natural language issue management: *"Create a high-priority bug for the login page crash"*
- Query by context: *"Show me all urgent issues assigned to Sarah"*
- Quick actions: *"Move LIN-105 to In Progress"*
- Sprint planning: *"What's left in the current cycle?"*
- Workload balancing: *"Who on the backend team has the fewest open issues?"*

**Architecture:**
```
User message → Backend AI endpoint → Claude API (with MCP tools) → Tool calls → DB → Response
```

The backend acts as a **proxy** — it sends the user's message to Claude along with the MCP tool definitions. Claude decides which tools to call, the backend executes them against the DB, and returns the results.

### 11.7 AI-Powered Suggestions (Plus Plan)

Passive AI features that run in the background:

| Feature                  | Trigger                        | Output                              |
|--------------------------|--------------------------------|--------------------------------------|
| Auto-assign              | Issue created without assignee | Suggest assignee based on expertise  |
| Duplicate detection      | Issue created                  | Flag similar existing issues         |
| Smart labeling           | Issue created/updated          | Suggest labels from title/description|
| Sprint planning assist   | Cycle created                  | Suggest issues based on velocity     |

These use background jobs (queues/workers from Phase 8+) — not blocking the user's request.

### 11.8 Business Rules

- MCP server respects the same permission matrix as the REST API
- AI actions create real Activity entries (actor = user, not "AI")
- Rate limiting on AI endpoints (prevent abuse)
- AI features gated by plan: Basic on Standard, Full on Plus
- All AI responses include a disclaimer that they're AI-generated
- MCP tool calls are logged in the Activity feed for audit

### Done When

- [ ] MCP server starts and exposes tools to compatible clients
- [ ] Claude Desktop can connect to Linearis MCP server and manage issues
- [ ] API key authentication works for MCP sessions
- [ ] All tools respect workspace scoping and permissions
- [ ] In-app AI assistant can create, query, and update issues via natural language
- [ ] Duplicate detection flags similar issues on creation
- [ ] AI actions appear in the activity feed
- [ ] Plan-based gating works (Standard vs Plus features)

---

## Rules for All Phases

### 1. Phase Gate Rule

```
Each phase MUST be fully working before starting the next.

DO NOT:
  - Build 50% of workspace and jump to issues
  - Skip auth edge cases
  - Leave broken tests behind
  - Ship without workspace isolation verified
```

### 2. Every Route Must Have

- Auth middleware (except webhooks)
- Workspace context middleware (for workspace-scoped routes)
- Role/permission guard where needed
- Zod request validation (params, query, body)
- Standardized error responses
- Pagination on list endpoints

### 3. Testing Baseline

Each phase includes:
- Service layer unit tests (business logic)
- Route integration tests (HTTP request → response)
- Permission tests (verify role guards work)
- Multi-tenancy test (verify workspace isolation — user A cannot access user B's data)

### 4. Module Convention

Every module follows the same structure:

```
modules/<name>/
├── <name>.routes.ts          # Route definitions + per-route middleware chain
├── <name>.controller.ts      # Request parsing → service call → response
├── <name>.service.ts         # Business logic (talks to Prisma directly)
├── <name>.schemas.ts         # Zod schemas (validation + inferred types)
└── <name>.repository.ts      # OPTIONAL — only when queries are complex/reusable
```

**Layer rules:**

| Layer | Responsibility | Can Access | Cannot Access |
|---|---|---|---|
| Routes | Define URL, attach middleware chain | Controller | Service, DB |
| Controller | Parse `req`, call service, send `res` | Service, Schemas | DB, other controllers |
| Service | Business logic, orchestration | Prisma (or Repository), other services | `req`, `res`, Express |
| Repository | Complex/reusable queries | Prisma | Business logic, `req`/`res` |
| Schemas | Validation + type inference | Zod | Nothing else |

**When to add a repository:**
- Query has complex joins, raw SQL, or aggregations
- Same query is reused across multiple services
- You need to cache query results

**When NOT to add a repository:**
- Simple CRUD (`prisma.issue.create(...)`)
- Query is only used in one place
- You're just wrapping Prisma with no added value
