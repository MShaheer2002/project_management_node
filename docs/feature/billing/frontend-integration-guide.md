# Frontend Billing Integration Guide

## Purpose

This guide explains how the frontend should integrate with the implemented billing backend for workspace-based Stripe billing.

Use this guide as the source of truth for:

- plan selection during onboarding
- workspace billing screens
- card management
- subscription upgrades and downgrades
- invoice listing
- payment confirmation
- error handling
- fallback and recovery flows

Billing is always tied to a `workspace`, not to a user account.

## Plans

The frontend must present these plans:

- `FREE`
- `STANDARD`
- `PREMIUM`

Current pricing:

- `FREE` = `$0`
- `STANDARD` = `$6 / seat / month`
- `PREMIUM` = `$10 / seat / month`

Current product rules:

- `FREE`
  - all current non-AI features available
  - max `10` total accepted members + pending invites per workspace
  - storage limit `2 GB`
- `STANDARD`
  - unlimited users
  - no AI
  - storage limit `50 GB`
- `PREMIUM`
  - all `STANDARD` features
  - AI access when AI is released
  - unlimited storage

## Role Rules

Frontend billing UI must follow these role rules:

- `OWNER`
  - full billing access
  - can add cards
  - can switch default card
  - can upgrade, downgrade, cancel
  - can view invoices
- `ADMIN`
  - read-only billing access
  - can view subscription and invoices
  - cannot change cards
  - cannot change plans
- `MEMBER`
  - no billing access
- `GUEST`
  - no billing access

Frontend must not rely only on hidden buttons. Backend enforcement already exists. UI must still reflect the permissions clearly.

## Required Frontend Env

