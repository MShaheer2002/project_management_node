# Linearis Billing — Requirements Understanding

## Purpose

This document captures the current intended billing behavior for Phase 13 based on the latest product decisions. It is not trying to preserve the generic wording from older billing notes. It follows the project model: workspace-based billing, Stripe-backed subscriptions, and plan-based feature access.

---

## Core Business Model

- Billing belongs to the `workspace`, not an individual user.
- The paying entity is the workspace owner.
- All members inside the workspace inherit the workspace plan.
- A user does not buy a personal subscription.
- Stripe is the billing provider.
- Billing is seat-based for paid plans.
- One owner can have multiple workspaces.
- Each workspace has its own separate billing state, subscription, cards, invoices, and limits.

---

## Final Plan Model

### Free

- Price: `$0`
- Max workspace capacity: `10`
- Storage: `2 GB`
- Capacity rule counts:
  - active workspace members
  - pending workspace invitations
- All current non-AI product features remain available on free.
- AI is not available.

### Standard

- Price: `$6 / seat / month`
- Unlimited workspace members
- Storage: `50 GB`
- Includes everything in Free
- AI is not available

### Premium

- Price: `$10 / seat / month`
- Unlimited workspace members
- Storage: unlimited
- Includes everything in Standard
- AI is available

---

## Feature Entitlement Model

The app UI and backend behavior must depend on the workspace subscription plan.

### Free

- All current core app features are available
- AI features are blocked
- Member/invite limit of `10` is enforced
- Storage limit of `2 GB` is enforced

### Standard

- Same product features as Free
- No member limit
- AI features are blocked
- Storage limit of `50 GB` is enforced

### Premium

- Same product features as Standard
- AI features are enabled
- Storage is unlimited

Important clarification:

- We are **not** removing cycles, roadmap, or other current app features from Free.
- The only Free restrictions for now are:
  - no AI
  - max 10 active + pending seats per workspace
  - 2 GB storage limit

---

## AI Scope by Plan

AI will be integrated later, but billing must already support gating for it.

Premium should eventually unlock all three AI categories:

1. AI system help
   - Explains app areas and what features do

2. AI writing assistance
   - Helps write issue descriptions, bug details, acceptance criteria, and similar content

3. MCP-driven action execution
   - User instructs the system to perform actions and the MCP server executes them

Plan rule:

- `FREE` -> AI disabled
- `STANDARD` -> AI disabled
- `PREMIUM` -> AI enabled

---

## Workspace Seat Rules

### What a seat means

A seat represents a billable workspace member on a paid plan.

### Recommended billable seat definition

For paid plans, bill seats based on accepted workspace members, not pending invitations.

Recommended billable roles:

- `OWNER`
- `ADMIN`
- `MEMBER`
- `GUEST`

Reason:

- It keeps the rule simple and predictable.
- Every accepted workspace member consumes capacity and receives plan access.

If the product later wants non-billable guests, that should be a separate business decision. For Phase 13, the safer rule is: every accepted workspace member is a billable seat on paid plans.

### Free plan capacity rule

For Free, capacity enforcement is different from paid seat billing:

- count accepted workspace members
- count pending invitations
- if combined total is `>= 10`, block new invites

This prevents a free workspace from bypassing the cap by sending many pending invites.

---

## Stripe Billing Model

### Billing type

- Stripe subscription
- monthly recurring billing
- quantity-based seat billing for paid plans

### Stripe mapping

- Stripe Customer = workspace billing identity
- Stripe Subscription = workspace paid subscription
- Stripe Subscription Item Quantity = current billable seat count
- Stripe PaymentMethod = saved card for the workspace
- Stripe Invoice = billing record
- Stripe Webhook = source of truth for final billing state

### Paid plans

- Standard uses the Standard Stripe price ID
- Premium uses the Premium Stripe price ID

### Free plan

- No Stripe subscription is required while the workspace stays on Free

---

## Seat Billing Flow

### Upgrade from Free to Standard/Premium

Example:

- Workspace has `11` accepted members
- User upgrades to Standard
- Stripe quantity should be set to `11`
- Charge should be:
  - `11 * $6 = $66` for Standard
  - `11 * $10 = $110` for Premium

