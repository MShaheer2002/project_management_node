I want to integrate Stripe billing into my Node.js + React project management SaaS app.

First understand the billing scope:

This is a workspace-based SaaS. Billing belongs to the workspace, not individual users. The workspace owner pays for the subscription. Once the workspace is upgraded to Standard or Premium, all members/employees inside that workspace get access to the workspace features according to the workspace plan.

One owner can have multiple workspaces. Each workspace must have its own independent billing state, cards, invoices, limits, and subscription.

Plans:

1. Free

* Price: $0
* Maximum 10 workspace members
* No AI features
* All current non-AI product features
* Invite limit must be enforced: workspace cannot have more than 10 active/pending invited users combined
* If the workspace already has 10 users/invites, block new invitations and show upgrade required

2. Standard

* Price: $6/user/month
* Unlimited workspace members
* No AI features
* All Free features

3. Premium

* Price: $10/user/month
* Unlimited workspace members
* AI features enabled
* All Standard features

Important rule:
Employees/members do not subscribe individually. The workspace plan controls what every member can access inside that workspace.

Required Stripe model:

* Stripe Customer = workspace billing identity
* Stripe PaymentMethod = saved card
* Stripe Price = plan price
* Stripe Subscription = recurring workspace subscription
* Stripe Invoice = monthly billing record
* Stripe Webhook = source of truth for subscription status

Use Stripe Elements on frontend for card UI. Do not build raw HTML card inputs that send card number/CVC/expiry to the backend. The backend must never store raw card details. Store only safe metadata:

* stripePaymentMethodId
* card brand
* last4
* expiry month
* expiry year
* isDefault

The old mobile app used a correct pattern:

* Create SetupIntent from backend
* Confirm card using Stripe UI
* Receive paymentMethodId
* Send only paymentMethodId to backend
* Backend saves card metadata and attaches it to customer

Now adapt that flow for web SaaS subscription billing instead of one-time wallet top-up.

Database design needed:

workspace_billing table/model:

* id
* workspaceId
* stripeCustomerId
* stripeSubscriptionId
* stripePriceId
* plan: free | standard | premium
* status: active | incomplete | trialing | past_due | canceled | unpaid
* currentPeriodStart
* currentPeriodEnd
* cancelAtPeriodEnd
* createdAt
* updatedAt

workspace_payment_methods table/model:

* id
* workspaceId
* stripePaymentMethodId
* brand
* last4
* expMonth
* expYear
* isDefault
* isActive
* createdAt
* updatedAt

billing_events or webhook_logs table/model:

* id
* stripeEventId
* type
* workspaceId
* processed
* payload
* createdAt

Required backend APIs:

GET /billing/subscription

* Return current workspace billing state
* Include plan, status, current period, cancelAtPeriodEnd, limits, AI enabled status

POST /billing/subscription/create

* Owner only
* Body: { plan: "standard" | "premium", billingCycle: "monthly" }
* Create Stripe Customer if workspace does not already have one
* Create Stripe Subscription using correct Stripe priceId
* Return subscription/payment confirmation data needed by frontend

PATCH /billing/subscription/change-plan

* Owner only
* Body: { plan: "standard" | "premium" }
* Upgrade should apply immediately
* Downgrade can apply at period end
* Update Stripe subscription item price
* Do not trust frontend only; final DB update should come from webhook

POST /billing/subscription/cancel

* Owner only
* Cancel at period end
* Set cancelAtPeriodEnd true in Stripe
* Keep access until currentPeriodEnd

POST /billing/setup-intent

* Owner only
* Create Stripe Customer if missing
* Create SetupIntent for saving a card
* Return clientSecret

GET /billing/payment-methods

* Owner/admin view
* Return saved workspace cards
* Show only safe card metadata

POST /billing/payment-methods/attach

* Owner only
* Body: { paymentMethodId: "pm_xxx" }
* Attach payment method to Stripe customer
* Save safe metadata in DB
* If first card, mark default

PATCH /billing/payment-methods/default

* Owner only
* Body: { paymentMethodId: "pm_xxx" }
* Set payment method as default for Stripe customer/subscription
* Update DB default card

DELETE /billing/payment-methods/:id

* Owner only
* Detach/remove payment method
* Do not allow removing the only/default card if subscription is active unless another default card exists

GET /billing/invoices

