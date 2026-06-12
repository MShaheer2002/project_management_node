# Phase 18 — API Keys: Full Implementation Guide

## Overview

API keys enable external systems (CI/CD pipelines, chatbots, the Phase 20 MCP/AI server, cron jobs, third-party integrations) to call the Linearis API without a Clerk user session. A key is scoped to one workspace and attributed to the user who created it.

**What this phase delivers:**
- CRUD endpoints for API key management (create, list, revoke)
- Dual-mode authentication middleware (Clerk JWT OR API key)
- Per-key audit trail (`lastUsedAt`, activity logging)
- Plan-based key limits
- Production-grade security (SHA-256 hashing, one-time display, prefix-based identification)

**What this phase does NOT deliver:**
- Per-key scoped permissions (e.g., `issues:read`, `issues:write`) — deferred to Phase 19/20 when integrations define what external access looks like
- API key rotation endpoint (two-key overlap) — deferred, users can create a new key before revoking the old one manually

---

## 1. Schema Change

The existing `ApiKey` model in `prisma/schema.prisma` needs two changes:

1. `keyHash` must be `@unique` — the SHA-256 hash is the primary lookup key, not the prefix
2. Remove the `@@index([keyPrefix])` — replaced by the unique constraint on `keyHash`

### 1.1 Migration

```prisma
model ApiKey {
  id          String    @id @default(uuid())
  workspaceId String
  name        String    // Human-readable label (e.g., "CI/CD Pipeline", "Slack Bot")
  keyHash     String    @unique // SHA-256 hash of full key — unique index for O(1) lookup
  keyPrefix   String    // First 16 chars for display (e.g., "lin_live_a8f3bc91")
  createdById String
  createdAt   DateTime  @default(now())
  lastUsedAt  DateTime? // Updated periodically on API requests using this key
  expiresAt   DateTime? // Optional expiration — null means never expires

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  createdBy User      @relation(fields: [createdById], references: [id])

  @@index([workspaceId])
}
```

**Why SHA-256 and not bcrypt?**

| | Passwords | API Keys |
|---|---|---|
| Entropy | Low (human-chosen, 8-20 chars) | High (cryptographically random, 48+ chars) |
| Brute-force risk | High — bcrypt slows each guess | None — 2^192 possible keys |
| Hash speed needed | Slow (100-300ms) is a feature | Fast (<1ms) is required — runs on every request |
| Lookup pattern | Find user by email, then compare | Find key by hash directly (indexed) |

bcrypt is designed to be slow to protect weak secrets. API keys are strong secrets that don't need slow hashing. SHA-256 gives O(1) indexed lookup with zero security trade-off.

### 1.2 Run Migration

```bash
npx prisma migrate dev --name add-api-key-unique-hash
```

---

## 2. Key Format and Generation

### 2.1 Key Structure

```
lin_live_a8f3bc91e4d7f02b1c9a3e5d7f8b0c2a4e6f8d0b2c4a6e8f0d2b4c6a8e0f
|______| |______________________________________________________________|
 prefix                        random payload
 (8 chars)                     (48 hex chars = 24 bytes = 192 bits entropy)
```

- **Prefix:** `lin_live_` for production, `lin_test_` for development
- **Payload:** 24 cryptographically random bytes encoded as hex (48 chars)
- **Full key length:** 56 characters
- **Display prefix (`keyPrefix` column):** first 16 chars — e.g., `lin_live_a8f3bc91` — enough for humans to identify which key is which in the list UI

### 2.2 Generation Logic

```typescript
import { randomBytes, createHash } from "node:crypto";

const KEY_PREFIX_LIVE = "lin_live_";
const KEY_PREFIX_TEST = "lin_test_";
const PAYLOAD_BYTES = 24; // 192 bits of entropy
const DISPLAY_PREFIX_LENGTH = 16; // Stored in keyPrefix for list UI

function generateApiKey(environment: "production" | "development"): {
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
} {
  const prefix = environment === "production" ? KEY_PREFIX_LIVE : KEY_PREFIX_TEST;
  const payload = randomBytes(PAYLOAD_BYTES).toString("hex");
  const rawKey = `${prefix}${payload}`;

  return {
    rawKey,                                      // Returned to user ONCE
    keyHash: hashApiKey(rawKey),                  // Stored in DB
    keyPrefix: rawKey.slice(0, DISPLAY_PREFIX_LENGTH), // Stored for display
  };
}

function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}
```

**Why not reuse `generateToken()` from `shared/utils/crypto.ts`?**

