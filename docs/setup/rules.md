# Trussen — Backend Rules (IMMUTABLE)

> These rules are NON-NEGOTIABLE. They must be followed in every file, every PR, every phase.
> No exceptions. No shortcuts. No "just this once".

---

## 1. Architecture Rules

### 1.1 Request Flow

```
Route → Middleware Chain → Controller → Service → DB (Prisma)
```

This flow is NEVER violated. No skipping layers.

- Controllers NEVER contain business logic
- Controllers NEVER talk to Prisma directly
- Services NEVER access `req` or `res`
- Services NEVER import Express types
- Routes NEVER call services directly (always go through controller)

### 1.2 Module Structure

Every module follows this structure without exception:

```
modules/<name>/
├── <name>.routes.ts
├── <name>.controller.ts
├── <name>.service.ts
├── <name>.schemas.ts
└── <name>.repository.ts      # ONLY if query complexity warrants it
```

- No extra files unless justified (e.g., `webhook.handler.ts` for auth)
- No `index.ts` barrel files — import directly from the file
- No circular imports between modules — if two modules need each other, extract shared logic into `shared/`

### 1.3 No Premature Abstraction

- NO repository layer unless the query is complex, reused, or requires raw SQL
- NO DTOs — Zod schemas are the single source of truth for types and validation
- NO domain model wrappers — Prisma generated types ARE your models
- NO base classes, abstract factories, or design pattern bloat
- NO utility functions until they're used in 3+ places

---

## 2. Multi-Tenancy Rules

### 2.1 Workspace Isolation

**Every single database query that touches workspace-scoped data MUST include a `workspaceId` filter.**

```typescript
// CORRECT
prisma.issue.findMany({ where: { workspaceId, status: "TODO" } });

// WRONG — leaks data across tenants
prisma.issue.findMany({ where: { status: "TODO" } });
```

No exceptions. Even in admin tools. Even in background jobs.

### 2.2 Never Trust Client IDs

- NEVER trust a `userId` from the request body or params for authorization
- ALWAYS use `req.user.id` (from verified Clerk JWT) as the authenticated identity
- NEVER trust a `workspaceId` without verifying the user is a member
- ALWAYS verify membership via `requireWorkspace` middleware

### 2.3 Permission Enforcement

- Permissions are checked in MIDDLEWARE, not in service logic
- Every protected route has the full chain: `authenticate → requireWorkspace → requireRole`
- If a route needs ownership check, use `requireOwnership` middleware
- NEVER skip permission checks "because only the frontend calls this"

---

## 3. API Response Rules

### 3.1 Standard Response Format

Every response from every endpoint follows this format:

```typescript
// Success (200, 201)
{ "success": true, "data": { ... } }

// Error (4xx, 5xx)
{ "success": false, "error": { "code": "ERROR_CODE", "message": "Human-readable message" } }

// Validation Error (422)
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Invalid input", "details": [...] } }

// List with pagination
{ "success": true, "data": [...], "meta": { "total": 100, "cursor": "abc123", "hasMore": true } }
```

No deviations. No custom shapes. Frontend depends on this contract.

### 3.2 HTTP Status Codes

| Code | When |
|------|------|
| 200 | Success (GET, PATCH, DELETE) |
| 201 | Resource created (POST) |
| 204 | No content (DELETE with no body) |
| 400 | Bad request (malformed input) |
| 401 | Unauthorized (no/invalid auth token) |
| 403 | Forbidden (valid auth but insufficient permissions) |
| 404 | Resource not found |
| 409 | Conflict (duplicate slug, unique constraint violation) |
| 422 | Validation error (Zod schema failed) |
| 429 | Rate limited |
| 500 | Internal server error (unhandled) |

### 3.3 Error Codes

Error codes are SCREAMING_SNAKE_CASE strings, never numbers:

```
UNAUTHORIZED, FORBIDDEN, NOT_FOUND, VALIDATION_ERROR,
CONFLICT, RATE_LIMITED, INTERNAL_ERROR, WORKSPACE_NOT_FOUND,
MEMBER_NOT_FOUND, ISSUE_NOT_FOUND, INVALID_ROLE, etc.
```

---

## 4. Authentication Rules

### 4.1 Clerk is the Only Auth Source

- NEVER implement custom JWT generation
- NEVER store passwords, tokens, or sessions in our database
- NEVER build custom OAuth flows — Clerk handles all providers
- The `User` table is a READ-ONLY sync of Clerk data (via webhooks)
- User creation/deletion only happens through Clerk webhooks

### 4.2 Auth Middleware is Mandatory

- Every route is protected by `authenticate` middleware EXCEPT:
  - `GET /health`
  - `POST /webhooks/clerk`
  - `POST /webhooks/stripe`
- Webhooks verify their own signatures internally (never exposed unverified)

### 4.3 Session Handling

- Backend is stateless — no server-side sessions
- Every request is independently verified via Clerk JWT
- Token expiry and refresh are handled by Clerk SDK — we never manage this

---

## 5. Database Rules

### 5.1 Schema Changes

- EVERY schema change goes through Prisma Migrate — never raw SQL ALTER statements
- EVERY migration has a descriptive kebab-case name
- NEVER modify or delete an existing migration file
- NEVER use `prisma db push` in production — always `prisma migrate deploy`

### 5.2 Query Safety

- NEVER use raw SQL unless absolutely necessary (and document why)
- ALWAYS use parameterized queries (Prisma does this by default)
- NEVER build query strings with string concatenation
- ALWAYS handle `null` and `undefined` explicitly — no trusting optional fields

### 5.3 Transactions

Use `prisma.$transaction()` when:
- Creating related records that must succeed or fail together
- Incrementing counters (e.g., `issueCounter`)
- Any operation that reads then writes based on the read value

### 5.4 Cascades

- Deleting a workspace cascades EVERYTHING under it
- Deleting a user cascades their memberships, sets their assignments to `null`
- NEVER orphan records — if a parent is deleted, children must be handled

---

## 6. Validation Rules

### 6.1 Zod is the Only Validator

- ALL request input (body, params, query) is validated via Zod schemas
- NO manual `if (!req.body.title)` checks — Zod handles it
- Schemas live in `<module>.schemas.ts` — never inline in controllers
- Schemas export inferred TypeScript types: `type CreateIssueInput = z.infer<typeof createIssueSchema>`

### 6.2 Validate at the Boundary

