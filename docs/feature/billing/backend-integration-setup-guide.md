# Phase 13 Backend Integration Setup Guide (Billing)

> This guide defines how to implement billing for Trussen in a production-grade way.
> It follows the project rules: `Route -> Middleware -> Controller -> Service -> DB`.
> Stripe is the billing provider. Billing is workspace-scoped, seat-based for paid plans, and webhook-backed.

Related docs:

- [billing-requirements-understanding.md](./billing-requirements-understanding.md)
- [billing-scope.md](./billing-scope.md)
- [stripe-setup-guide.md](./stripe-setup-guide.md)
- [rules.md](../../setup/rules.md)
- [build-phases.md](../../setup/build-phases.md)

---

## 1. Product Rules You Must Implement

These are the final business rules this phase must satisfy.

### Plans

- `FREE`
  - `$0`
  - max `10` total of accepted members + pending invites
  - `2 GB` storage
  - all current non-AI features
  - AI disabled

- `STANDARD`
  - `$6 / seat / month`
  - unlimited members
  - `50 GB` storage
  - all Free features
  - AI disabled

- `PREMIUM`
  - `$10 / seat / month`
  - unlimited members
  - unlimited storage
  - all Standard features
  - AI enabled

### Workspace billing rules

- billing belongs to the workspace
- one user can own multiple workspaces
- each workspace has independent billing state
- each workspace can have its own:
  - Stripe customer
  - subscription
  - cards
  - invoices
  - seat count
  - limits

### Role rules

- `OWNER`
  - full billing control

- `ADMIN`
  - view billing only

- `MEMBER`
  - no billing access

- `GUEST`
  - no billing access

### Seat rules

- bill paid seats based on accepted workspace members
- pending invites do not count as paid Stripe seats
- pending invites do count toward the Free plan `10`-capacity cap

### Proration rule

- when accepted member count changes on a paid workspace:
  - recalculate seat count
  - update Stripe subscription quantity
  - let Stripe handle proration

### UX notice rule

The billing UI must show a note similar to:

`Seat changes during the billing period may create prorated charges or credits on the current or next invoice.`

---

## 2. What This Phase Must Deliver

Backend deliverables:

1. Prisma billing schema updates
2. Billing module routes/controller/service/schemas
3. Stripe service integration
4. Stripe webhook handler
5. Free-plan invite enforcement
6. Seat sync on membership changes
7. Plan entitlement resolver
8. Read-only billing access for admins
9. Full billing control for owners
10. API contract the frontend can build against

---

## 3. Required Prerequisites

Complete or working before Phase 13:

- Phase 1 auth
- Phase 2 workspace membership and `requireWorkspace`
- workspace invitations
- workspace roles
- at least one stable place where member acceptance/removal happens
- Stripe account configured in sandbox mode

Required env vars:

```env
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_STANDARD_MONTHLY_PRICE_ID=price_xxx
STRIPE_PREMIUM_MONTHLY_PRICE_ID=price_xxx
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_xxx
CLIENT_URL=http://localhost:3000
API_URL=http://localhost:8000
```

Important:

- `STRIPE_STANDARD_MONTHLY_PRICE_ID` must be a `price_...` ID
- `STRIPE_PREMIUM_MONTHLY_PRICE_ID` must be a `price_...` ID
- do not use `prod_...` values in those env vars

---

## 4. Module Structure

Create:

```txt
modules/billing/
├── billing.routes.ts
├── billing.controller.ts
├── billing.service.ts
├── billing.schemas.ts
└── webhook.handler.ts
```

Optional helper files only if needed and justified:

```txt
modules/billing/
├── stripe.service.ts
├── billing-entitlements.ts
└── billing.repository.ts
```

Use a repository file only if query complexity becomes real. Do not add it by default.

---

## 5. Route-Level Permission Model

Do not use one blanket permission for all billing routes.

### Owner-only routes

- `POST /billing/subscription/create`
- `PATCH /billing/subscription/change-plan`
- `POST /billing/subscription/cancel`
- `POST /billing/setup-intent`
- `POST /billing/payment-methods/attach`
- `PATCH /billing/payment-methods/default`
- `DELETE /billing/payment-methods/:id`