### When seats increase mid-cycle

Example:

- Premium = `$10 / seat / month`
- June 1: workspace starts Premium with `11` seats
- Stripe charges `11 * 10 = 110`
- June 15: workspace grows to `23` seats

Backend behavior:

1. Count current billable seats
2. Update Stripe subscription quantity to `23`
3. Let Stripe handle proration

Expected Stripe result:

- Stripe computes the prorated charge for the remaining period
- That extra amount may be charged immediately or reflected on the next invoice depending on Stripe settings

### When seats decrease mid-cycle

Example:

- Workspace has `23` seats
- Mid-cycle it drops to `13`

Backend behavior:

1. Count current billable seats
2. Update Stripe subscription quantity to `13`
3. Let Stripe handle proration or credit behavior

Recommended direction:

- Use Stripe proration handling instead of building custom seat math

---

## Proration Decision

Recommended Phase 13 approach:

- Enable Stripe quantity updates for seat changes
- Let Stripe handle prorations and credits
- Do not manually calculate partial-month billing in application code

Reason:

- This is the standard SaaS model
- It is simpler and less error-prone
- Stripe already solves seat-based proration

Operational rule:

- Whenever a member is accepted into a paid workspace, recalculate seat count and sync Stripe quantity
- Whenever a member is removed from a paid workspace, recalculate seat count and sync Stripe quantity

---

## Payment Method Requirements

The workspace can save multiple cards.

### Why multiple cards are required

- User may want to switch the default paying card later
- Future billing flexibility depends on storing more than one payment method

### Rules

- Allow multiple saved cards per workspace
- One card is marked as default
- Default card is used for subscription billing
- Only the owner can add a card
- Only the owner can change the default card
- Only the owner can remove a non-default card
- Do not allow removal of the only usable default card if the workspace has an active paid subscription and no replacement exists

### Security rule

Never store raw:

- card number
- CVC
- full expiry input as sensitive raw data

Store only safe metadata, such as:

- `stripePaymentMethodId`
- `brand`
- `last4`
- `expiryMonth`
- `expiryYear`
- `isDefault`

Frontend card entry must use Stripe Elements.

---

## Subscription Lifecycle Rules

### Free workspace

- Starts on `FREE`
- No card required
- No Stripe subscription required

### Upgrade to Standard or Premium

- Requires a saved/default card
- Create Stripe Customer if missing
- Create Stripe Subscription
- Set Stripe quantity to current billable seat count
- The workspace can start directly on Standard or Premium during onboarding if the owner completes payment successfully

### Plan change

- Standard -> Premium: switch Stripe price and keep quantity in sync
- Premium -> Standard: switch Stripe price and keep quantity in sync

### Cancel paid subscription

- Cancel at period end
- Keep paid access until `currentPeriodEnd`
- After expiration, move workspace entitlement back to Free

### Failed payment

- Stripe webhook updates billing status
- Workspace may remain in warning/past-due state briefly
- Final downgrade rules should be driven by webhook-backed subscription status, not frontend assumptions

---

## Access Control Rules

Billing access is role-based and intentionally strict.

### Billing permissions

- `OWNER`
  - full billing control
  - can view billing
  - can add/remove cards
  - can switch default card
  - can create subscription
  - can upgrade or downgrade plan
  - can cancel subscription

- `ADMIN`
  - view billing only
  - can view current plan, seats, invoices, payment methods, and status
  - cannot add/remove cards
  - cannot switch default card
  - cannot create subscription
  - cannot change plan
  - cannot cancel subscription

- `MEMBER`
  - no billing access

- `GUEST`
  - no billing access

All billing routes must still use the standard project middleware chain:

- `authenticate`
- `requireWorkspace`
- `requireRole(...)` with route-specific role rules

---

## Backend Enforcement Rules

### Free invite limit

Before sending an invitation:

1. load workspace subscription/entitlement
2. count accepted workspace members
3. count pending invitations
4. if plan is Free and total is already `>= 10`, reject invite

Suggested error message:

`Free plan supports up to 10 workspace members and pending invites combined. Upgrade to Standard or Premium to continue.`

### AI guard

Before any AI route/action:

1. load workspace subscription plan
2. if plan is not `PREMIUM`, block access