* Owner/admin view
* Return workspace invoices from Stripe

POST /stripe/webhook

* Public Stripe webhook endpoint
* Verify Stripe signature
* Handle events:

  * customer.subscription.created
  * customer.subscription.updated
  * customer.subscription.deleted
  * invoice.paid
  * invoice.payment_failed
  * payment_method.attached
  * payment_method.detached
* Webhook should update workspace_billing status, plan, currentPeriodEnd, cancelAtPeriodEnd, and payment state

Access control rules:

Create a central feature/plan guard:

Free:

* maxMembers = 10
* aiEnabled = false
* unlimitedMembers = false

Standard:

* maxMembers = unlimited
* aiEnabled = false
* unlimitedMembers = true

Premium:

* maxMembers = unlimited
* aiEnabled = true
* unlimitedMembers = true

Invitation logic:
Before sending an invite:

1. Count active workspace members
2. Count pending workspace invites
3. If plan is free and activeMembers + pendingInvites >= 10, block invite
4. Return error:
   "Free plan supports up to 10 members. Upgrade to Standard or Premium to invite more people."

AI feature guard:
Before any AI endpoint/action:

1. Load workspace billing plan
2. If plan !== premium, block request
3. Return upgrade required response

Seat/proration logic:

* Paid plans are billed per accepted workspace member
* Pending invites do not increase Stripe seat quantity
* On member accept/remove in paid workspaces:
  * Recount accepted members
  * Update Stripe subscription quantity
  * Let Stripe handle proration/credits
* Show a billing note in UI explaining that mid-cycle seat changes may create prorated charges or credits on the current or next invoice

Subscription status guard:
If status is active or trialing:

* Allow paid features

If status is past_due:

* Optionally show warning/grace period
* Do not immediately destroy data

If status is canceled/unpaid:

* Downgrade workspace to free
* Enforce free limits
* Disable AI

Frontend Billing UI:

Billing page sections:

1. Current Plan

* Free / Standard / Premium
* Status
* Renewal date
* Cancel scheduled info

2. Plans

* Free: $0, up to 10 users, no AI
* Standard: $6/month, unlimited users, no AI
* Premium: $10/month, unlimited users, AI enabled

3. Payment Methods

* Card brand
* Last 4 digits
* Expiry
* Default badge
* Make default button
* Remove button
* Add new card button

4. Invoices

* Date
* Amount
* Status
* Download invoice link

Frontend Stripe flow:

Add Card:

* Call POST /billing/setup-intent
* Use Stripe Elements to collect card
* Confirm SetupIntent on frontend
* Get paymentMethodId
* Call POST /billing/payment-methods/attach
* Reload payment methods

Upgrade:

* Owner selects Standard/Premium
* If no card exists, ask to add card first
* Call POST /billing/subscription/create
* Confirm payment if required
* Show processing state
* Final plan/status should update from backend/webhook result

Change Plan:

* Call PATCH /billing/subscription/change-plan
* Show pending/success state
* Use backend state as source of truth

Cancel:

* Call POST /billing/subscription/cancel
* Show "Your plan remains active until [currentPeriodEnd]"

Security requirements:

* Only workspace owner can manage billing changes
* Workspace admin can view billing only
* Member and guest have no billing access
* Backend must verify workspace access using X-Workspace-Id or authenticated workspace context
* Never trust plan sent from frontend for feature access
* Never store raw card number, CVC, or full expiry as raw card input
* Always verify Stripe webhook signature
* Make webhook processing idempotent using stripeEventId
* Use Stripe price IDs from environment variables, not hardcoded dollar amounts

Environment variables needed:

* STRIPE_SECRET_KEY
* STRIPE_WEBHOOK_SECRET
* STRIPE_STANDARD_MONTHLY_PRICE_ID (`price_...`, not `prod_...`)
* STRIPE_PREMIUM_MONTHLY_PRICE_ID (`price_...`, not `prod_...`)
* VITE_STRIPE_PUBLISHABLE_KEY
* CLIENT_URL
* API_URL

Deliverables:

1. Backend architecture
2. Database schema/models
3. Stripe service layer
4. Billing controller/routes
5. Webhook handler
6. Plan/feature guard middleware
7. Invite limit enforcement
8. AI access enforcement
9. Frontend billing page flow
10. Error handling and edge cases