- Validation happens ONCE — in the `validate` middleware
- Services receive already-validated, typed data — they never re-validate
- Internal function parameters trust their callers (they've been validated upstream)

### 6.3 Never Trust Input

- Strip unknown fields (Zod `.strict()` or default behavior)
- Trim strings where appropriate
- Validate email formats, slug formats, UUID formats
- Enforce max lengths to prevent abuse (title: 500 chars, description: 50k chars, etc.)

---

## 7. Code Style Rules

### 7.1 File Naming

- All files: `kebab-case.ts` or `<module>.<layer>.ts` (e.g., `issue.service.ts`)
- One concern per file — no 500-line God files
- Max file length: ~300 lines. If longer, split into sub-services or helpers.

### 7.2 Function Naming

- Services: verb-first (`createIssue`, `updateIssueStatus`, `getIssuesByProject`)
- Controllers: match the route action (`create`, `getById`, `update`, `delete`, `list`)
- Middleware: descriptive (`authenticate`, `requireRole`, `validate`)

### 7.3 Error Handling

- THROW `AppError` in services — never return error objects
- Controllers NEVER try/catch — the global error handler catches everything
- Use `next(error)` only in middleware, not in controllers (Express 5 handles async automatically)
- Log unexpected errors (500s) — don't log expected errors (404s, 422s)

### 7.4 Imports

- Use `.js` extension in all relative imports (required by `nodenext` module resolution)
- Group imports: external packages → shared → same module
- No wildcard imports (`import * as`)

---

## 8. Security Rules

### 8.1 Never Expose

- NEVER expose internal IDs in error messages (e.g., "User user_2x... not found")
- NEVER expose stack traces in production responses
- NEVER log sensitive data (passwords, tokens, API keys, PII)
- NEVER return password hashes, API key hashes, or internal secrets in API responses
- NEVER commit `.env` files, secrets, or credentials

### 8.2 Input Sanitization

- NEVER trust input from ANY source (body, params, query, headers)
- ALWAYS validate and sanitize before processing
- Protect against: SQL injection (Prisma handles), XSS (don't render user HTML), prototype pollution

### 8.3 Rate Limiting

- Global rate limit on all routes
- Stricter rate limit on auth-related endpoints (webhooks, sensitive operations)
- Rate limit by IP for unauthenticated, by userId for authenticated

### 8.4 API Keys

- NEVER store raw API keys — only hashes
- Show the full key ONCE on creation, never again
- API keys expire — enforce `expiresAt` check on every request

---

## 9. Testing Rules

### 9.1 What Must Be Tested

- Every service function (unit test)
- Every route (integration test — full HTTP request → response)
- Every permission boundary (can user A access user B's workspace? NO.)
- Every workspace isolation boundary (does filtering by workspaceId work?)

### 9.2 Test Independence

- Tests never depend on execution order
- Tests never share state — each test sets up and tears down its own data
- Tests never hit external services (Clerk, Stripe) — mock them

### 9.3 No Skipping Tests

- NEVER commit with failing tests
- NEVER skip tests with `.skip` without a documented reason
- Tests must pass before moving to the next phase

---

## 10. Git & Workflow Rules

### 10.1 Commits

- Atomic commits — one logical change per commit
- Descriptive commit messages (what + why, not just "fix bug")
- Never commit generated files (`app/generated/`, `node_modules/`, `dist/`)
- Never commit environment files (`.env`)

### 10.2 Phase Discipline

- Each phase is FULLY complete before moving to the next
- "Complete" means: all routes work, all middleware applied, all tests pass, workspace isolation verified
- No half-built features. No TODO comments left behind. No "I'll fix it later".

### 10.3 No Dead Code

- Remove unused imports
- Remove commented-out code
- Remove unused functions/variables
- If it's not called, it doesn't exist

---

## 11. Performance Rules

### 11.1 Pagination

- ALL list endpoints use cursor-based pagination
- Default page size: 25, max: 100
- Always return `meta: { cursor, hasMore, total }`
- NEVER return unbounded lists

### 11.2 Query Efficiency

- Use `select` to fetch only needed fields on large queries
- Use `include` sparingly — only include relations that the response actually needs
- NEVER fetch all records and filter in JavaScript — always filter in the query
- Use indexes for common query patterns (already defined in schema)

### 11.3 N+1 Prevention

- NEVER query inside a loop
- Use Prisma's `include` or separate batch queries for related data
- If you find yourself writing `for (const item of items) { await prisma... }`, STOP and refactor

---

## 12. Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Files | kebab-case or module.layer | `issue.service.ts`, `api-response.ts` |
| Variables/functions | camelCase | `createIssue`, `workspaceId` |
| Classes | PascalCase | `AppError` |
| Constants | SCREAMING_SNAKE | `MAX_PAGE_SIZE`, `ERROR_CODES` |
| Env vars | SCREAMING_SNAKE | `DATABASE_URL`, `CLERK_SECRET_KEY` |
| DB tables | PascalCase (Prisma) | `User`, `WorkspaceMembership` |
| DB columns | camelCase | `createdAt`, `workspaceId` |
| Enums | PascalCase (type), SCREAMING_SNAKE (values) | `IssueStatus.IN_PROGRESS` |
| API routes | kebab-case, plural nouns | `/workspaces`, `/api-keys` |
| Query params | camelCase | `?assigneeId=...&pageSize=25` |
| Error codes | SCREAMING_SNAKE | `WORKSPACE_NOT_FOUND` |

---

## 13. Documentation Rules

### 13.1 Feature Documentation is Mandatory

Every module MUST have a `docs/` folder inside it with integration guides. Documentation is written BEFORE and AFTER implementation — not skipped.

```
modules/auth/
├── docs/
│   ├── setup-guide.md         # How to set up Clerk dashboard, env vars, webhook URL
│   ├── integration.md         # How the feature was implemented (architecture decisions, flow diagrams)
│   └── api-reference.md       # Endpoint reference specific to this module
├── auth.routes.ts
├── auth.controller.ts
├── auth.service.ts
└── auth.schemas.ts
```

### 13.2 Documentation Types per Module

Every module's `docs/` folder must contain:

| File | Purpose | When Written |
|------|---------|--------------|
| `setup-guide.md` | External setup steps (dashboard configs, third-party setup, environment vars, webhook URLs) | BEFORE implementation — planning phase |
| `integration.md` | How the feature was actually integrated (code architecture, data flow, edge cases handled, decisions made) | AFTER implementation — captures what was built and why |
| `api-reference.md` | Endpoint details for this module (request/response examples, error cases, permission matrix) | DURING implementation — updated as routes are finalized |

### 13.3 What Each Doc Must Cover

**`setup-guide.md`** (pre-implementation):
- Third-party dashboard setup (step-by-step with screenshots if needed)
- Environment variables required and where to get them
- External webhook/callback URL configuration
- Dependencies to install
- Prerequisite services or accounts needed

**`integration.md`** (post-implementation):
- Architecture overview (how the module fits into the system)
- Request flow diagram (from client to DB and back)
- Key decisions made and WHY (not just what)
- Edge cases and how they're handled
- Known limitations or future improvements
- Dependencies on other modules

**`api-reference.md`** (during implementation):
- Every endpoint with method, path, and description
- Request body examples (valid and invalid)
- Response examples (success and each error case)
- Permission requirements per endpoint
- Rate limiting specifics if different from global

### 13.4 Rules

- Documentation is NOT optional — a phase is not "done" without its docs
- Docs live WITH the module code (not in a separate top-level docs folder)
- Keep docs up to date — if you change the code, update the docs
- Write for a developer who has never seen this codebase
- Include real examples, not abstract descriptions
- NEVER document things that can be read directly from the code (like every line of a function)
- DO document WHY decisions were made, external configs, and non-obvious flows

### 13.5 Module Documentation Example (Auth)

```
modules/auth/docs/
├── setup-guide.md
│   → How to create a Clerk app
│   → How to configure Google/GitHub OAuth in Clerk dashboard
│   → How to set up the webhook endpoint in Clerk
│   → Required env vars (CLERK_SECRET_KEY, CLERK_WEBHOOK_SECRET)
│
├── integration.md
│   → Clerk webhook flow (user.created → User table sync)
│   → Auth middleware implementation (JWT verify → req.user)
│   → Race condition handling (JWT valid but user not in DB yet)
│   → Why we use Clerk user_id as our User.id primary key
│
└── api-reference.md
    → POST /webhooks/clerk — webhook receiver (signature verification)
    → GET /me — returns authenticated user profile
    → Error cases: 401, 403 (USER_NOT_SYNCED)
```

---

## Summary (Pin This)

```
1. Route → Controller → Service → DB. No skipping.
2. Every query is workspace-scoped. No exceptions.
3. Every route has auth + workspace + role middleware.
4. Zod validates. AppError communicates failure.
5. Standard response format. Always.
6. No premature abstraction. Earn complexity.
7. Tests pass before next phase. Always.
8. Never trust client input. Never expose internals.
9. Never commit secrets. Never skip auth.
10. Clean code. No dead code. No TODOs.
11. Every module has docs/ (setup-guide, integration, api-reference).
```
