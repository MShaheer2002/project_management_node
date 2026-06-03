import { Router } from "express";

import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import * as controller from "./billing.controller.js";
import * as webhookHandler from "./webhook.handler.js";
import {
  attachPaymentMethodSchema,
  changePlanSchema,
  createSubscriptionSchema,
  removePaymentMethodSchema,
  setDefaultPaymentMethodSchema,
} from "./billing.schemas.js";

const router = Router();

router.get(
  "/billing/subscription",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.getSubscription,
);

router.get(
  "/billing/subscription/payment-status",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.getSubscriptionPaymentStatus,
);

router.post(
  "/billing/subscription/create",
  authenticate,
  validate(createSubscriptionSchema),
  requireWorkspace,
  requireRole("OWNER"),
  controller.createSubscription,
);

router.patch(
  "/billing/subscription/change-plan",
  authenticate,
  validate(changePlanSchema),
  requireWorkspace,
  requireRole("OWNER"),
  controller.changePlan,
);

router.post(
  "/billing/subscription/cancel",
  authenticate,
  requireWorkspace,
  requireRole("OWNER"),
  controller.cancelSubscription,
);

router.post(
  "/billing/setup-intent",
  authenticate,
  requireWorkspace,
  requireRole("OWNER"),
  controller.createSetupIntent,
);

router.get(
  "/billing/payment-methods",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.listPaymentMethods,
);

router.post(
  "/billing/payment-methods/attach",
  authenticate,
  validate(attachPaymentMethodSchema),
  requireWorkspace,
  requireRole("OWNER"),
  controller.attachPaymentMethod,
);

router.patch(
  "/billing/payment-methods/default",
  authenticate,
  validate(setDefaultPaymentMethodSchema),
  requireWorkspace,
  requireRole("OWNER"),
  controller.setDefaultPaymentMethod,
);

router.delete(
  "/billing/payment-methods/:id",
  authenticate,
  validate(removePaymentMethodSchema),
  requireWorkspace,
  requireRole("OWNER"),
  controller.removePaymentMethod,
);

router.get(
  "/billing/invoices",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.listInvoices,
);

router.post("/webhooks/stripe", webhookHandler.handleStripeWebhook);

export default router;
