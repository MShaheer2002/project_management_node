-- Phase 13 follow-up — persist latest subscription payment intent for confirmation/webhook flows

ALTER TABLE "Subscription"
ADD COLUMN "stripePaymentIntentId" TEXT;

CREATE INDEX "Subscription_stripePaymentIntentId_idx" ON "Subscription"("stripePaymentIntentId");