You CAN reuse `hashToken()` (it's already SHA-256). But `generateToken()` produces a plain hex string without the `lin_live_` prefix. The API key generation needs the prefix for identification. Create a dedicated `generateApiKey` function in the api-key module that calls the shared `hashToken` internally.

### 2.3 Why 192 Bits?

- 128 bits = standard for session tokens (GitHub uses this)
- 192 bits = extra margin for a key that may live for months/years
- 256 bits = overkill, makes the key unnecessarily long to copy/paste
- At 192 bits, brute-force requires 2^192 guesses — the sun burns out first

---

## 3. Authentication — Dual-Mode Middleware

### 3.1 How It Works

The existing `authenticate` middleware checks for a Clerk JWT. The new dual-mode version tries Clerk first, then falls back to API key if the token looks like one.

```
Request arrives
  │
  ├─ Authorization header present?
  │   │
  │   ├─ Starts with "lin_live_" or "lin_test_"?
  │   │   │
  │   │   └─ YES → API key auth flow
  │   │       1. SHA-256 hash the full key
  │   │       2. SELECT FROM ApiKey WHERE keyHash = <hash>
  │   │       3. Not found → 401 INVALID_API_KEY
  │   │       4. Check expiresAt → expired → 401 API_KEY_EXPIRED
  │   │       5. Verify creator's workspace membership still exists
  │   │          → removed → 401 API_KEY_REVOKED
  │   │       6. Set req.user = creator
  │   │       7. Set req.workspace = { id, role: creator's current role }
  │   │       8. Set req.apiKey = { id, name, workspaceId }
  │   │       9. Schedule lastUsedAt update (debounced)
  │   │       10. next()
  │   │
  │   └─ NO → Clerk JWT auth flow (existing behavior, unchanged)
  │
  └─ No Authorization header → 401 UNAUTHORIZED
```

### 3.2 Implementation: `authenticateApiKey` Middleware

Do NOT modify the existing `authenticate` middleware. Create a new wrapper that tries both.

**File:** `shared/middleware/authenticate-api-key.ts`

```typescript
import type { RequestHandler } from "express";
import { prisma } from "../utils/prisma.js";
import { AppError } from "../utils/api-error.js";
import { ERROR_CODES } from "../errors/error-codes.js";
import { hashToken } from "../utils/crypto.js";

const API_KEY_PREFIXES = ["lin_live_", "lin_test_"];

// Debounce lastUsedAt updates — don't hit DB on every single request
const lastUsedAtCache = new Map<string, number>(); // keyId → last update timestamp
const LAST_USED_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

function isApiKey(token: string): boolean {
  return API_KEY_PREFIXES.some((prefix) => token.startsWith(prefix));
}

export const authenticateApiKey: RequestHandler = async (req, _res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Authentication required");
    }

    const token = authHeader.slice(7); // Remove "Bearer "

    if (!isApiKey(token)) {
      // Not an API key — skip, let Clerk middleware handle it
      return next();
    }

    // ── API Key Auth Flow ──
    const keyHash = hashToken(token);

    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash },
      select: {
        id: true,
        name: true,
        workspaceId: true,
        createdById: true,
        expiresAt: true,
      },
    });

    if (!apiKey) {
      throw new AppError(401, ERROR_CODES.INVALID_API_KEY, "Invalid API key");
    }

    // Check expiration
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw new AppError(401, ERROR_CODES.API_KEY_EXPIRED, "This API key has expired");
    }

    // Verify creator still has workspace membership (prevents orphaned key access)
    const membership = await prisma.workspaceMembership.findUnique({
      where: {
        userId_workspaceId: {
          userId: apiKey.createdById,
          workspaceId: apiKey.workspaceId,
        },
      },
      select: { role: true },
    });

    if (!membership) {
      throw new AppError(401, ERROR_CODES.API_KEY_REVOKED,
        "This API key's creator is no longer a member of the workspace");
    }

    // Resolve the creator's user profile
    const creator = await prisma.user.findUnique({
      where: { id: apiKey.createdById },
      select: { id: true, email: true, name: true },
    });

    if (!creator) {
      throw new AppError(401, ERROR_CODES.API_KEY_REVOKED, "This API key's creator no longer exists");
    }

    // Attach to request
    req.user = { id: creator.id, email: creator.email, name: creator.name };
    req.workspace = { id: apiKey.workspaceId, role: membership.role };
    req.apiKey = { id: apiKey.id, name: apiKey.name, workspaceId: apiKey.workspaceId };

    // Debounced lastUsedAt update
    const now = Date.now();
    const lastUpdate = lastUsedAtCache.get(apiKey.id) ?? 0;
    if (now - lastUpdate > LAST_USED_DEBOUNCE_MS) {
      lastUsedAtCache.set(apiKey.id, now);
      // Fire and forget — don't block the request
      prisma.apiKey.update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      }).catch(() => {}); // Swallow errors — non-critical
    }

    next();
  } catch (error) {
    next(error);
  }
};
```

### 3.3 Composing Dual-Mode Auth

Create a combined middleware that tries API key first (cheap prefix check), then falls back to Clerk:

**File:** `shared/middleware/authenticate-dual.ts`

```typescript
import type { RequestHandler } from "express";
import { authenticateApiKey } from "./authenticate-api-key.js";
import { authenticate } from "./authenticate.js";

const API_KEY_PREFIXES = ["lin_live_", "lin_test_"];

/**
 * Dual-mode authentication middleware.
 * Tries API key auth if the token looks like one, otherwise falls back to Clerk JWT.
 *
 * After this middleware, req.user and req.workspace are guaranteed to be set.
 * If authenticated via API key, req.apiKey is also set and req.workspace is
 * auto-resolved (no X-Workspace-Id header needed).
 */
export const authenticateDual: RequestHandler = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (API_KEY_PREFIXES.some((p) => token.startsWith(p))) {
    return authenticateApiKey(req, res, next);
  }

  return authenticate(req, res, next);
};
```

### 3.4 Middleware Chain Adjustment

For routes that should accept both Clerk JWT and API key auth:

```typescript
// Before (Clerk only):
router.get("/", authenticate, requireWorkspace, controller.list);

// After (dual-mode):
router.get("/", authenticateDual, requireWorkspace, controller.list);
```

**Which routes should accept API keys?**

Phase 18 keeps it simple — API keys work on ALL authenticated routes. The `authenticateDual` middleware replaces `authenticate` in the middleware chain. The `requireWorkspace` middleware already works because API key auth pre-fills `req.workspace`.

However, some routes should NEVER accept API keys:
- `POST /api-keys` — creating an API key requires a real user session (Clerk)
- `DELETE /api-keys/:id` — revoking requires a real user session
- `GET /api-keys` — listing requires a real user session
- Workspace management (create/delete workspace, change roles)
- Billing endpoints

For Phase 18, apply `authenticateDual` to data-access routes (issues, projects, teams, comments, etc.) and keep `authenticate` (Clerk-only) on management routes.

### 3.5 `requireWorkspace` Skip for API Key Auth

When authenticated via API key, `req.workspace` is already set by the API key middleware. The `requireWorkspace` middleware should detect this and skip the header/param lookup:

```typescript
// shared/middleware/require-workspace.ts — add at the top of the handler:

// If authenticated via API key, workspace is already resolved
if (req.apiKey && req.workspace) {
  return next();
}
```

### 3.6 Express Type Extension

Add `apiKey` to the Express request type:

```typescript
// shared/types/express.d.ts

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string; name: string };
      workspace?: { id: string; role: string };
      apiKey?: { id: string; name: string; workspaceId: string }; // NEW
      validated?: { body?: any; params?: any; query?: any };
    }
  }
}
```

---

## 4. API Endpoints

### 4.1 Routes

```
POST   /api-keys          — Create a new API key (ADMIN+ only, Clerk auth only)
GET    /api-keys          — List all keys in workspace (ADMIN+ only, masked)
GET    /api-keys/:id      — Get single key details (ADMIN+ only, masked)
DELETE /api-keys/:id      — Revoke (delete) a key (ADMIN+ only)
```

All endpoints require:
- Clerk JWT authentication (NOT API key — you can't use an API key to manage API keys)
- Active workspace context
- ADMIN or OWNER role

### 4.2 Create API Key

**`POST /api-keys`**

Request:
```json
{
  "name": "CI/CD Pipeline",
  "expiresAt": "2027-01-01T00:00:00Z"
}
```

- `name` — required, 1-100 chars, human-readable label
- `expiresAt` — optional, ISO 8601 datetime, must be in the future

Response (201):
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "CI/CD Pipeline",
    "key": "lin_live_a8f3bc91e4d7f02b1c9a3e5d7f8b0c2a4e6f8d0b2c4a6e8f0d2b4c6a8e0f",
    "keyPrefix": "lin_live_a8f3bc91",
    "createdAt": "2026-06-10T...",
    "expiresAt": "2027-01-01T00:00:00Z",
    "createdBy": {
      "id": "user_xxx",
      "name": "Shaheer",
      "email": "shaheer@example.com"
    }
  }
}
```

**CRITICAL:** The `key` field contains the full raw API key. This is the ONLY time it is ever returned. The frontend must show a "copy to clipboard" modal with a warning: "This key won't be shown again."

Errors:
| Code | Status | When |
|------|--------|------|
| `VALIDATION_ERROR` | 422 | Invalid name/expiresAt |
| `API_KEY_LIMIT_REACHED` | 409 | Workspace has reached max keys for plan |
| `INSUFFICIENT_ROLE` | 403 | MEMBER or GUEST tried to create |

### 4.3 List API Keys

**`GET /api-keys`**

Response (200):
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "name": "CI/CD Pipeline",
      "keyPrefix": "lin_live_a8f3bc91",
      "createdAt": "2026-06-10T...",
      "lastUsedAt": "2026-06-10T...",
      "expiresAt": "2027-01-01T00:00:00Z",
      "isExpired": false,
      "createdBy": {
        "id": "user_xxx",
        "name": "Shaheer",
        "email": "shaheer@example.com"
      }
    }
  ]
}
```

