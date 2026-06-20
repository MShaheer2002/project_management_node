# Stripe Setup Guide for Trussen

> This guide explains how to set up Stripe step by step for Phase 13 billing.
> It is written for this project: workspace billing, seat-based subscriptions, multiple cards, and webhook-driven sync.

Related docs:

- [billing-requirements-understanding.md](./billing-requirements-understanding.md)
- [billing-scope.md](./billing-scope.md)

---

## 1. What You Are Setting Up

For Trussen, Stripe will be used for:

- workspace-level billing
- saved cards
- recurring subscriptions
- seat-based billing
- invoices
- webhook updates
- local testing in sandbox mode

Trussen plan mapping:

- Free -> no Stripe subscription required
- Standard -> `$6 / seat / month`
- Premium -> `$10 / seat / month`

Important:

- Billing belongs to the workspace
- Paid seat count should come from accepted workspace members
- Stripe quantity should match current billable seat count
- One owner can have multiple workspaces and each workspace should map to its own Stripe billing state

---

## 2. Stripe Objects You Need

Before touching the dashboard, understand the minimum Stripe objects:

- `Customer`
  - one Stripe customer per workspace

- `Product`
  - Standard plan product
  - Premium plan product

- `Price`
  - monthly recurring Standard seat price
  - monthly recurring Premium seat price

- `Subscription`
  - created when a workspace upgrades to Standard or Premium

- `PaymentMethod`
  - saved cards attached to the workspace customer

- `Invoice`
  - created automatically by Stripe for subscription billing

- `Webhook endpoint`
  - Stripe sends subscription and invoice events here

---

## 3. Create a Stripe Account

