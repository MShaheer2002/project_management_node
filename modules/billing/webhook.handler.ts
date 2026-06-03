import type { RequestHandler } from "express";

import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { sendSuccess } from "../../shared/utils/api-response.js";
import * as billingService from "./billing.service.js";

export const handleStripeWebhook: RequestHandler = async (req, res, next) => {
  try {
    const signature = req.headers["stripe-signature"];

    if (typeof signature !== "string" || signature.length === 0) {
      throw new AppError(
        400,
        ERROR_CODES.STRIPE_WEBHOOK_INVALID_SIGNATURE,
        "Missing Stripe webhook signature",
      );
    }

    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body ?? {}));

    const result = await billingService.handleStripeWebhook(rawBody, signature);
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};