**Note:** The full key is NEVER returned in list responses. Only `keyPrefix` (first 16 chars) for identification.

### 4.4 Get Single API Key

**`GET /api-keys/:id`**

Same shape as a single item from the list response. Useful for checking `lastUsedAt` and `expiresAt` for a specific key.

### 4.5 Revoke (Delete) API Key

**`DELETE /api-keys/:id`**

Response: `204 No Content`

**Effect is immediate.** The next request using this key will receive `401 INVALID_API_KEY`. No cache to invalidate — the key is looked up from DB on every request.

Errors:
| Code | Status | When |
|------|--------|------|
| `API_KEY_NOT_FOUND` | 404 | Key doesn't exist or belongs to different workspace |

---

## 5. Security Rules

### 5.1 Key Storage

| What | Where | Format |
|------|-------|--------|
| Raw key | Returned in POST response ONCE | `lin_live_a8f3bc91...` (56 chars) |
| Key hash | `ApiKey.keyHash` column | SHA-256 hex (64 chars), `@unique` indexed |
| Key prefix | `ApiKey.keyPrefix` column | First 16 chars of raw key |

The raw key is NEVER stored anywhere on the server. If the database leaks, attackers get SHA-256 hashes of high-entropy keys — completely useless.

### 5.2 Key Lookup Flow (on every API request)

