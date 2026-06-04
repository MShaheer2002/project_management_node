-- Phase 13 — Billing (Stripe-backed workspace subscriptions)

ALTER TYPE "SubscriptionPlan" RENAME VALUE 'PLUS' TO 'PREMIUM';

ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'INCOMPLETE';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'UNPAID';

ALTER TABLE "Subscription"
ADD COLUMN "seatCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "stripeSubscriptionItemId" TEXT,
ADD COLUMN "stripePriceId" TEXT;

CREATE UNIQUE INDEX "Subscription_workspaceId_key" ON "Subscription"("workspaceId");
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");

ALTER TABLE "Invoice"
ADD COLUMN "subscriptionId" TEXT,
ADD COLUMN "stripeInvoiceId" TEXT,
ADD COLUMN "hostedInvoiceUrl" TEXT;

CREATE UNIQUE INDEX "Invoice_stripeInvoiceId_key" ON "Invoice"("stripeInvoiceId");
CREATE INDEX "Invoice_subscriptionId_idx" ON "Invoice"("subscriptionId");

ALTER TABLE "Invoice"
ADD CONSTRAINT "Invoice_subscriptionId_fkey"
FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaymentMethod"
ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "PaymentMethod_stripePaymentMethodId_key" ON "PaymentMethod"("stripePaymentMethodId");

CREATE TABLE "BillingWebhookEvent" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "workspaceId" TEXT,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingWebhookEvent_stripeEventId_key" ON "BillingWebhookEvent"("stripeEventId");
CREATE INDEX "BillingWebhookEvent_workspaceId_createdAt_idx" ON "BillingWebhookEvent"("workspaceId", "createdAt");

ALTER TABLE "BillingWebhookEvent"
ADD CONSTRAINT "BillingWebhookEvent_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
