# Stripe billing: where it stands

Last checked: 2026-10-03, against `dev`.

**Short version:** the main billing flow is built and works in Stripe **test mode**. Before taking real money, a few things must be fixed. One of them lets a workspace get Premium without fully paying, and one overcharges when a user is offboarded. The frontend billing page also has two issues.

---

## 1. How billing works today

- Billing belongs to the **workspace**, not the person. The owner pays, and every member gets that workspace's plan.
- Plans:

  | Plan | Price | Limits |
  |---|---|---|
  | Free | $0 | 10 members (members + pending invites), 2 teams, Slack only, no AI, 2 GB storage |
  | Standard | $6 per member per month | no member or team limit, all integrations, no AI, 50 GB |
  | Premium | $10 per member per month | everything, AI on, unlimited storage |

- **Seats** = number of workspace members. Stripe is told the new count whenever someone joins or is removed.
- Card flow: the backend creates a SetupIntent, then Stripe Elements collects the card in the browser. Only the `paymentMethodId` reaches our backend. We store brand, last 4 digits and expiry, never card numbers.
- Stripe sends **webhooks** to `POST /webhooks/stripe`. They update the plan, status, invoices and cards in our database.
- Only the **owner** can change billing. Admins can view it.

Main files:
- `modules/billing/billing.service.ts`: all billing logic
- `modules/billing/billing.routes.ts`: the API routes
- `modules/billing/stripe.service.ts`: the Stripe client
- `modules/billing/webhook.handler.ts`: the webhook endpoint
- Frontend: `src/pages/BillingPage.tsx` (react repo)

---

## 2. What is done and working

- [x] Plans, prices (from env price ids) and plan limits (entitlements)
- [x] Free plan limits: members + invites, teams, integrations
- [x] Paid features only while the status is ACTIVE, TRIALING or PAST_DUE. An unpaid INCOMPLETE subscription counts as Free (audit F-29, fixed).
- [x] A workspace that falls back to Free with more than 10 members: only the owner plus the first 10 members keep access. Nobody is deleted.
- [x] Save card (SetupIntent), list cards, set the default card, remove a card (blocked if it is the only card on a paid plan)
- [x] Start a subscription, change plan, cancel. Unpaid subscriptions cancel right away; paid ones cancel at the end of the period.
- [x] 3-D Secure / "requires action" payments, with a page that checks the payment status
- [x] Seat count synced to Stripe when an invite is accepted or a member is removed
- [x] Webhook signature check, raw body set up correctly, every event stored once (duplicates skipped)
- [x] Invoices saved from Stripe (number, amount, status, PDF link)
- [x] Workspace delete and restore: renewal stops on delete, comes back on restore, and the subscription and customer are removed on purge (F-35)
- [x] Webhooks for already deleted workspaces no longer fail and retry forever
- [x] Billing routes are owner or admin only, as listed above

---

## 3. What must be fixed

### Must fix before real payments (money is wrong)

| # | Problem (simple) | Where | Fix |
|---|---|---|---|
| 1 | **Premium for less than full price (audit N-11).** When an owner upgrades, our database switches to the new plan straight away, but Stripe only adds the price difference to the *next* invoice. If the owner then cancels, the subscription ends at the period end and that next invoice may never be created. They used Premium without paying the difference. | `changePlan`, `cancelSubscription` | **Upgrades:** charge the difference immediately (`proration_behavior: "always_invoice"`) and only switch the plan once that payment succeeds (`payment_behavior: "pending_if_incomplete"`). **Downgrades:** take effect at the end of the paid period. Confirm in test mode. Then update the "Switch between Standard and Premium" section of `content/help/billing-and-payments.md`, which describes today's behavior. |
| 2 | **Offboarding a user doesn't lower seats.** Deleting a user removes them from all their workspaces, but Stripe is not told, so those workspaces keep paying for that seat. | `modules/auth/auth.service.ts` (user delete) | After removing the memberships, sync seats for every affected workspace (`syncPaidSeatQuantityBestEffort`). |
| 3 | **Payment starts by itself on page reload (H-FE-19).** If a payment is pending, simply opening the billing page starts card confirmation and can pop up the bank's 3-D Secure window without a click. | `BillingPage.tsx` (reload recovery effect) | Show a "Complete payment" banner with a button. Confirm only on click. |

### Security fixes

| # | Problem (simple) | Where | Fix |
|---|---|---|---|
| 4 | **Webhook trusts `metadata.workspaceId` (N-10).** It decides which workspace an event belongs to by reading `metadata.workspaceId` first. Some of that metadata (for example on a card) can be set from the browser, so an event could be matched to the wrong workspace. Example: a card showing up in someone else's workspace. | `resolveWorkspaceIdForEvent` | Find the workspace only from our own saved Stripe ids (customer, subscription, payment intent). Ignore metadata. |
| 5 | **Payment secret sent to admins (N-13).** `GET /billing/subscription/payment-status` returns the payment `clientSecret` to admins, but only owners can pay. | `getSubscriptionPaymentStatus`, route | Only return `clientSecret` to the owner. Admins see the status only. |

### Correctness and upkeep