```
1. Extract token from Authorization: Bearer <token>
2. Check if token starts with "lin_live_" or "lin_test_"
3. SHA-256 hash the full token
4. SELECT FROM ApiKey WHERE keyHash = <hash>  ← O(1) unique index
5. Verify expiresAt, verify creator membership
6. Done — no bcrypt comparison, no scanning, no loops
```

### 5.3 Things That MUST NOT Happen

| Anti-pattern | Why | Correct approach |
|---|---|---|
| Store raw key in DB | Database leak = full access | Store SHA-256 hash only |
| Return raw key in GET responses | Key exposure on every list view | Return `keyPrefix` only |
| Use bcrypt for API key hashing | 100-300ms per request, unscalable | SHA-256 is <1ms, keys are high-entropy |
| Look up key by prefix then compare | `lin_live_` is same for all keys, scans entire table | Look up by exact hash (unique index) |
| Let API keys create/delete other API keys | Privilege escalation risk | Require Clerk JWT for key management |
| Keep working after creator removed from workspace | Orphaned access | Verify creator membership on each request |
| Log raw API key in request logs | Key leaks into log files | Never log the Authorization header value |
| Send raw key in error messages | Key leaks in error responses | Only reference key by prefix or ID |

### 5.4 Request Logging Safety

The existing `requestLogger` middleware must NOT log the `Authorization` header for API key requests. Add a check:

```typescript
// In request logger — sanitize Authorization header
const sanitizedHeaders = { ...req.headers };
if (sanitizedHeaders.authorization) {
  const token = sanitizedHeaders.authorization.replace("Bearer ", "");
  if (token.startsWith("lin_live_") || token.startsWith("lin_test_")) {
    sanitizedHeaders.authorization = `Bearer ${token.slice(0, 16)}...`;
  }
}
```

---

## 6. Plan-Based Limits

### 6.1 Key Limits per Plan

| Plan | Max API Keys per Workspace |
|------|---------------------------|
| FREE | 2 |
| STANDARD | 10 |
| PREMIUM | 50 |

### 6.2 Enforcement

Follow the same pattern as `enforceFreeWorkspaceCapacity` in `billing.service.ts`:

```typescript
// modules/api-key/api-key.service.ts

async function enforceApiKeyLimit(workspaceId: string) {
  const subscription = await getSubscriptionRecord(workspaceId);
  const plan = getAccessPlan(subscription.plan, subscription.status);

  const limits: Record<string, number> = {
    FREE: 2,
    STANDARD: 10,
    PREMIUM: 50,
  };

  const maxKeys = limits[plan] ?? 2;

  const currentCount = await prisma.apiKey.count({
    where: { workspaceId },
  });

  if (currentCount >= maxKeys) {
    throw new AppError(
      409,
      ERROR_CODES.API_KEY_LIMIT_REACHED,
      `Your ${plan.toLowerCase()} plan allows a maximum of ${maxKeys} API keys. Delete unused keys or upgrade your plan.`,
    );
  }
}
```

