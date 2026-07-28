# Access Control — Current State

This document is a snapshot of how Trussen currently decides *who can see and do what*, across both access layers that exist in the codebase today. It's descriptive, not prescriptive — written as a baseline before we change anything.

There are **two independent layers**, and a request has to clear both:

1. **Workspace role** (`OWNER` / `ADMIN` / `MEMBER` / `GUEST`) — what actions this person is allowed to take, checked on almost every route via middleware.
2. **Billing plan** (`FREE` / `STANDARD` / `PREMIUM`) — what the *workspace* is entitled to at all, regardless of who's asking. Currently only gates three things: AI, the 10-seat cap on Free, and (as of the last change) whether an over-capacity Free workspace can be used at all.

These two layers don't know about each other. A `MEMBER` on a `PREMIUM` workspace and a `MEMBER` on a `FREE` workspace have identical *role* permissions — the plan just changes what's available underneath them (AI blocked, seat cap, etc).

---

## Layer 1 — Workspace Roles

Enforced by `shared/middleware/require-role.ts`, placed after `requireWorkspace` in the middleware chain. It's a flat allow-list check against `req.workspace.role` — no hierarchy is assumed in the middleware itself (e.g. `requireRole("ADMIN", "OWNER")` doesn't automatically mean "OWNER can do what ADMIN can do", each route spells out its own allowed list).

| Role | General shape |
|---|---|
| `OWNER` | Full control. Only role that can delete the workspace, manage billing, transfer/change other members' roles alongside ADMIN. |
| `ADMIN` | Same as OWNER for almost everything *except* billing management and workspace deletion. Manages members, invitations, labels, workspace/workflow settings, templates, integrations, documents. |
| `MEMBER` | Normal contributor. Can create/edit issues, cycles, projects, teams, roadmap items, comments, uploads. Cannot manage workspace-level settings, labels, templates, or invitations. |
| `GUEST` | Read-mostly. Can view issues/activity/comments/notifications/labels/templates/roadmap detail, and comment — but can't create issues, projects, teams, cycles, or manage anything. |

### Ownership override (`requireOwnership`)

A second pattern, used for **project / team / department update, delete, and member management**: `shared/middleware/require-ownership.ts`.

Logic: **`OWNER`/`ADMIN` always pass.** Otherwise, the request only succeeds if the requester is the *specific resource's* designated owner (project lead, team lead, department head) — a plain `MEMBER` who is just a member of that project/team (not its lead) is forbidden, even though they can view and work inside it.

This means "can edit this project" is not a pure role check — it's `role >= ADMIN OR userId == project.leadId`.

### Module-by-module matrix

