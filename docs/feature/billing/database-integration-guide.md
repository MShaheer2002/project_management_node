# Billing Database Integration Guide

> This document explains the database/schema changes made for Phase 13 billing,
> which columns were added, and why each change exists.

Related files:

- [schema.prisma](/Users/admin/Documents/project_management/project_management_node/prisma/schema.prisma)
- [20260602120000_phase13_billing_stripe/migration.sql](/Users/admin/Documents/project_management/project_management_node/prisma/migrations/20260602120000_phase13_billing_stripe/migration.sql)
- [billing.service.ts](/Users/admin/Documents/project_management/project_management_node/modules/billing/billing.service.ts)

---

## 1. Why The Schema Changed

The existing schema had generic billing support, but it was not enough for:

- workspace-scoped Stripe subscriptions
- seat-based billing
- Stripe price tracking
- Stripe subscription item quantity updates
- invoice reconciliation
- webhook idempotency
- multiple saved cards with active/default state

Phase 13 adds the minimum persistent fields needed to support real Stripe billing behavior.

---

## 2. Enum Changes

### `SubscriptionPlan`

Changed:

- `PLUS` -> `PREMIUM`

Why:

- product decision is now `FREE`, `STANDARD`, `PREMIUM`
- docs, backend logic, and pricing now use Premium instead of Plus

### `SubscriptionStatus`

Added:

- `INCOMPLETE`
- `UNPAID`

Why:

- Stripe subscriptions can exist before first successful payment completes
- Stripe may also move subscriptions into unpaid state
- the app needs enough status fidelity to avoid pretending everything is simply active/canceled

---

## 3. `Subscription` Model Changes

### Added column: `seatCount`

Type:

- `Int`

Why:

- stores the current accepted-member seat count for the workspace
- used for billing overview
- lets backend persist the last known billed quantity

### Added column: `stripeSubscriptionItemId`

Type:

- `String?`

Why:

- Stripe seat-based subscriptions are updated through the subscription item
- quantity changes are safer and cleaner when the app stores the subscription item ID
- needed for plan updates and seat sync on member changes

### Added column: `stripePriceId`

Type:

- `String?`

Why:

- identifies which Stripe `price_...` is currently backing the subscription
- allows backend to map workspace plan to actual Stripe price
- helps webhook reconciliation and plan change logic

### Added constraint: unique `workspaceId`

Why:

- this app uses one billing subscription record per workspace
- prevents multiple local subscription rows for the same workspace

### Added constraint: unique `stripeSubscriptionId`

Why:

- prevents duplicate local rows pointing at the same Stripe subscription

---

## 4. `Invoice` Model Changes

### Added column: `subscriptionId`

Type:

- `String?`

Why:

- links local invoices back to the owning workspace subscription row
- useful for invoice history and future reporting

### Added column: `stripeInvoiceId`

Type:

- `String?`

Why:

- Stripe generates invoice IDs automatically, such as `in_...`
- backend stores this ID from webhook/API responses
- needed for invoice reconciliation and support/debugging

Important:

- nothing special is required in the Stripe dashboard to get this value
- Stripe creates it automatically

### Added column: `hostedInvoiceUrl`

Type:

- `String?`

Why:

- supports frontend “view invoice” links directly to Stripe-hosted invoice pages

### Added index: `subscriptionId`

Why:

- useful for invoice lookups by subscription

### Added constraint: unique `stripeInvoiceId`

Why:

- one Stripe invoice should map to one local invoice record

---

## 5. `PaymentMethod` Model Changes

### Added column: `isActive`

Type:

- `Boolean`

Why:

- detached cards should not remain treated as usable cards
- allows soft deactivation instead of hard-delete-only behavior
- needed when Stripe sends `payment_method.detached`

### Added column: `updatedAt`

Type:

- `DateTime`

Why:

- tracks latest local mutation of the saved card record
- useful when default card changes or detach state changes

### Added constraint: unique `stripePaymentMethodId`