---

## 7. Rate Limiting for API Keys

API key requests should have separate, stricter rate limits than user sessions. A leaked key could be used for automated abuse.

### 7.1 Rate Limit Tiers

| Auth Method | Limit | Window |
|---|---|---|
| Clerk JWT (user session) | 100 req/min | Per IP |
| API key | 60 req/min | Per key ID |

### 7.2 Implementation

Create an API key rate limiter that keys on `req.apiKey.id` instead of IP:

```typescript
// shared/middleware/rate-limiter.ts — add:

export const apiKeyRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  keyGenerator: (req) => {
    // Rate limit by API key ID (not IP) for API key requests
    return req.apiKey?.id ?? req.ip ?? "unknown";
  },
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: ERROR_CODES.RATE_LIMITED,
        message: "API key rate limit exceeded. Maximum 60 requests per minute.",
      },
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.apiKey, // Only apply to API key requests
});
```

Apply this AFTER the dual auth middleware in the global middleware stack or on a per-route basis.

---

## 8. Error Codes

Add these to `shared/errors/error-codes.ts`:

```typescript
// ─── API Key (Phase 18) ─────────────────────────────────────────────
INVALID_API_KEY: "INVALID_API_KEY",
API_KEY_EXPIRED: "API_KEY_EXPIRED",
API_KEY_REVOKED: "API_KEY_REVOKED",
API_KEY_NOT_FOUND: "API_KEY_NOT_FOUND",
API_KEY_LIMIT_REACHED: "API_KEY_LIMIT_REACHED",
API_KEY_NAME_REQUIRED: "API_KEY_NAME_REQUIRED",
```

---

## 9. Activity Logging

API key creation, usage, and revocation should be logged in the activity feed:

| Action | Activity Type | Target |
|---|---|---|
| Key created | `API_KEY_CREATED` | The API key |
| Key revoked | `API_KEY_REVOKED` | The API key |

API requests made via an API key are attributed to the key's creator in the activity log (same as if the creator made the request themselves). The `metadata` field should include `{ viaApiKey: true, apiKeyId: "...", apiKeyName: "..." }` so the activity feed can display "via API key: CI/CD Pipeline" instead of making it look like the user did it manually.

---

## 10. Module Structure

```
modules/api-key/
├── api-key.routes.ts        # Route definitions with Clerk-only auth
├── api-key.controller.ts    # Request handlers
├── api-key.service.ts       # Key generation, hashing, CRUD, plan enforcement
├── api-key.schemas.ts       # Zod validation schemas
└── docs/
    ├── setup-guide.md       # How to use API keys, copy/store guidance
    ├── integration.md       # Architecture decisions, auth flow diagrams
    └── api-reference.md     # Endpoint docs with examples
```

---

## 11. Schemas (Zod)

```typescript
// modules/api-key/api-key.schemas.ts

import { z } from "zod/v4";

export const createApiKeySchema = {
  body: z.object({
    name: z
      .string()
      .min(1, "API key name is required")
      .max(100, "Name must be at most 100 characters")
      .trim(),
    expiresAt: z
      .string()
      .datetime("Invalid date format")
      .refine(
        (date) => new Date(date) > new Date(),
        "Expiration date must be in the future",
      )
      .optional(),
  }),
};

export const apiKeyIdParamSchema = {
  params: z.object({
    id: z.string().uuid("Invalid API key ID"),
  }),
};

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema.body>;
```

---

## 12. Edge Cases

### 12.1 Creator Removed from Workspace

**Scenario:** Admin creates API key → Admin is later removed from workspace by Owner.

**Behavior:** The next request using the key checks creator's membership → not found → `401 API_KEY_REVOKED`. The key effectively stops working immediately without anyone explicitly revoking it.

**Cleanup:** When a member is removed from a workspace (`membership.service.ts` → `removeMember`), optionally delete all their API keys for that workspace in the same transaction. This is cleaner than leaving orphaned rows.

```typescript
// In removeMember transaction, add:
await tx.apiKey.deleteMany({
  where: { workspaceId, createdById: targetUserId },
});
```

### 12.2 Creator's Role Changes

**Scenario:** Admin creates API key → Admin is demoted to GUEST.

**Behavior:** The API key now has GUEST-level permissions because the dual auth middleware resolves the creator's **current** role on every request. The key does not retain the ADMIN role from creation time.

### 12.3 Workspace Deleted

**Behavior:** `onDelete: Cascade` on the `workspace` relation automatically deletes all API keys when a workspace is deleted. No orphaned keys.

### 12.4 Key Used After Expiration