```env
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

The frontend must initialize Stripe with `VITE_STRIPE_PUBLISHABLE_KEY`.

## Workspace Context

All billing API calls must be sent for the active workspace.

Use:

```http
X-Workspace-Id: <workspace-id>
```

If the frontend supports workspace switching, all billing state must be re-fetched after the workspace changes.

## Backend Endpoints

### Read endpoints

- `GET /billing/subscription`
- `GET /billing/subscription/payment-status`
- `GET /billing/payment-methods`
- `GET /billing/invoices`

### Mutation endpoints

- `POST /billing/setup-intent`
- `POST /billing/payment-methods/attach`
- `PATCH /billing/payment-methods/default`
- `DELETE /billing/payment-methods/:id`
- `POST /billing/subscription/create`
- `PATCH /billing/subscription/change-plan`
- `POST /billing/subscription/cancel`

## Backend Source of Truth

The frontend must treat the backend as the final source of truth for:

- current plan
- effective access plan
- subscription status
- seat count
- proration state
- invoice state
- payment method default state

Do not permanently trust optimistic UI after a billing mutation. Always reconcile against:

- `GET /billing/subscription`
- `GET /billing/subscription/payment-status`

## Core Response Concepts

### Subscription overview

`GET /billing/subscription` returns the current billing state for the workspace, including:

- `plan`
- `accessPlan`
- `status`
- `billingCycle`
- `seatCount`
- `currentPeriodStart`
- `currentPeriodEnd`
- `cancelAtPeriodEnd`
- `entitlements`
- `permissions`
- `prorationNotice`

Important distinction:

- `plan` = selected Stripe subscription plan
- `accessPlan` = actual effective access the app should grant right now

If payment is incomplete or invalid, `plan` may be paid while `accessPlan` is effectively `FREE`.

Frontend must use `accessPlan` for feature gating.

### Payment status

`GET /billing/subscription/payment-status` exists for payment recovery and reconciliation.

It returns:

- `plan`
- `accessPlan`
- `status`
- `hasPaidAccess`
- `paymentIntentId`
- `paymentIntentStatus`
- `clientSecret`
- `requiresAction`
- `prorationNotice`

Use this endpoint after:

- page refresh during payment
- return from 3DS/SCA flow
- user leaving and coming back
- waiting for webhook completion

## Onboarding Flow

## Owner Sees Plan Selection

During owner onboarding, the frontend must show a plan selection step with:

- `FREE`
- `STANDARD`
- `PREMIUM`

The selected plan applies to the new workspace being created or configured.

### If owner selects `FREE`

1. Complete workspace onboarding without payment.
2. Fetch `GET /billing/subscription`.
3. Show Free plan details:
   - max `10` accepted members + pending invites
   - all current non-AI features
   - storage `2 GB`

### If owner selects `STANDARD` or `PREMIUM`

Recommended frontend order:

1. Ensure workspace exists and active workspace is selected.
2. Open card collection UI using Stripe Elements.
3. Call `POST /billing/setup-intent`.
4. Confirm card setup in Stripe.js.
5. Call `POST /billing/payment-methods/attach`.
6. Call `POST /billing/subscription/create`.
7. If response says `requiresAction`, confirm payment in Stripe.js.
8. Poll `GET /billing/subscription/payment-status` until stable.
9. Refresh `GET /billing/subscription`.
10. Only then unlock paid-plan UX.

## Recommended Upgrade Flow

When an owner upgrades from `FREE` to `STANDARD` or `PREMIUM`:

1. Open upgrade modal or pricing screen.
2. If no default card exists, collect one first.
3. Call `POST /billing/subscription/create` if there is no Stripe paid subscription yet.
4. Otherwise call `PATCH /billing/subscription/change-plan`.
5. Inspect the response:
   - if `requiresAction = false`, still re-fetch billing state
   - if `requiresAction = true`, complete Stripe confirmation flow
6. Poll `GET /billing/subscription/payment-status`.
7. Refresh `GET /billing/subscription`.
8. Update UI only from reconciled backend state.

## Free Limit Enforcement Flow

For `FREE` workspaces, the backend blocks the `11th` accepted member or pending invite.

Frontend behavior must be:

1. user attempts to invite or add a member
2. backend returns `FREE_PLAN_MEMBER_LIMIT_REACHED`
3. block the action
4. show clear upgrade message
5. open upgrade CTA for `STANDARD` or `PREMIUM`

Recommended message:

`Free workspaces support up to 10 members and pending invites combined. Upgrade to continue adding users.`

Do not silently fail and do not leave the invite modal in an ambiguous state.

## Seat Billing Behavior

Paid billing is per workspace and per accepted member seat.

Seat count rules:

- `FREE`
  - cap uses accepted members + pending invites
- paid plans
  - Stripe seat quantity tracks accepted members
  - pending invites do not create paid seats

Frontend should communicate this clearly in billing UI.

Recommended paid-plan note:

`You are billed for accepted workspace members. Pending invites are not charged until accepted.`

## Proration Behavior

Stripe handles proration automatically when paid seat count changes mid-cycle.

Example:

- June 1: workspace on `STANDARD` with `11` accepted members
- June 1 charge: `11 x $6 = $66`
- June 15: `10` more accepted members added
- total becomes `21`
- Stripe calculates prorated charge for the remaining part of the month
- July 1 full-cycle base becomes `21 x $6 = $126`

The prorated amount may:

- be charged immediately
- or appear on the next invoice

Frontend must not calculate or display a hard-coded charge as final truth. Use backend messaging and Stripe-confirmed invoice state.

If `prorationNotice` is returned, show it in billing UI near the plan summary and upgrade confirmation.

## Payment Method Integration

## Add Card Flow

Recommended frontend order:

1. Render Stripe Elements card form.
2. Call `POST /billing/setup-intent`.
3. Use returned client secret to confirm card setup with Stripe.js.
4. After Stripe confirms setup, call `POST /billing/payment-methods/attach`.
5. Refresh `GET /billing/payment-methods`.

The app supports multiple saved cards.

Rules:

- multiple cards can be saved
- one card is the default payment method
- new cards are not automatically assumed to be default unless backend marks them so

### Card list UI

`GET /billing/payment-methods` should be rendered as safe metadata only, such as:

- brand
- last4
- expiry month
- expiry year
- default state

Do not build UI that depends on raw Stripe payment method IDs being displayed to the user.

### Switch default card

1. user selects another saved card
2. call `PATCH /billing/payment-methods/default`
3. refresh `GET /billing/payment-methods`
4. refresh `GET /billing/subscription` if needed

### Remove card

1. user selects remove
2. call `DELETE /billing/payment-methods/:id`
3. handle backend rejection if card is still required
4. refresh `GET /billing/payment-methods`

## Payment Confirmation Flow

This is the most important frontend billing flow.

When calling:

- `POST /billing/subscription/create`
- `PATCH /billing/subscription/change-plan`

the response may include:

- `clientSecret`
- `paymentIntentId`
- `requiresAction`

### If `requiresAction = false`

1. show temporary processing state
2. call `GET /billing/subscription/payment-status`
3. then call `GET /billing/subscription`
4. update final UI from backend response

### If `requiresAction = true`

1. call Stripe.js confirmation using the returned `clientSecret`
2. handle possible 3DS/SCA redirect or modal
3. after Stripe returns control, call `GET /billing/subscription/payment-status`
4. if still processing, poll for a short period
5. once payment status is stable, call `GET /billing/subscription`
6. unlock paid UI only when backend state confirms it

### Required fallback after refresh

If the page reloads during payment:

1. reload workspace context
2. call `GET /billing/subscription/payment-status`
3. if `requiresAction = true` and `clientSecret` is still available, resume confirmation UI
4. if paid access is already active, refresh normal subscription screen
5. if payment failed, show retry UI

This is why `GET /billing/subscription/payment-status` exists. The frontend should not depend on in-memory state for billing confirmation.

## Polling Strategy

Use short polling only for payment reconciliation.

Recommended polling cases:

- immediately after create subscription
- immediately after change plan
- after 3DS/SCA confirmation returns
- after page reload during payment

Recommended approach:

- poll `GET /billing/subscription/payment-status` every `2-3` seconds
- stop after `30-60` seconds
- if state stabilizes earlier, stop immediately
- then fetch `GET /billing/subscription`

Do not leave endless polling loops running.

## Feature Gating

Frontend feature visibility must use `accessPlan`, not only `plan`.

Examples:

- if `plan = STANDARD` but payment is incomplete, treat the workspace as Free for access control
- if `plan = PREMIUM` but `hasPaidAccess = false`, do not unlock Premium-only UX

This matters for:

- AI entry points
- user capacity messaging
- storage messaging
- premium upgrade banners

## Admin Read-Only Behavior

When the active user is `ADMIN`:

- show billing summary
- show invoices
- hide or disable all mutation actions

Do not show interactive card-management or plan-change controls for admins.

Recommended UI treatment:

- visible but disabled controls are acceptable if clearly labeled
- fully hidden controls are also acceptable
- the screen must still communicate that only the owner can make billing changes

## Invoice UI

Use `GET /billing/invoices` to render the invoice list.

Recommended invoice fields to show:

- invoice date
- amount
- status
- hosted invoice link if available
- PDF link if available

Use invoice list as the source of truth for completed and failed billing history. Do not try to reconstruct billing history from subscription responses.

## Error Handling

## General Rule

Billing errors must be handled with explicit UI states.

Do not use one generic message for every failure.

Frontend should map known backend error codes into user-facing actions.

## Important Billing Errors

### `FREE_PLAN_MEMBER_LIMIT_REACHED`

Meaning:

- Free workspace hit the `10` accepted + pending limit

Frontend action:

- block invite/add action
- show upgrade prompt
- route user to `STANDARD` or `PREMIUM`

### `BILLING_NO_DEFAULT_PAYMENT_METHOD`

Meaning:

- owner tried to create or change a paid subscription without a usable default card

Frontend action:

- open add-card flow
- explain that a default payment method is required

### `BILLING_ALREADY_ON_PLAN`

Meaning:

- user selected the same plan they already have

Frontend action:

- keep the current screen
- show a non-destructive informational message

### `PAYMENT_METHOD_NOT_FOUND`

Meaning:

- selected saved card is missing or no longer available

Frontend action:

- refresh payment methods
- ask user to choose another card or add a new one

### `PAYMENT_METHOD_IN_USE`

Meaning:

- attempted card removal is not allowed in the current state

Frontend action:

- tell user to switch default card or add another valid card first

### `SUBSCRIPTION_NOT_FOUND`

Meaning:

- workspace does not have the expected subscription record

Frontend action:

- refresh billing overview
- if still missing, show support-oriented error state

### `BILLING_UNKNOWN_PRICE_ID`

Meaning:

- Stripe returned a price that backend config does not recognize

Frontend action:

- show a blocking billing configuration error
- do not guess the plan
- instruct user to contact support

This is an operational issue and should not be masked as a normal payment failure.

## Payment Failures

If payment fails during create or plan change:

- do not grant paid UI
- keep workspace access aligned to `accessPlan`
- show retry option
- allow owner to:
  - retry same action
  - switch default card
  - add new card

Recommended message:

`Payment could not be completed. Your workspace billing was not upgraded. Try another card or retry the payment.`

## SCA / Requires Action State

If backend says `requiresAction = true`:

- show a clear payment confirmation state
- do not show success yet
- do not unlock paid features yet
- start Stripe confirmation flow immediately

If user closes or abandons the flow:

- keep billing screen in pending state
- use `GET /billing/subscription/payment-status` on return
- allow retry

## Webhook Delay Fallback

Stripe webhooks are asynchronous. The frontend must expect short delays between Stripe confirmation and final backend state.

If Stripe says confirmation succeeded but backend still shows processing:

1. show `Payment processing`
2. poll `GET /billing/subscription/payment-status`
3. refresh `GET /billing/subscription`
4. stop once stable

Do not treat webhook delay as payment failure too early.

## Network Failure Fallback

If frontend loses network during billing actions:

1. keep the user on the billing screen
2. show that billing state is being rechecked
3. once network returns, call:
   - `GET /billing/subscription/payment-status`
   - `GET /billing/subscription`
4. continue from backend truth

This is especially important after Stripe confirmation flows.

## Safe Fallback Rules

When frontend is uncertain, use these fallback rules:

- if current billing state cannot be confirmed, do not unlock paid features
- if payment is pending, show processing state
- if payment failed, show retry state
- if workspace access is Free, enforce Free UI restrictions immediately
- if backend and local UI disagree, trust backend

## Recommended Screen States

The billing screen should explicitly support these states:

- loading
- free active
- paid active
- payment method required
- payment requires action
- payment processing
- payment failed
- canceled at period end
- admin read-only
- hard configuration error

Making these states explicit will reduce edge-case bugs significantly.

## Suggested Frontend Flow Summary

### First load

1. fetch `GET /billing/subscription`
2. fetch `GET /billing/payment-methods` if user can access billing
3. fetch `GET /billing/invoices` for owner/admin invoice screen

### Add card

1. `POST /billing/setup-intent`
2. confirm in Stripe.js
3. `POST /billing/payment-methods/attach`
4. refresh methods

### Upgrade or change plan

1. submit create or change endpoint
2. if `requiresAction`, confirm in Stripe.js
3. call `GET /billing/subscription/payment-status`
4. poll if needed
5. refresh `GET /billing/subscription`
6. update UI from final backend state

### Retry after interruption

1. `GET /billing/subscription/payment-status`
2. if still requires action, resume
3. if paid confirmed, fetch subscription overview
4. if failed, show retry

## Implementation Notes

- use Stripe Elements for card entry
- never store card details in your own frontend state beyond Stripe Elements usage
- never infer success from Stripe modal completion alone
- always reconcile with backend after payment
- always gate features by `accessPlan`
- always send `X-Workspace-Id`

## Final Frontend Standard

The frontend billing integration is correct only if it does all of the following:

- supports workspace-scoped billing
- supports owner-only billing mutations
- supports admin read-only billing
- blocks Free workspaces at `10` accepted + pending users
- prompts upgrade on the `11th` add/invite attempt
- handles multiple saved cards with one default
- handles Stripe `requiresAction` flows
- recovers after refresh or navigation loss
- waits for backend truth before granting paid access
- uses `accessPlan` for feature gating
- displays proration as informational, not as frontend-calculated source of truth