Middleware chain:

- `authenticate`
- `requireWorkspace`
- `requireRole("OWNER")`
- `validate(...)`

### Owner + Admin read-only routes

- `GET /billing/subscription`
- `GET /billing/payment-methods`
- `GET /billing/invoices`

Middleware chain:

- `authenticate`
- `requireWorkspace`
- `requireRole("ADMIN", "OWNER")`
- `validate(...)`

### Public webhook

- `POST /webhooks/stripe`

No auth middleware.
Webhook must verify Stripe signature internally.

---

## 6. Prisma Schema Changes

Do not invent parallel billing tables if existing models already exist.
Extend the current billing models to support the real Stripe flow.

### Stripe IDs to persist

#### Required for Phase 13

- `stripeCustomerId`
- `stripeSubscriptionId`
- `stripePriceId`
- `stripePaymentMethodId`
- `stripeEventId`

#### Strongly recommended

- `stripeSubscriptionItemId`
- `stripeInvoiceId`
- `stripePaymentIntentId`

#### Optional

- `stripeSetupIntentId`
- `stripeProductId`

Recommended interpretation:

- `stripeCustomerId`, `stripeSubscriptionId`, `stripePriceId`, and `stripePaymentMethodId` are core runtime identifiers
- `stripeEventId` is needed for webhook idempotency
- `stripeSubscriptionItemId` makes quantity and plan updates much safer for seat billing
- `stripeInvoiceId` makes invoice reconciliation and support easier
- `stripePaymentIntentId` helps trace first-payment and invoice-payment attempts
- `stripeSetupIntentId` is useful for deeper audit/debugging, but not required for normal billing flow
- `stripeProductId` is not operationally necessary if the app uses `price_...` IDs as the source of truth

### What needs Stripe dashboard setup vs what comes automatically

Needs Stripe dashboard setup:

- Standard product
- Premium product
- Standard monthly price
- Premium monthly price
- webhook endpoint
- test/live API keys

Comes automatically from Stripe objects/events and should be stored by backend:

- `stripeCustomerId`
- `stripeSubscriptionId`
- `stripeSubscriptionItemId`
- `stripeInvoiceId`
- `stripePaymentIntentId`
- `stripePaymentMethodId`
- `stripeSetupIntentId`

Important:

- you do not manually create or configure `stripeInvoiceId` in the dashboard
- Stripe generates invoice IDs like `in_...` automatically
- your backend should store them from webhook payloads or Stripe API responses
- you do not manually create or configure `stripePaymentIntentId` either
- Stripe generates it during actual payment attempts
- you do not need to persist `stripeProductId` in DB unless you want it for reporting or support tooling

### Subscription model

Keep the project naming pattern and extend it for Stripe-backed subscriptions.

Recommended fields:

- `id`
- `workspaceId`
- `plan`
- `status`
- `billingCycle`
- `currentPeriodStart`
- `currentPeriodEnd`
- `cancelAtPeriodEnd`
- `seatCount`
- `storageUsedBytes` (BigInt, default 0) — cached total storage usage in bytes
- `stripeCustomerId`
- `stripeSubscriptionId`
- `stripeSubscriptionItemId`
- `stripePriceId`
- `createdAt`
- `updatedAt`

Recommended constraints:

- unique `workspaceId` on subscription
- unique `stripeSubscriptionId` if not null
- index `workspaceId`
- index `stripeCustomerId`

### Invoice model

Recommended additions:

- `subscriptionId`
- `stripeInvoiceId`
- `hostedInvoiceUrl`
- keep `pdfUrl`

### PaymentMethod model

Recommended additions:

- `updatedAt`
- `isActive` or `detachedAt`
- unique `stripePaymentMethodId` if not null

Note:

- `stripePaymentIntentId` and `stripeSetupIntentId` are recommended identifiers to retain somewhere in the billing domain for tracing/debugging
- they do not have to live on the `PaymentMethod` table
- if you store them, put them where they match your actual flow:
  - billing event log
  - payment attempt record
  - setup-intent audit record