1. Go to [Stripe Dashboard](https://dashboard.stripe.com/).
2. Create an account or sign in.
3. Complete the basic business profile only as much as needed for sandbox testing.
4. Keep Stripe in `sandbox` mode while building and testing.

Do not start with live mode.

---

## 4. Get Your API Keys

Open the Stripe Dashboard and go to the API keys page.

What you need:

- publishable key for frontend
- secret key for backend

Sandbox keys usually start with:

- `pk_test_`
- `sk_test_`

Live keys usually start with:

- `pk_live_`
- `sk_live_`

For this project, store these values in environment variables.

Recommended env vars:

```env
STRIPE_SECRET_KEY=sk_test_xxx
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_xxx
```

Do not commit keys into the repo.

---

## 5. Enable Test Mode

Make sure you are working in Stripe sandbox mode while configuring:

1. Open the Stripe Dashboard.
2. Verify you are viewing sandbox/test data.
3. Create products, prices, customers, and webhooks in sandbox first.

Important:

- sandbox and live mode have separate data
- sandbox products do not automatically appear in live mode
- sandbox webhook secrets and live webhook secrets are different

---

## 6. Create the Subscription Products

Go to Stripe `Product catalog`.

You need two products:

1. `Trussen Standard`
2. `Trussen Premium`

Suggested names:

- `Trussen Standard`
- `Trussen Premium`

Suggested descriptions:

- Standard: `Workspace subscription with unlimited users and no AI`
- Premium: `Workspace subscription with unlimited users and future AI access`

Do not create a Free product.

Free is managed inside your app, not as a paid Stripe subscription.

---

## 7. Create the Prices

For each product, create one recurring monthly price.

### Standard price

Create a recurring price with:

- pricing model: per unit
- amount: `$6`
- currency: `USD`
- billing period: `monthly`

### Premium price

Create a recurring price with:

- pricing model: per unit
- amount: `$10`
- currency: `USD`
- billing period: `monthly`

### Important seat billing rule

This project should use quantity-based recurring pricing.

That means:

- one Standard subscription item
- one Premium subscription item
- Stripe `quantity = current billable seat count`

Example:

- 11 paid seats on Standard
- quantity = `11`
- Stripe bills `11 * $6`

After creating each price, copy the Stripe price ID.

They look like:

- `price_...`

Save them in env vars:

```env
STRIPE_STANDARD_MONTHLY_PRICE_ID=price_xxx
STRIPE_PREMIUM_MONTHLY_PRICE_ID=price_xxx
```

Important:

- `STRIPE_STANDARD_MONTHLY_PRICE_ID` must contain a Stripe `price_...` ID
- `STRIPE_PREMIUM_MONTHLY_PRICE_ID` must contain a Stripe `price_...` ID
- do not put a `prod_...` product ID into those variables

---

## 8. Do Not Manually Create Subscriptions in the Dashboard for App Flow

You can create manual test subscriptions in Stripe if you want to explore the dashboard, but for Trussen the real app flow should create subscriptions through the backend.

Reason:

- the backend must decide workspace plan
- the backend must set seat quantity
- the backend must store Stripe customer and subscription IDs
- the backend must remain the source of truth for app behavior

Use the dashboard mainly for:

- configuring products
- configuring prices
- viewing customers
- viewing subscriptions
- viewing invoices
- viewing webhook deliveries

---

## 9. Configure Payment Methods

Trussen needs card saving for future recurring billing.

In Stripe, make sure card payments are enabled in payment method settings.

What the app should use:

- Stripe Elements on the frontend
- SetupIntent from the backend
- saved `PaymentMethod` attached to the Stripe customer

This is required because:

- users can save cards before upgrading
- users can keep multiple cards
- one card can be set as the default billing card
- only the workspace owner should be allowed to mutate saved cards

---

## 10. Configure the Save-Card Flow

Your app flow should be:

1. backend creates Stripe customer if missing
2. backend creates SetupIntent
3. frontend opens Stripe Elements
4. user enters card details in Stripe UI
5. frontend confirms setup
6. Stripe returns a payment method
7. backend stores safe metadata only

Safe metadata to store:

- `stripePaymentMethodId`
- `brand`
- `last4`
- `expiryMonth`
- `expiryYear`
- `isDefault`

Do not store:

- full card number
- CVC
- raw card input

Recommended env var:

```env
STRIPE_SETUP_INTENT_USAGE=off_session
```

That value does not need to be an env var if you prefer it hardcoded in backend logic.

---

## 11. Add Consent Text for Saved Cards

Before saving payment methods, your UI should include billing consent text.

Minimum meaning your UI should communicate:

- card will be stored for future subscription charges
- workspace owner authorizes recurring billing
- amount depends on plan and active seat count
- customer can cancel according to your billing policy

This matters because Stripe’s guidance for saving cards for future off-session charges expects explicit customer consent.

---

## 12. Configure Webhooks

Trussen should expose:

- `POST /webhooks/stripe`

This endpoint should be public and should verify the Stripe signature.

### Create the webhook in Stripe

1. Open Stripe Dashboard.
2. Go to `Webhooks`.
3. Create a new endpoint.
4. Endpoint URL should point to your backend route.

For local dev, you usually do not create a public Stripe dashboard webhook first.
You normally test locally with the Stripe CLI.

For deployed environments, create real webhook endpoints.

### Events to subscribe to

Start with:

- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- `payment_method.attached`
- `payment_method.detached`

You may later add more events if implementation needs them.

### Get the signing secret

After creating the webhook endpoint, Stripe gives a signing secret.

It looks like:

- `whsec_...`

Store it in env:

```env
STRIPE_WEBHOOK_SECRET=whsec_xxx
```

Important:

- test webhook secret and live webhook secret are different
- never use the publishable or secret API key as the webhook secret

---

## 13. Recommended Environment Variables

Minimum recommended env vars for this project:

```env
STRIPE_SECRET_KEY=sk_test_xxx
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_STANDARD_MONTHLY_PRICE_ID=price_xxx
STRIPE_PREMIUM_MONTHLY_PRICE_ID=price_xxx
CLIENT_URL=http://localhost:3000
API_URL=http://localhost:8000
```

Likely useful later:

```env
STRIPE_STANDARD_PRODUCT_ID=prod_xxx
STRIPE_PREMIUM_PRODUCT_ID=prod_xxx
```

These product IDs are optional if your backend only relies on price IDs.

---

## 14. Install the Stripe SDK

Backend:

```bash
npm install stripe
```

Frontend:

```bash
npm install @stripe/stripe-js @stripe/react-stripe-js
```

You need:

- `stripe` for Node backend
- `@stripe/stripe-js` and `@stripe/react-stripe-js` for Elements on React frontend

---

## 15. Set Up Local Webhook Testing with Stripe CLI

Stripe CLI is the easiest way to test webhook delivery locally.

### Install the CLI

Install the Stripe CLI from Stripe’s official docs for your OS.

### Log in

```bash
stripe login
```

This opens a browser and connects the CLI to your Stripe account.

### Forward events to your backend

If your backend webhook route is:

- `http://localhost:8000/webhooks/stripe`

run:

```bash
stripe listen --forward-to localhost:8000/webhooks/stripe
```

Stripe CLI will print a webhook signing secret for the local forwarding session.

Use that secret in local env:

```env
STRIPE_WEBHOOK_SECRET=whsec_xxx
```

Important:

- this CLI forwarding secret is for local testing
- it is different from a deployed dashboard webhook secret

### Trigger test events

In another terminal:

```bash
stripe trigger invoice.paid
stripe trigger invoice.payment_failed
```

You can also use the CLI while running your own subscription actions in the app and inspect the forwarded events.

---

## 16. Understand How Subscription Charging Works

For Trussen, paid billing should work like this:

### First charge

When a workspace upgrades from Free to Standard or Premium:

1. backend creates Stripe customer if missing
2. backend creates Stripe subscription
3. backend sets subscription item quantity to current billable seat count
4. Stripe creates the first invoice
5. payment succeeds or requires action
6. webhook confirms final state

Important behavior from Stripe:

- creating a subscription creates an invoice
- if the first payment succeeds, the subscription becomes active
- if payment fails, Stripe can leave it incomplete

Your app should trust webhook-confirmed state.

---

## 17. Understand Seat Quantity

Paid billing should use Stripe quantity.

Example:

- Standard plan
- 11 accepted members
- quantity = `11`
- monthly total = `11 * $6 = $66`

You do not create 11 separate subscriptions.

You create:

- one customer for the workspace
- one subscription
- one subscription item
- quantity equal to seat count

---

## 18. Understand Proration

When quantity changes during the billing period, Stripe can prorate automatically.

Example:

- Premium = `$10 / seat / month`
- workspace starts month with `11` seats
- later grows to `23` seats

Backend should:

1. recount billable seats
2. update Stripe subscription quantity
3. let Stripe calculate proration

Important Stripe rule:

- changing quantity can trigger proration

Recommended approach for Trussen:

- let Stripe handle seat prorations
- do not manually calculate partial month charges in app code
- show a clear UI note that mid-cycle member changes may create prorated charges or credits on the current or next invoice

If later you want immediate billing for seat increases, that becomes a backend subscription-update choice.

---

## 19. Test Cards and Test Payments

In sandbox mode, do not use real cards.

Use Stripe test payment methods.

At minimum, test these cases:

1. successful card setup
2. successful subscription payment
3. failed payment
4. card update / default card change
5. seat increase
6. seat decrease
7. cancel at period end

Practical test flow:

1. create a workspace on Free
2. add members until over 10 total accepted + pending
3. verify invite blocking
4. save a card through Stripe Elements
5. upgrade to Standard
6. verify Stripe customer created
7. verify Stripe subscription created with correct quantity
8. add another accepted member
9. verify quantity update and proration behavior
10. trigger or simulate invoice/payment webhook events

---

## 20. Sandbox Checklist

Before coding against live money, confirm all of this in sandbox:

- API keys are loaded from env
- Standard and Premium prices exist
- price IDs are copied correctly
- card payments are enabled
- SetupIntent works
- cards save successfully
- multiple cards can be stored
- default card can be changed
- subscription can be created
- seat quantity is correct
- seat changes update quantity
- webhooks are received and verified
- invoices are visible in Stripe
- failed payment path is handled

Do not switch to live mode until this is stable.

---

## 21. Live Mode Checklist

When sandbox is fully working:

1. switch Stripe Dashboard to live mode
2. create live products
3. create live prices
4. copy live price IDs
5. copy live API keys
6. create live webhook endpoint
7. copy live webhook secret
8. update production env vars
9. verify HTTPS webhook endpoint is reachable
10. run a small real payment test if business setup allows it

Remember:

- live mode data is separate from sandbox data
- you must recreate products, prices, and webhook config in live mode

---

## 22. Recommended Stripe Dashboard Layout for This Project

Keep this simple:

### Products

- `Trussen Standard`
- `Trussen Premium`

### Prices

- Standard monthly: `$6`
- Premium monthly: `$10`

### Customers

- one customer per workspace

### Subscriptions

- one active paid subscription per paying workspace

### Webhooks

- one endpoint per environment:
  - local via CLI forwarding
  - staging
  - production

---

## 23. Common Mistakes to Avoid

- creating a Free Stripe subscription
- storing raw card details in your DB
- hardcoding Stripe keys in source code
- mixing test and live keys
- mixing test and live webhook secrets
- manually calculating seat prorations when Stripe can handle them
- creating one subscription per user instead of one per workspace
- trusting frontend plan state instead of webhook-confirmed backend state
- forgetting to update quantity when member count changes
- manually changing Stripe dashboard data and assuming local DB will update without webhook sync

---

## 24. What You Need Ready Before Implementation Starts

You are ready to start coding when all of these exist:

- Stripe account
- sandbox API keys
- Standard product
- Premium product
- Standard monthly price ID
- Premium monthly price ID
- Stripe CLI installed
- local webhook forwarding working
- test webhook secret copied into env

---

## 25. Official Stripe References Used

I verified this guide against Stripe’s official docs:

- API keys: https://docs.stripe.com/keys
- Save payment methods / SetupIntent: https://docs.stripe.com/payments/save-and-reuse?client=react&platform=web&ui=elements
- Subscription overview: https://docs.stripe.com/billing/subscriptions/overview
- Quantities for per-seat billing: https://docs.stripe.com/billing/subscriptions/quantities
- Prorations: https://docs.stripe.com/billing/subscriptions/prorations
- Webhook local testing: https://docs.stripe.com/webhooks/test
- Stripe CLI: https://docs.stripe.com/stripe-cli/overview
- Per-seat pricing setup: https://docs.stripe.com/subscriptions/pricing-models/per-seat-pricing