Suggested rule:

- only `PREMIUM` may access AI endpoints or AI-triggered background jobs

### Paid seat sync

After membership-affecting events in paid workspaces:

- invitation accepted
- member removed
- owner/admin membership changes that affect active member count

System should:

1. recalculate billable seat count
2. update Stripe subscription quantity

### Member access by workspace plan

- every accepted member in a workspace gets access to that workspace
- what they can see/use depends on:
  - their workspace role
  - the workspace subscription plan
- billing is never personal
- entitlements are always resolved from the active workspace

---

## Frontend Billing UI Understanding

The Billing page should reflect workspace-level billing, not user-level billing.

### Main sections

1. Current Plan
   - plan name
   - status
   - renewal date
   - current seat count
   - cancel-at-period-end state
   - proration notice when seat count changes mid-cycle

2. Plans
   - Free
   - Standard
   - Premium
   - clear seat-based pricing explanation for paid plans

3. Payment Methods
   - list all saved cards
   - show default card
   - add card
   - set default card
   - remove card

4. Invoices
   - invoice date
   - amount
   - status
   - invoice download link

### Important UI behavior

- Free users should still see that all non-AI features are included
- Paid plan messaging should emphasize:
  - unlimited users
  - billed per active seat
- Storage limits should be visible in the plan comparison:
  - Free: `2 GB`
  - Standard: `50 GB`
  - Premium: unlimited
- Premium messaging should emphasize future AI access
- Admin users should see billing in read-only mode
- Owner users should see all billing management actions
- When seat count changes mid-cycle, the UI should show a note that Stripe may apply prorated charges or credits on the current or next invoice

---

## Product and Schema Changes Needed

The older scope/schema was generic and not fully Stripe-specific. It should be updated where needed, but stable parts should stay as-is.

### Must change

- Plan definitions in docs and schema:
  - `FREE`
  - `STANDARD`
  - `PREMIUM`
- Pricing references:
  - Standard = `$6`
  - Premium = `$14`
- Billing model must explicitly support:
  - Stripe customer
  - Stripe subscription
  - Stripe price ID
  - Stripe quantity
  - multiple payment methods
  - webhook-driven state updates
  - seat-based proration via Stripe

Environment clarification:

- backend secret key should be `STRIPE_SECRET_KEY`
- frontend publishable key should be `VITE_STRIPE_PUBLISHABLE_KEY`
- monthly plan env vars must store Stripe `price_...` IDs, not `prod_...` product IDs

### Keep if already useful

- workspace-based billing ownership
- safe payment method metadata pattern
- invoice storage concept
- webhook idempotency concept
- project naming conventions
- standard middleware and module architecture

---

## Open Implementation Decisions

These still need a final engineering choice when Phase 13 implementation starts:

1. Whether to store:
   - `stripePriceId`
   - `stripeSubscriptionItemId`
   - `seatCount`
   directly on the subscription model

2. Whether invoice records should also store:
   - Stripe invoice ID
   - hosted invoice URL
   - PDF URL

3. Whether payment methods need:
   - `updatedAt`
   - `isActive` or `detachedAt`

4. Whether webhook events should be stored in:
   - a dedicated billing event log table
   - or a lightweight processed-event table for idempotency

5. Whether downgrading from paid to free should be blocked if current accepted member count is already above `10`, or whether the workspace can downgrade but becomes unable to invite/remove inconsistently until under limit

Recommended answer for item 5:

- allow downgrade to Free
- do not delete users
- block further invitations
- show over-limit warning until accepted member count returns to `10` or below

---

## Summary

This is the intended billing behavior for Linearis:

- workspace-based billing
- `FREE`, `STANDARD`, `PREMIUM`
- Free keeps all current non-AI features
- Free limit is `10` accepted + pending capacity
- Free storage limit is `2 GB`
- Standard is `$6 / seat / month`
- Standard storage limit is `50 GB`
- Premium is `$10 / seat / month`
- Premium storage is unlimited
- Premium alone unlocks AI
- paid plans bill by workspace seat count
- Stripe quantity changes should handle proration
- multiple workspace cards must be supported
- backend and frontend feature visibility must depend on plan