| # | Problem (simple) | Where | Fix |
|---|---|---|---|
| 6 | **Prices are typed into the frontend (B-FE-11).** The page shows $6 / $10 from code, so changing the price in Stripe would not change what the page shows. | `BillingPage.tsx` `PLANS` | Backend returns the real prices (read from Stripe once and cached). The page shows those. |
| 7 | **Stripe API version not pinned.** `new Stripe(key)` uses whatever version the SDK defaults to, so an SDK update can change object shapes. This already happened once: the payment intent moved off the invoice. | `stripe.service.ts` | Pin `apiVersion` and use the same version for the webhook endpoint in the Stripe dashboard. |
| 8 | **Payment lookup guesses.** When the code can't find an invoice's payment, it falls back to "any pending payment of this customer", which could pick the wrong one. | `resolveInvoicePaymentIntent` | Use the invoice payments API for the pinned version and remove the guess. |
| 9 | **`.env.example` has no Stripe variables**, so a new setup doesn't know they are needed. | `.env.example` | Add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_STANDARD_MONTHLY_PRICE_ID`, `STRIPE_PREMIUM_MONTHLY_PRICE_ID`. |
| 10 | **Almost no billing tests.** Only the access plan rule is tested. | `modules/billing` | Add tests for upgrade, downgrade, cancel, seat sync, webhook matching and duplicates (with a stubbed Stripe). |

---

## 3b. AI by plan (decided 2026-10-03)

| Feature | Free | Standard | Premium |
|---|---|---|---|
| AI Assistance (help bubble: navigation, roles, how pages work) | yes | yes | yes |
| Trussen AI (Ask Trussen side panel, chat) | no | no | yes |
| Generate issue with AI | no | no | yes |
| AI suggestions (similar issues, assignee candidates) | no | no | yes |
| MCP (Claude, ChatGPT and others through Connect AI) | yes | yes | yes |

- **Done:**
  - `assertAiAccess` lets only `assist` through on every plan; the rest need Premium.
  - New `GET /ai/availability` (any member).
  - The frontend hides Ask Trussen, the side panel and the Create Issue AI section when `trussenAi` is false.
  - Test in `modules/ai/ai.access.test.ts`.
- **Must be set on the server:** `AI_ENFORCE_BILLING=true`. While it is `false` ("monitor" mode), every plan gets all AI and no daily limits apply. **This is why Free workspaces had AI before.**
- **Daily limits per workspace** (env): Free 500 requests / 500k tokens, Standard 5,000 / 5M, Premium 20,000 / 20M. Free now only uses the help assistant, so consider lowering the Free limit.
- **Not done yet:** background AI jobs (health summaries, search indexing, suggestions) still run on every plan. This needs care: MCP search uses the indexing, and the stale scan job also runs non-AI overdue automation, so it can't just be switched off per plan.

## 4. Stripe dashboard setup (needed for live)

- Products and prices: Standard and Premium, **monthly, per unit (per member)**, in the same currency. Put their ids in the env.
- Webhook endpoint: `https://api.trussen.app/webhooks/stripe`, using the pinned API version, with these events:
  - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
  - `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`
  - `payment_intent.succeeded`, `payment_intent.requires_action`, `payment_intent.payment_failed`
  - `payment_method.attached`, `payment_method.detached`
- Turn on Smart Retries and set what happens after the last failed retry (cancel or mark unpaid). Turn on customer emails for failed payments.
- Right now **both the frontend and backend use test keys** (`pk_test` / `sk_test`). Switch both to live **together**, with the live webhook secret and live price ids.

---

## 5. Order of work

1. Fix 1 and 2 (money), then 4 and 5 (security). Backend.
2. Fix 3 and 6 on the frontend billing page.
3. Fix 7 to 9 (pin the API version, remove the payment guess, update env example).
4. Add the tests (10).
5. Test the full flow in Stripe test mode with test cards, using the checklist below.
6. Set up the live dashboard (section 4) and switch keys.

## 6. Test checklist (Stripe test mode)

- [ ] Add a card (`4242 4242 4242 4242`), set it as default, remove a second card
- [ ] Subscribe to Standard. The status becomes active and an invoice appears.
- [ ] Subscribe with a 3-D Secure card (`4000 0025 0000 3155`). Confirm it only after clicking.
- [ ] Declined card (`4000 0000 0000 0002`). Shows an error, workspace stays on Free.
- [ ] Upgrade Standard → Premium. The difference is charged **now**.
- [ ] Upgrade, then cancel right away. Make sure the difference was already paid.
- [ ] Downgrade Premium → Standard. Applies at the period end.
- [ ] Accept an invite or remove a member. The seat count updates in Stripe.
- [ ] Offboard a user who belongs to a paid workspace. Seats go down.
- [ ] Cancel. Access lasts until the period end, then the workspace goes back to Free.
- [ ] Payment fails at renewal. The workspace becomes PAST_DUE, then Free after the retries run out.
- [ ] Delete and restore a workspace. Renewal stops, then resumes.
- [ ] Send the same webhook twice (Stripe CLI `stripe events resend`). It is handled once.
- [ ] Admin opens billing: can view, cannot pay, gets no `clientSecret`.