| Module | View | Create | Update / Manage | Delete |
|---|---|---|---|---|
| **Workspace** | any member | any authenticated user (creates their own) | ADMIN, OWNER | OWNER only |
| **Workspace statuses / workflow automation** | any member | — | ADMIN, OWNER | ADMIN, OWNER (merge/replace) |
| **Invitations** | ADMIN, OWNER (list) | ADMIN, OWNER | — | ADMIN, OWNER (revoke) |
| **Members** | any member (list) | via invitation | ADMIN, OWNER (role change) | ADMIN, OWNER |
| **Projects** | any member | MEMBER, ADMIN, OWNER | ADMIN/OWNER **or** project lead (ownership) | ADMIN/OWNER or project lead |
| **Project workflow override** | any member | — | ADMIN/OWNER or project lead | ADMIN/OWNER or project lead (revert) |
| **Teams** | any member | MEMBER, ADMIN, OWNER | ADMIN/OWNER or team lead | ADMIN, OWNER only (no lead override) |
| **Departments** | any member | ADMIN, OWNER | ADMIN/OWNER or department head | ADMIN, OWNER only |
| **Issues** | any member (incl. GUEST implicitly — no `requireRole` on GET) | MEMBER, ADMIN, OWNER | MEMBER, ADMIN, OWNER | ADMIN, OWNER only |
| **Issue approvals** | any member | — | MEMBER, ADMIN, OWNER (approve/revoke) | — |
| **Subtasks / attachments / dependencies / watchers** (on an issue) | any member | MEMBER, ADMIN, OWNER | MEMBER, ADMIN, OWNER | MEMBER, ADMIN, OWNER |
| **Comments** | GUEST, MEMBER, ADMIN, OWNER | GUEST, MEMBER, ADMIN, OWNER | GUEST, MEMBER, ADMIN, OWNER | GUEST, MEMBER, ADMIN, OWNER |
| **Cycles** | GUEST, MEMBER, ADMIN, OWNER | MEMBER, ADMIN, OWNER | MEMBER, ADMIN, OWNER (reopen is ADMIN/OWNER only) | MEMBER, ADMIN, OWNER |
| **Labels** | GUEST, MEMBER, ADMIN, OWNER | ADMIN, OWNER | ADMIN, OWNER | ADMIN, OWNER |
| **Templates** | GUEST, MEMBER, ADMIN, OWNER | ADMIN, OWNER | ADMIN, OWNER | ADMIN, OWNER |
| **Roadmap** (view) | GUEST, MEMBER, ADMIN, OWNER | — | — | — |
| **Roadmap** (schedule/milestones/dependencies) | — | MEMBER, ADMIN, OWNER **and** roadmap-manage-access check (project-lead-ish) | same | same |
| **Documents & folders** (workspace/team/project) | MEMBER, ADMIN, OWNER | ADMIN, OWNER | ADMIN, OWNER | ADMIN, OWNER |
| **Notifications / Activity** | GUEST, MEMBER, ADMIN, OWNER (own data) | — | — | — |
| **Analytics — workspace-wide** | ADMIN, OWNER | — | — | — |
| **Analytics — project/team/member/cycle** | MEMBER, ADMIN, OWNER | — | — | — |
| **API Keys** | ADMIN, OWNER | ADMIN, OWNER | — | ADMIN, OWNER |
| **Integrations** (GitHub/Slack/Figma/Discord connect + settings) | ADMIN, OWNER | ADMIN, OWNER | ADMIN, OWNER | ADMIN, OWNER |
| **Google Drive** | any authenticated user (it's per-user, not workspace-scoped) | — | — | — |
| **Uploads (presigned URLs)** | — | MEMBER, ADMIN, OWNER | — | — |
| **AI (chat/assist/generate/suggestions)** | any member at the *role* layer — no `requireRole` on these routes at all | any member at the role layer | — | — |
| **AI usage stats** (`/ai/usage/*`) | ADMIN, OWNER | — | — | — |
| **Billing** — see Layer 2 below | ADMIN, OWNER (view) | OWNER only | OWNER only | OWNER only |

Full role names above are exactly what each route checks — see `modules/*/*.routes.ts` if you need the literal call site.

### Public / unauthenticated routes

A small set of routes intentionally skip `authenticate`/`requireWorkspace` because the caller isn't a workspace member yet, or is an external system:
- `POST /webhooks/clerk`, `POST /webhooks/stripe`, `POST /webhooks/github`, `POST /webhooks/slack/commands` — external systems, verified by signature instead of a user session.
- `GET /invitations/resolve` — public, rate-limited, lets the invite UI show workspace/role context before sign-in.
- OAuth callbacks (`GET /integrations/github/callback`, `GET /me/drive/callback`) — the provider redirects the browser directly here; identity is verified via the `state` param in the service layer, not a session.
- `POST /workspaces` (create) and `GET /workspaces` (list mine) — any authenticated user, no workspace membership required yet (that's the point).

---

## Layer 2 — Billing Plan

Defined in `modules/billing/billing.service.ts`'s `getEntitlements()`, `modules/ai/ai.access.ts`, and the access-gate added most recently.

| Plan | Price | Member cap | Storage | AI | Workspace access if over cap |
|---|---|---|---|---|---|
| **FREE** | $0 | 10 (accepted + pending invites combined) | 2 GB | Blocked | Owner + earliest-joined 9 non-owner members only; everyone else is 403'd workspace-wide |
| **STANDARD** | $6/seat/month | Unlimited | 50 GB | Blocked | n/a |
| **PREMIUM** | $10/seat/month | Unlimited | Unlimited | Enabled | n/a |

### How each limit is actually enforced

- **10-seat cap (Free)** — `enforceFreeWorkspaceCapacity()`, called only when **creating an invitation** (`invitation.service.ts`). It is *not* re-checked at invite-acceptance time, so a workspace can end up with 11+ accepted members if a pending invite sent before the cap was hit gets accepted afterward. See "Known gaps" below.
- **Over-capacity access gate** — `assertWorkspaceAccessAllowed()`, called from `requireWorkspace` on every request. Owner always passes; on Free with more than 10 accepted members, only the earliest-joined 9 non-owners plus the owner pass — everyone else gets `403 FREE_PLAN_ACCESS_LIMIT_EXCEEDED` on every route, without their membership being deleted.
- **Storage cap** — tracked via `incrementStorageUsage`/`decrementStorageUsage` against `storageUsedBytes` on the `Subscription` row; enforcement point (where a write is actually blocked for exceeding it) lives wherever upload/document creation checks entitlements — worth a follow-up read if this needs verifying end-to-end.
- **AI gate** — *not* a route-level role check. Every AI route (`/ai/chat`, `/ai/assist`, `/ai/generate-issue`, etc.) is reachable by any workspace member at the role layer; the actual block happens inside `assertAiAccess()` in the controller/service, which checks `accessPlan === 'PREMIUM'`. There's also an `AI_ENFORCE_BILLING` env toggle — when off, AI runs in "monitor" mode (usage is tracked but nothing is blocked), which matters if you're trying to reason about why AI might not be gated in a given environment.
- **Seat billing sync** — `syncPaidSeatQuantityBestEffort()`, called after invite-accept and member-remove, recounts all accepted members and pushes the new quantity to Stripe with `proration_behavior: "create_prorations"`. Stripe decides whether the prorated delta is invoiced immediately or rolled into the next cycle.

### Plan-based billing permissions (separate from workspace roles)

| Role | Billing |
|---|---|
| `OWNER` | Full control — cards, plan changes, cancel |
| `ADMIN` | View only |
| `MEMBER` / `GUEST` | No access |

---

## Known gaps / inconsistencies worth deciding on

These aren't fixed yet — flagging them since you said this area needs work:

1. **Free cap has a race** — invite-accept doesn't re-check capacity, only invite-creation does. A workspace can transiently exceed 10 accepted members through pending invites that were valid when sent.
2. **`enforceFreeWorkspaceCapacity` checks the raw `plan` field**, not the status-aware `accessPlan` (which factors in `active`/`trialing`/`past_due` vs `canceled`/`unpaid`). A workspace with `plan: STANDARD` but a `canceled` status would skip the Free invite cap entirely, even though its *effective* access should already be Free. The AI gate and the new over-capacity gate both use the status-aware `getAccessPlan()` — this one function doesn't.
3. **No team-lead override for delete** — teams and departments allow lead/head override for *update*, but *delete* is hardcoded to ADMIN/OWNER only (no lead path). Projects don't have this asymmetry (lead can delete too). Worth deciding if that's intentional.
4. **AI is role-open but plan-gated** — any `GUEST` can technically hit `/ai/chat`; they just get blocked by the Premium check inside the handler rather than by `requireRole`. Functionally fine, but means AI access doesn't show up in a route-level role audit — you have to know to look inside the controller.
5. **Storage limit enforcement** wasn't traced end-to-end for this doc — worth confirming where (if anywhere) a write is actually rejected for being over the plan's storage cap, versus just being tracked.

---

## Where to look for changes

- Role checks: `shared/middleware/require-role.ts`, `shared/middleware/require-ownership.ts`, and each module's `*.routes.ts`.
- Plan/entitlement checks: `modules/billing/billing.service.ts` (`getEntitlements`, `enforceFreeWorkspaceCapacity`, `assertWorkspaceAccessAllowed`, `syncPaidSeatQuantity`), `modules/ai/ai.access.ts` (`assertAiAccess`).
- Both layers converge in `shared/middleware/require-workspace.ts` — that's the one place a request always passes through before either role or plan checks run.