Why:

- one Stripe payment method should map to one local payment method record
- prevents duplicate card rows for the same Stripe object

---

## 6. New `BillingWebhookEvent` Model

New table:

- `BillingWebhookEvent`

Columns:

- `id`
- `stripeEventId`
- `type`
- `workspaceId`
- `processed`
- `payload`
- `createdAt`

Why it exists:

- Stripe webhooks can be retried
- backend must be idempotent
- storing the Stripe event ID prevents double-processing
- raw payload persistence helps debugging production billing issues

### `stripeEventId`

Why:

- the main idempotency key from Stripe

### `processed`

Why:

- lets the app know whether a received event has already been handled successfully

### `payload`

Why:

- preserves the full event payload for support, debugging, and replay analysis

### `workspaceId`

Why:

- links the billing event to the affected workspace when the app can resolve it

---

## 7. Workspace Lifecycle Integration

### Workspace creation

Change:

- each new workspace now gets an initial `Subscription` row

Why:

- every workspace needs a known billing state from day one
- default state is:
  - `plan = FREE`
  - `status = ACTIVE`
  - `seatCount = 1`

This avoids “missing subscription row” branching throughout billing logic.

### Invitation creation

Change:

- before creating an invite, backend checks Free plan capacity

Why:

- Free is capped at `10` accepted + pending seats combined
- the rule must be enforced server-side

### Invitation acceptance / member removal

Change:

- accepted member count now syncs into billing

Why:

- paid seat count is based on accepted members
- Stripe subscription quantity must stay aligned with real workspace membership

---

## 8. Stripe IDs Now Stored or Used

### Required runtime IDs

- `stripeCustomerId`
- `stripeSubscriptionId`
- `stripeSubscriptionItemId`
- `stripePriceId`
- `stripePaymentMethodId`
- `stripeEventId`

### Strongly recommended runtime IDs

- `stripeInvoiceId`

Why:

- this app now treats Stripe as the billing source of truth
- these IDs make webhook reconciliation, seat syncing, invoices, and support possible

---

## 9. What Comes Automatically From Stripe

These values are not manually configured in the dashboard.
They are generated by Stripe objects and returned through API/webhook flows.

Examples:

- `stripeCustomerId`
- `stripeSubscriptionId`
- `stripeSubscriptionItemId`
- `stripeInvoiceId`
- `stripePaymentMethodId`

For example:

- `stripeInvoiceId` comes from Stripe invoice objects
- the backend stores it from webhook events such as `invoice.paid` or `invoice.payment_failed`

---

## 10. Why `price_...` Matters More Than `prod_...`

This integration uses Stripe prices as the operational billing identifier.

Environment variables used by backend:

- `STRIPE_STANDARD_MONTHLY_PRICE_ID`
- `STRIPE_PREMIUM_MONTHLY_PRICE_ID`

These must contain:

- `price_...`

Not:

- `prod_...`

Why:

- the actual recurring amount and billing interval live on the Stripe Price
- subscriptions are created against prices, not products

---

## 11. Migration Notes

The Phase 13 migration was added as:

- [20260602120000_phase13_billing_stripe/migration.sql](/Users/admin/Documents/project_management/project_management_node/prisma/migrations/20260602120000_phase13_billing_stripe/migration.sql)

Practical note:

- `prisma migrate dev` could not be used directly because an older applied migration in the repo had been modified
- the safe path was:
  - update schema
  - generate Prisma client
  - add the Phase 13 migration file manually
  - apply it with `prisma migrate deploy`

This avoided a destructive local reset.

---

## 12. Final Schema Outcome

After integration, the DB now supports:

- one workspace subscription row per workspace
- Free/Standard/Premium plan state
- seat count persistence
- Stripe subscription item tracking
- Stripe invoice reconciliation
- multiple saved cards with active/default state
- webhook idempotency and event logging

That is the minimum production-grade persistence shape needed for this Stripe billing model.