### Webhook event storage

Add a lightweight table for idempotency and auditability.

Recommended fields:

- `id`
- `stripeEventId`
- `type`
- `workspaceId`
- `processed`
- `payload`
- `createdAt`

Reason:

- prevents double-processing
- helps debugging
- preserves billing event history

---

## 7. Schema Enum Direction

Use final plan names:

- `FREE`
- `STANDARD`
- `PREMIUM`

Subscription status should be able to represent at least:

- `ACTIVE`
- `TRIALING`
- `PAST_DUE`
- `CANCELED`
- `INCOMPLETE`
- `UNPAID`

If you prefer a narrower internal enum, document the Stripe-to-app mapping explicitly in service code and docs.

---

## 8. Workspace Creation and Initial Subscription State

Every new workspace must get a billing record immediately.

### Owner onboarding billing screen

Owner onboarding should include a billing plan selection step.

Required behavior:

1. owner signs up
2. owner creates workspace
3. owner sees billing plan selection screen
4. owner chooses one of:
   - `FREE`
   - `STANDARD`
   - `PREMIUM`

Expected onboarding choices:

- `FREE`
  - continue without immediate Stripe subscription
  - workspace starts on Free entitlement

- `STANDARD`
  - require card setup
  - create Stripe customer if missing
  - create Stripe subscription with current accepted seat count

- `PREMIUM`
  - require card setup
  - create Stripe customer if missing
  - create Stripe subscription with current accepted seat count

Important:

- this screen is for the workspace owner
- billing selection is workspace-scoped, not user-scoped
- one owner may repeat this flow across multiple workspaces, each with separate billing

### Free workspace creation

When a user creates a workspace without choosing a paid plan:

1. create `Workspace`
2. create owner `WorkspaceMembership`
3. create `Subscription` row with:
   - `plan = FREE`
   - `status = ACTIVE`
   - `seatCount = 1`
   - no Stripe subscription IDs yet

This must happen in one transaction.

### Direct Standard/Premium start

If onboarding supports starting on Standard or Premium immediately:

1. create workspace
2. create owner membership
3. create initial free/local billing row if needed
4. save payment method
5. create Stripe customer
6. create Stripe subscription with quantity equal to current accepted member count
7. wait for webhook-backed final status

Do not mark the workspace as paid based only on frontend input.

### Free plan capacity behavior during onboarding and growth

Expected flow:

1. owner starts on `FREE`
2. workspace can grow normally until accepted members + pending invites reaches `10`
3. when owner attempts to invite or add the 11th person:
   - backend must block the action
   - UI should show upgrade prompt/CTA
   - prompt should offer `STANDARD` and `PREMIUM`

Required user-facing meaning:

- Free workspace cannot exceed 10 total accepted + pending seats
- the 11th add/invite is not queued silently
- the action is rejected clearly and immediately

Suggested UI message:

`Your Free workspace supports up to 10 members and pending invites combined. Upgrade to Standard or Premium to add more users.`

---

## 9. Plan Entitlement Resolver

Implement one backend-owned entitlement resolver.

Recommended output shape:

```ts
type WorkspaceEntitlements = {
  plan: "FREE" | "STANDARD" | "PREMIUM";
  aiEnabled: boolean;
  storageLimitBytes: number | null;
  memberInviteCap: number | null;
  paidSeatBilling: boolean;
};
```

Expected values:

- `FREE`
  - `aiEnabled = false`
  - `storageLimitBytes = 2 GB`
  - `memberInviteCap = 10`
  - `paidSeatBilling = false`

- `STANDARD`
  - `aiEnabled = false`
  - `storageLimitBytes = 50 GB`
  - `memberInviteCap = null`
  - `paidSeatBilling = true`

- `PREMIUM`
  - `aiEnabled = true`
  - `storageLimitBytes = null`
  - `memberInviteCap = null`
  - `paidSeatBilling = true`

This resolver should be the source of truth for:

- invite limit logic
- AI guard logic
- billing API responses
- future storage guard logic

---

## 10. Billing API Contract

Implement these endpoints.

### `GET /billing/subscription`

Access:

- `OWNER`
- `ADMIN`

Return:

- plan
- status
- billing cycle
- current period start/end
- cancel-at-period-end
- seat count
- limits
- AI enabled
- storage limit
- proration notice text for UI

### `POST /billing/subscription/create`

Access:

- `OWNER`

Input:

```json
{
  "plan": "STANDARD" | "PREMIUM",
  "billingCycle": "MONTHLY"
}
```

Behavior:

1. ensure workspace is eligible for paid subscription creation
2. ensure default payment method exists
3. create Stripe customer if missing
4. count accepted members
5. create Stripe subscription with `payment_behavior: "default_incomplete"` and quantity = accepted member count
6. persist preliminary Stripe IDs
7. return `clientSecret` and `requiresAction: true` to the frontend

Important:

- `default_incomplete` means Stripe does NOT auto-charge the card
- the frontend MUST call `stripe.confirmCardPayment(clientSecret)` to complete the payment
- this is required for SCA/3DS compliance (mandatory in EU)
- without frontend confirmation, the subscription stays `incomplete` and auto-cancels after ~23 hours
- after the frontend confirms payment, Stripe fires `invoice.paid` and `customer.subscription.updated` webhooks
- the webhook handler updates subscription status to `ACTIVE` and saves the invoice to the database

Do not change `payment_behavior` to `error_if_incomplete` or remove `default_incomplete`. The `default_incomplete` + frontend confirmation pattern is the Stripe-recommended production approach.

### `PATCH /billing/subscription/change-plan`

Access:

- `OWNER`

Behavior:

1. ensure workspace has an active paid subscription
2. choose the target Stripe price
3. keep quantity in sync with accepted member count
4. update Stripe subscription item with `expand: ["latest_invoice.payment_intent"]`
5. return `clientSecret` and `requiresAction` if proration invoice needs payment confirmation
6. let webhook finalize the stored state

Important:

- plan changes may generate a proration invoice with a payment intent
- if the proration amount requires payment, the response includes `clientSecret`
- the frontend must call `stripe.confirmCardPayment(clientSecret)` to complete the proration payment
- the same payment confirmation flow used for subscription creation applies here

### `POST /billing/subscription/cancel`

Access:

- `OWNER`

Behavior:

1. set Stripe `cancel_at_period_end`
2. keep paid access until current period end
3. after expiration, entitlement returns to Free

### `POST /billing/setup-intent`

Access:

- `OWNER`

Behavior:

1. create Stripe customer if missing
2. create SetupIntent
3. return `clientSecret`

### `GET /billing/payment-methods`

Access:

- `OWNER`
- `ADMIN`

Return only safe metadata.

### `POST /billing/payment-methods/attach`

Access:

- `OWNER`

Behavior:

1. attach payment method to Stripe customer
2. store safe metadata in DB
3. if first usable card, mark as default

### `PATCH /billing/payment-methods/default`

Access:

- `OWNER`

Behavior:

1. verify payment method belongs to workspace
2. update default in Stripe
3. update default in DB

### `DELETE /billing/payment-methods/:id`

Access:

- `OWNER`

Behavior:

1. verify payment method belongs to workspace
2. block removal if it is the only usable default for an active paid subscription
3. detach/archive safely

### `GET /billing/invoices`

Access:

- `OWNER`
- `ADMIN`

Return:

- invoice number
- amount
- currency
- status
- issuedAt
- paidAt
- hosted invoice URL
- PDF URL if present

---

## 11. Stripe Customer Strategy

Use one Stripe customer per workspace.

Do not use one customer per user.

Recommended metadata on Stripe customer:

- `workspaceId`
- `workspaceSlug`
- `ownerUserId`

Reason:

- easier support/debugging
- better reconciliation between Stripe and app DB

---

## 12. Multiple Card Strategy

The app must support multiple cards per workspace.

Rules:

- owner can save multiple cards
- exactly one card is default
- default card is used for subscription billing
- admin can view card metadata but cannot modify cards
- member and guest cannot access billing pages

Safe card metadata only:

- `stripePaymentMethodId`
- `brand`
- `last4`
- `expiryMonth`
- `expiryYear`
- `isDefault`

Do not store raw PAN or CVC.

---

## 13. Free Plan Invite Enforcement

This is a hard backend rule.

Before creating a new invitation:

1. load workspace subscription plan
2. if plan is not `FREE`, skip cap check
3. count accepted workspace members
4. count pending invitations
5. if `accepted + pending >= 10`, reject

Return a clear error:

`Free plan supports up to 10 workspace members and pending invites combined. Upgrade to Standard or Premium to continue.`

Important:

- this must run in backend service logic
- frontend gating alone is not enough

---

## 14. Seat Count Calculation

Create one internal function:

```ts
countBillableSeats(workspaceId): Promise<number>
```

For Phase 13, recommended rule:

- count accepted workspace members only
- include all accepted roles:
  - `OWNER`
  - `ADMIN`
  - `MEMBER`
  - `GUEST`

Reason:

- simple
- predictable
- avoids special-case seat confusion

If business rules later exclude guests, change the seat-count function only, not the whole billing module.

---

## 15. Seat Sync Triggers

Seat sync must happen on real membership changes.

Required triggers:

- invitation accepted -> member added
- owner/admin removes a member
- any future membership activation/deactivation behavior
- paid upgrade where initial accepted member count becomes Stripe quantity

Recommended implementation pattern:

1. membership workflow completes successfully
2. recalculate seat count
3. if workspace plan is paid and Stripe subscription exists:
   - update Stripe quantity
4. persist latest seat count in DB

This update should happen after the membership mutation commits successfully.

If needed, wrap the recalculation and subscription update in a retry-safe background task later, but Phase 13 can start synchronously if response time stays acceptable.

---

## 15b. Storage Tracking

Storage usage is tracked per workspace using a cached `storageUsedBytes` column on the `Subscription` model.

### Storage limits by plan

- `FREE` — 2 GB
- `STANDARD` — 50 GB
- `PREMIUM` — unlimited

### How storage is tracked

The `storageUsedBytes` column is a running total that is incremented and decremented as attachments are created and deleted.

Update triggers:

- **Increment** on:
  - issue attachment creation (inline during issue create/update, or via add attachments endpoint)
  - comment attachment creation (inline during comment create/update, or via add attachments endpoint)
- **Decrement** on:
  - issue attachment deletion
  - comment attachment deletion

The cached value avoids repeated `SUM(size)` aggregation queries across attachment tables.

### Storage enforcement

Storage limits are enforced at the presigned URL generation endpoint — the single gateway for all S3 uploads.

Before generating a presigned URL:

1. read `storageUsedBytes`, `plan`, and `status` from the Subscription record (single query)
2. determine the effective plan's storage limit
3. if `currentUsage + requestedFileSize > limit`, reject with `STORAGE_LIMIT_EXCEEDED`

Premium workspaces skip the check entirely.

### Billing overview

`GET /billing/subscription` returns `storageUsedBytes` alongside entitlements so the frontend can display a storage usage bar.

### Backfill

When adding the `storageUsedBytes` column, run a backfill migration that calculates the initial value from existing `IssueAttachment` and `CommentAttachment` records.

---

## 16. Proration Behavior

Do not calculate proration in application code.

### Required behavior

If owner paid initially for `11` accepted users and later adds `2` accepted users mid-cycle:

1. new seat count becomes `13`
2. backend updates Stripe quantity from `11` to `13`
3. Stripe computes the prorated charge for the remaining days in the billing period
4. Stripe reflects that charge/credit according to subscription proration rules

The same applies in reverse for seat decreases.

### Explicit example for this product

Scenario:

- workspace owner upgrades to `STANDARD`
- date: `June 1`
- accepted members at upgrade time: `11`
- first full-cycle charge: `11 * $6 = $66`

