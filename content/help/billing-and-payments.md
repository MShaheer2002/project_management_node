---
id: billing-and-payments
title: Billing and payments
category: Billing
route: /billing
primary: true
roles: OWNER, ADMIN
plans: FREE, STANDARD, PREMIUM
keywords: billing, payment, card, credit card, invoice, subscribe, upgrade, downgrade, cancel subscription, receipt, payment failed, change card, default card, switch plan
---

Open **Billing** from the sidebar. The **owner** manages billing. Admins can see it but can't change anything.

## Current plan

The top card shows your plan, the next billing date and the monthly total. It also shows **Seats**, **Storage** and **AI Features**.

## Add a card

1. Under **Payment Methods**, click **Add card**.
2. Enter the card in the secure Stripe form.

Card details are stored by Stripe, never by Trussen. Trussen only keeps the brand, last 4 digits and expiry.

- **Set default:** the default card is charged.
- **Remove:** you can't remove your only card while on a paid plan.

## Upgrade

1. Under **Plans**, click **Upgrade to Standard** or **Upgrade to Premium**. If you have no card, you're asked to add one first.
2. Check **Review your subscription details**: price per seat, current seats and the estimated monthly total.
3. Click **Confirm & Subscribe**.

Your bank may ask you to confirm the payment. If a payment fails, try another card or click **Retry payment**.

## Switch between Standard and Premium

Click **Switch to Standard** or **Switch to Premium**, then **Confirm & Switch**. The new plan starts right away. The price difference for the rest of the period is added to your next invoice.

## Cancel

1. Click **Cancel Plan** at the top.
2. Click **Confirm cancel**, or **Keep plan** to stay.

You keep the plan until the end of the period you paid for. The card shows **Cancels on** with the date. Then the workspace moves to Free. To go to Free, cancel the paid plan. There is no separate downgrade.

## Invoices

Every charge is under **Invoice History** with its date, amount and status. Use **View invoice** or **Download PDF**.

## If a payment fails

Paid features keep working for a while as Stripe retries the card. Update your card in **Payment Methods**. If every retry fails, the workspace moves to Free.