**Behavior:** `401 API_KEY_EXPIRED` with message "This API key has expired." The key is NOT automatically deleted — the admin can see it in the list with `isExpired: true` and decide to delete it or (future) extend it.

### 12.5 Duplicate Key Names

**Behavior:** Allowed. Multiple keys can have the same name within a workspace. Keys are identified by ID and prefix, not by name. Users often create "CI/CD Pipeline" keys for different environments.

### 12.6 Clock Skew on Expiration

**Behavior:** Expiration is checked server-side against `new Date()`. No client clock involved. If `expiresAt` is midnight UTC and the server checks at 00:00:01 UTC, the key is expired. No grace period.

### 12.7 Rapid Key Creation Spam

**Behavior:** Plan-based limits prevent creating more than 2/10/50 keys. Additionally, the `strictRateLimiter` (20 req/min) should be applied to `POST /api-keys` to prevent rapid creation attempts.

### 12.8 API Key in URL Query Parameters

**Behavior:** NEVER supported. API keys must be sent in the `Authorization: Bearer` header only. Query parameter tokens leak into:
- Server access logs
- Browser history
- Referer headers
- Proxy logs
- CDN logs

### 12.9 Multiple Valid Keys

**Behavior:** A workspace can have multiple valid keys simultaneously. Each key is independent — revoking one does not affect others. This enables:
- Key rotation: create new key, update integration, revoke old key
- Per-integration keys: separate key for CI/CD, Slack bot, MCP server

### 12.10 Test vs Live Keys

| Prefix | Environment | Notes |
|---|---|---|
| `lin_test_` | Development | Only generated when `NODE_ENV !== "production"` |
| `lin_live_` | Production | Only generated when `NODE_ENV === "production"` |