Then:

- date: `June 15`
- owner adds `10` more accepted members
- new accepted seat count becomes `21`

Backend behavior:

1. accepted member count changes
2. backend recalculates billable seats
3. backend updates Stripe subscription quantity from `11` to `21`
4. Stripe calculates prorated billing for the 10 newly added seats for the remaining days in the period

Expected billing meaning:

- next full monthly base on `July 1` becomes `21 * $6 = $126`
- the extra 10 seats added on `June 15` may create a prorated adjustment for the remainder of June
- that prorated amount may:
  - be charged immediately
  - or appear on the next invoice
- this depends on Stripe billing/proration behavior and subscription settings

Important:

- do not hardcode a separate app-side formula as the source of truth
- Stripe remains the billing source of truth for proration math
- backend responsibility is to keep quantity accurate and timely

### Important product note

Billing API response should include a user-facing note:

`Seat changes during the billing period may create prorated charges or credits on the current or next invoice.`

This note should be shown on:

- billing overview
- upgrade/change-plan UI
- member management UI when workspace is on a paid plan

---

## 17. Webhook Requirements

Route:

- `POST /webhooks/stripe`

Required events:

- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- `payment_method.attached`
- `payment_method.detached`

Webhook responsibilities:

1. verify signature
2. reject invalid signatures
3. ensure idempotency by `stripeEventId`
4. load workspace by Stripe identifiers
5. update subscription state
6. update payment method state if needed
7. insert/update invoice records if needed
8. persist event log

Webhook is the final source of truth for:

- plan
- status
- current period
- cancel-at-period-end
- invoice payment state

Never trust frontend-only billing status.

---

## 18. Service Breakdown

Recommended service functions:

- `getBillingOverview(workspaceId)`
- `createSubscription(workspaceId, ownerUserId, input)`
- `changePlan(workspaceId, ownerUserId, input)`
- `cancelSubscription(workspaceId, ownerUserId)`
- `createSetupIntent(workspaceId, ownerUserId)`
- `listPaymentMethods(workspaceId)`
- `attachPaymentMethod(workspaceId, ownerUserId, paymentMethodId)`
- `setDefaultPaymentMethod(workspaceId, ownerUserId, paymentMethodId)`
- `removePaymentMethod(workspaceId, ownerUserId, paymentMethodId)`
- `listInvoices(workspaceId)`
- `syncPaidSeatQuantity(workspaceId)`
- `resolveEntitlements(workspaceId)`
- `handleStripeWebhook(signature, rawBody)`

Keep Stripe-specific code isolated so the rest of the module stays readable.

---

## 19. Validation Rules

`billing.schemas.ts` should validate:

- route params
- allowed plan transitions
- payment method IDs
- route body shapes

Examples:

- do not allow creating `FREE` through Stripe subscription create route
- do not allow unsupported billing cycles
- do not allow empty payment method IDs
- do not allow plan changes to the same plan if you want to avoid no-op mutations

Use Zod only.

---

## 20. Error Handling Rules

Use project-standard `AppError`.

Recommended billing error cases:

- `BILLING_FORBIDDEN`
- `BILLING_OWNER_REQUIRED`
- `SUBSCRIPTION_NOT_FOUND`
- `PAYMENT_METHOD_NOT_FOUND`
- `PAYMENT_METHOD_IN_USE`
- `FREE_PLAN_MEMBER_LIMIT_REACHED`
- `STRIPE_CUSTOMER_MISSING`
- `STRIPE_SUBSCRIPTION_MISSING`
- `STRIPE_WEBHOOK_INVALID_SIGNATURE`
- `BILLING_ALREADY_ON_PLAN`
- `BILLING_NO_DEFAULT_PAYMENT_METHOD`

Avoid vague Stripe passthrough messages in API responses.
Log Stripe raw details internally if needed.

---

## 21. Read Model for Billing Page

Build the `GET /billing/subscription` response so frontend does not need to derive business logic itself.

Recommended response content:

```json
{
  "success": true,
  "data": {
    "plan": "STANDARD",
    "status": "ACTIVE",
    "billingCycle": "MONTHLY",
    "seatCount": 11,
    "currentPeriodStart": "2026-06-01T00:00:00.000Z",
    "currentPeriodEnd": "2026-07-01T00:00:00.000Z",
    "cancelAtPeriodEnd": false,
    "entitlements": {
      "aiEnabled": false,
      "memberInviteCap": null,
      "storageLimitBytes": 53687091200
    },
    "permissions": {
      "canViewBilling": true,
      "canManageBilling": false
    },
    "prorationNotice": "Seat changes during the billing period may create prorated charges or credits on the current or next invoice."
  }
}
```

For admin users:

- `canViewBilling = true`
- `canManageBilling = false`

For owner users:

- `canViewBilling = true`
- `canManageBilling = true`

---

## 22. Membership Module Integration Points

You must touch the workspace membership/invitation logic during this phase.

Required integration points:

### Invite creation

- enforce Free cap before creating invite

### Invite acceptance

- after member creation:
  - recalculate seat count
  - sync Stripe quantity if plan is paid

### Member removal

- after removal:
  - recalculate seat count
  - sync Stripe quantity if plan is paid

Do not duplicate membership logic inside the billing module.
Billing should integrate with existing membership services cleanly.

---

## 23. Testing Matrix

At minimum, test these scenarios.

### Plan creation

- new workspace starts on Free
- new workspace can later upgrade to Standard
- new workspace can later upgrade to Premium
- onboarding direct paid start works if supported

### Permissions

- owner can view billing
- owner can mutate billing
- admin can view billing
- admin cannot mutate billing
- member cannot access billing
- guest cannot access billing

### Free cap

- Free workspace can invite until accepted + pending reaches `10`
- next invite is blocked
- Standard/Premium workspace is not blocked by the `10` cap

### Seats

- paid seat count equals accepted member count
- pending invites do not affect paid seat count
- invite acceptance updates quantity
- member removal updates quantity

### Cards

- owner can add first card
- owner can add second card
- owner can switch default
- owner cannot remove only default card on active paid subscription without replacement
- admin can list cards but cannot mutate

### Proration

- upgrading paid workspace starts with correct quantity
- adding members mid-cycle updates quantity
- removing members mid-cycle updates quantity
- proration notice exists in billing overview response

### Webhooks

- valid signature accepted
- invalid signature rejected
- duplicate event ignored safely
- subscription update event updates DB
- invoice paid event updates invoice state
- payment failed event updates subscription/invoice state

---

## 24. Recommended Implementation Order

Use this order to reduce risk.

1. finalize Prisma billing schema changes
2. run migration
3. add env validation
4. create billing module skeleton
5. implement read-only billing overview
6. implement SetupIntent + payment method storage
7. implement subscription creation
8. implement plan change and cancel flows
9. implement webhook handler
10. integrate Free invite cap
11. integrate seat sync on membership changes
12. add tests
13. verify full sandbox flow with Stripe CLI

---

## 25. Production Readiness Notes

Do not ship this phase until all of these are true:

- webhook signature verification is implemented
- webhook idempotency is implemented
- owner/admin permissions are correct
- no raw card data is stored
- Free workspace cap is enforced in backend
- paid seat sync runs on membership changes
- Stripe quantity reflects accepted member count
- billing overview exposes proration notice
- one workspace cannot read or mutate another workspace billing
- owner with multiple workspaces sees isolated billing state per workspace

---

## 26. Final Engineering Standard

The success criteria for this phase are:

- a workspace can exist on Free, Standard, or Premium
- all accepted members in that workspace receive workspace access according to workspace role and workspace plan
- Free cannot exceed 10 accepted + pending capacity through backend invite flows
- owner can control billing for each workspace independently
- admin can view billing but cannot modify it
- multiple cards are supported with one default card
- paid seat quantity stays synchronized with accepted workspace member count
- Stripe handles proration for mid-cycle seat changes
- the UI gets a clean notice explaining prorated charges/credits
- the implementation is safe under multi-workspace ownership