The API does NOT enforce that test keys only work in development. The prefix is for **human identification** (like Stripe's `sk_test_` vs `sk_live_`). Both key types go through the same auth flow.

---

## 13. `lastUsedAt` Debouncing

Updating `lastUsedAt` on every single API request would:
- Add a write query to every read request
- Create write contention on a hot row
- Slow down every API call by the write latency

### 13.1 Debounce Strategy

- Keep an in-memory Map of `keyId → lastUpdateTimestamp`
- Only write to DB if the last update was more than 5 minutes ago
- Fire-and-forget (don't await the update, don't block the request)
- On server restart, the in-memory cache resets — acceptable, the first request after restart will update

### 13.2 Alternative: Background Job

For higher scale, push `lastUsedAt` updates to a background queue (BullMQ) and batch-update every minute. This is overkill for Phase 18 but worth noting for Phase 20 when MCP agents may generate high API key traffic.

---

## 14. Frontend Integration

### 14.1 Current Mock vs Required Changes

The current frontend mock has the right layout but one critical security issue:

| Mock Element | Status | Action |
|---|---|---|
| Header "API Keys" + key count badge | Correct | Keep as-is |
| "+ Generate New Key" button | Correct | Keep as-is |
| Security Best Practices banner | Correct | Keep as-is |
| Key name (e.g., "Production API Key") | Correct | Keep as-is |
| Created date + last used timestamp | Correct | Keep as-is |
| Masked key display `lin_live_****...` | Correct | Keep as-is |
| Delete (trash) icon | Correct | Keep as-is |
| **"REVEAL" button** | **REMOVE** | Raw key is not stored on the server — there is nothing to reveal |
| **Copy button on listed keys** | **CHANGE** | Copy button copies the **prefix only** (for pasting into support tickets/logs), NOT the full key |
| Expiry date | **ADD** | Show "Expires: Jan 1, 2027" or "Never expires" per key |
| Created by | **ADD** | Show creator name — matters when multiple admins manage keys |
| Expired visual state | **ADD** | Show expired keys with a muted/strikethrough style + "Expired" badge |

**Why no REVEAL?** The backend stores only the SHA-256 hash of the key. The raw key is returned ONCE in the `POST /api-keys` response and never persisted. Even the backend cannot reconstruct it. This is the same pattern used by GitHub, Stripe, OpenAI, and AWS — the key is shown once at creation, then gone forever. If the user loses it, they delete the old key and create a new one.

### 14.2 API Keys Page — Layout

Located at `/api-keys` (route placeholder already exists in `routes.tsx`).

**Page structure:**

```
┌──────────────────────────────────────────────────────────────────────┐
│  API Keys  [3 keys]                              [+ Generate New Key] │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ (!) Security Best Practices                                    │  │
│  │ Never share your API keys or expose them in client-side code.  │  │
│  │ Use environment variables to store them securely on your       │  │
│  │ server.                                                        │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ 🔑 Production API Key                                    🗑   │  │
│  │ Created Jan 15, 2026 · Last used 2 hours ago · Never expires  │  │
│  │ Created by Shaheer Qureshi                                     │  │
│  │                                                                │  │
│  │ ┌──────────────────────────────────────────────────────────┐  │  │
│  │ │ lin_live_a8f3bc91••••••••                          [Copy] │  │  │
│  │ └──────────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ 🔑 Development Key                                       🗑   │  │
│  │ Created Feb 20, 2026 · Last used 1 day ago · Never expires    │  │
│  │ Created by Shaheer Qureshi                                     │  │
│  │                                                                │  │
│  │ ┌──────────────────────────────────────────────────────────┐  │  │
│  │ │ lin_test_b7e2cd40••••••••                          [Copy] │  │  │
│  │ └──────────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌─────────────────────────────────── EXPIRED ────────────────────┐  │
│  │ 🔑 Old CI Key                                  [Expired] 🗑   │  │
│  │ Created Nov 1, 2025 · Last used 3 months ago                   │  │
│  │ Expired Dec 31, 2025 · Created by Ali Khan                     │  │
│  │                                                                │  │
│  │ ┌──────────────────────────────────────────────────────────┐  │  │
│  │ │ lin_live_c3d4e5f6••••••••                          [Copy] │  │  │
│  │ └──────────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

**Key card fields:**
- Key name (human-readable label)
- Created date (relative or absolute)
- Last used (relative, e.g., "2 hours ago", "Never used")
- Expires (date or "Never expires")
- Created by (name of the admin who created it)
- Masked key prefix with copy button (copies prefix only, e.g., `lin_live_a8f3bc91`)
- Delete icon (opens revoke confirmation)
- Expired badge (visual indicator if `expiresAt < now`)

**Expired keys** should be visually muted (reduced opacity or strikethrough) with an "Expired" badge. They remain in the list so the admin can see them and delete them.

**Empty state:**
```
No API keys yet.
Create one to enable external integrations, CI/CD pipelines, or AI assistants.

[+ Generate New Key]
```

### 14.3 Create Key — Two-Step Modal

The creation flow has two steps in the SAME modal:

**Step 1 — Input:**
```
┌─────────────────────────────────────────────────────────────┐
│  Generate New API Key                                       │
│                                                             │
│  Name                                                       │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ CI/CD Pipeline                                      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  Expiration (optional)                                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Never                                          [v]  │    │
│  └─────────────────────────────────────────────────────┘    │
│  Options: Never, 30 days, 60 days, 90 days, 1 year, Custom │
│                                                             │
│                              [Cancel]  [Generate Key]       │
└─────────────────────────────────────────────────────────────┘
```

**Step 2 — One-time key display (replaces Step 1 content in the same modal):**
```
┌─────────────────────────────────────────────────────────────┐
│  Your API key has been created                              │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ lin_live_a8f3bc91e4d7f02b1c9a3e5d7f8b0c2a4e6f8d0   │    │
│  │ b2c4a6e8f0d2b4c6a8e0f                               │    │
│  │                                          [Copy]      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ⚠ Copy this key now. You won't be able to see it again.  │
│  Store it in a secure location like a password manager or   │
│  environment variable.                                      │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Example usage:                                        │   │
│  │ curl -H "Authorization: Bearer lin_live_a8f3bc..."    │   │
│  │      https://api.linearis.app/issues                  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│                                 [I've copied the key]       │
└─────────────────────────────────────────────────────────────┘
```

**Rules for Step 2:**
- The modal CANNOT be closed by clicking outside or pressing Escape — only by clicking "I've copied the key"
- The Copy button shows a checkmark + "Copied!" feedback for 2 seconds
- The key is displayed in a monospace font with word-break so it doesn't overflow
- The curl example uses the actual generated key (helps the user test immediately)
- After clicking "I've copied the key" → modal closes → key list refreshes → the new key appears in the list (masked)

**What if the user closes the browser during Step 2?** The key is lost. They must delete and create a new one. This is expected behavior — same as GitHub/Stripe.

### 14.4 Revoke Confirmation Dialog

```
┌─────────────────────────────────────────────────────────────┐
│  Revoke API Key                                             │
│                                                             │
│  Are you sure you want to revoke "CI/CD Pipeline"?          │
│  (lin_live_a8f3bc91)                                        │
│                                                             │
│  This action is immediate and cannot be undone. Any         │
│  integration using this key will stop working instantly.    │
│                                                             │
│                              [Cancel]  [Revoke Key]         │
└─────────────────────────────────────────────────────────────┘
```

- "Revoke Key" button should be red/destructive styled
- On success: toast "API key revoked" + remove from list (optimistic or refetch)

### 14.5 Copy Behavior on Key Cards

The `[Copy]` button on listed key cards copies the **prefix only** (e.g., `lin_live_a8f3bc91`), NOT the full key. The full key does not exist on the server.

This is useful for:
- Pasting into support tickets ("which key is failing?" → "lin_live_a8f3bc91")
- Identifying keys in CI/CD logs
- Referencing in team communication

Toast on copy: "Key prefix copied to clipboard"

### 14.6 User Loses Their Key — Recovery Flow

There is no recovery. The user must:

1. Click delete (trash icon) on the lost key → confirm revocation
2. Click "+ Generate New Key" → create a replacement
3. Copy the new key → update their integration/CI/CD secrets

This is standard practice (GitHub, Stripe, OpenAI, AWS all work this way). Add a help text or tooltip near the key list:

> "Lost your key? Delete the old one and generate a new one. API keys cannot be recovered after creation."

### 14.7 Frontend Types

```typescript
// API Key list item (from GET /api-keys)
interface ApiKeyListItem {
  id: string;
  name: string;
  keyPrefix: string;        // e.g., "lin_live_a8f3bc91"
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  isExpired: boolean;
  createdBy: {
    id: string;
    name: string;
    email: string;
  };
}

// API Key creation response (from POST /api-keys) — includes full key ONCE
interface ApiKeyCreateResponse {
  id: string;
  name: string;
  key: string;              // FULL raw key — shown ONCE, never again
  keyPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  createdBy: {
    id: string;
    name: string;
    email: string;
  };
}

// Create key input
interface CreateApiKeyInput {
  name: string;             // 1-100 chars
  expiresAt?: string;       // ISO 8601, optional, must be in the future
}
```

### 14.8 Frontend Error Handling

| Code | Status | User Message |
|------|--------|-------------|
| `API_KEY_LIMIT_REACHED` | 409 | "You've reached the maximum number of API keys for your plan. Delete unused keys or upgrade." |
| `API_KEY_NOT_FOUND` | 404 | "This API key no longer exists." |
| `INSUFFICIENT_ROLE` | 403 | "Only workspace admins and owners can manage API keys." |
| `VALIDATION_ERROR` | 422 | Show field-level errors (e.g., "Name is required", "Expiration must be in the future") |

### 14.9 Access Control

The API Keys page and all its actions should be visible/enabled only for `ADMIN` and `OWNER` roles. `MEMBER` and `GUEST` roles should either:
- Not see the "API Keys" link in the sidebar at all (preferred), or
- See the page but with a "You don't have permission to manage API keys" message

Check `sidebarData.permissions.canManageApiKeys` (already exists in the sidebar permissions) to conditionally render the link.

---

## 15. Implementation Order

1. **Schema migration** — Add `@unique` to `keyHash`, remove `@@index([keyPrefix])`
2. **Error codes** — Add Phase 18 error codes to `error-codes.ts`
3. **Express type extension** — Add `apiKey` to `express.d.ts`
4. **Schemas** — `api-key.schemas.ts`
5. **Service** — `api-key.service.ts` (key generation, CRUD, plan enforcement)
6. **Controller** — `api-key.controller.ts`
7. **Routes** — `api-key.routes.ts` (Clerk-only auth)
8. **Auth middleware** — `authenticate-api-key.ts` + `authenticate-dual.ts`
9. **Rate limiter** — `apiKeyRateLimiter`
10. **Wire routes** — Mount in `app.ts`
11. **Member removal cleanup** — Delete orphaned keys in `membership.service.ts`
12. **Activity types** — Add `API_KEY_CREATED`, `API_KEY_REVOKED` to activity enums
13. **Docs** — Module docs (setup-guide, integration, api-reference)

---

## 16. Done When

- [ ] `POST /api-keys` creates a key and returns the raw key once
- [ ] `GET /api-keys` lists all keys with masked prefixes (never full keys)
- [ ] `DELETE /api-keys/:id` revokes immediately — next request with that key gets 401
- [ ] API key authenticates requests on data-access routes (issues, projects, etc.)
- [ ] API key auth coexists with Clerk JWT auth — both work transparently
- [ ] Expired keys are rejected with `API_KEY_EXPIRED`
- [ ] Creator removed from workspace → key stops working immediately
- [ ] Creator demoted → key permissions reflect current role
- [ ] Workspace deletion cascades to all keys
- [ ] Plan-based limits enforced (FREE: 2, STANDARD: 10, PREMIUM: 50)
- [ ] `lastUsedAt` updated (debounced, non-blocking)
- [ ] API key requests rate-limited separately (60 req/min per key)
- [ ] Raw key never appears in logs, error messages, or GET responses
- [ ] Activity log records key creation and revocation
- [ ] Workspace isolation verified — key from workspace A cannot access workspace B
