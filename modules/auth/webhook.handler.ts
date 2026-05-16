/**
 * Clerk Webhook Handler
 *
 * Receives webhook events from Clerk and keeps our User table in sync.
 * This endpoint is NOT behind auth middleware — Clerk calls it directly.
 *
 * Security:
 *   - Every request is verified using the webhook signing secret (via svix library)
 *   - Unsigned or tampered requests are rejected with 400
 *   - Replay attacks are prevented by svix timestamp verification
 *
 * Events handled:
 *   - user.created → Insert User row (id = Clerk user_id)
 *   - user.updated → Update name, email, avatar
 *   - user.deleted → Delete User row (cascades memberships)
 *
 * Idempotency:
 *   - user.created uses upsert — duplicate webhook won't fail
 *   - user.deleted on missing user is a no-op
 */

import type { RequestHandler } from "express";
import { Webhook } from "svix";
import { env } from "../../config/env.js";
import { clerkUserSchema } from "./auth.schemas.js";
import * as authService from "./auth.service.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { sendSuccess } from "../../shared/utils/api-response.js";

/**
 * POST /webhooks/clerk
 *
 * Verifies the webhook signature, extracts the event type,
 * and dispatches to the appropriate service function.
 */
export const handleClerkWebhook: RequestHandler = async (req, res, next) => {
  try {
    // ─── Verify webhook signature ─────────────────────────────────────────
    const svixId = req.headers["svix-id"] as string | undefined;
    const svixTimestamp = req.headers["svix-timestamp"] as string | undefined;
    const svixSignature = req.headers["svix-signature"] as string | undefined;

    // All three headers are required for verification
    if (!svixId || !svixTimestamp || !svixSignature) {
      throw new AppError(400, ERROR_CODES.INVALID_WEBHOOK_SIGNATURE, "Missing svix headers");
    }

    // Verify the payload using the webhook signing secret
    const wh = new Webhook(env.CLERK_WEBHOOK_SECRET);
    let payload: { type: string; data: unknown };

    try {
      payload = wh.verify(JSON.stringify(req.body), {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      }) as { type: string; data: unknown };
    } catch {
      throw new AppError(400, ERROR_CODES.INVALID_WEBHOOK_SIGNATURE, "Invalid webhook signature");
    }

    // ─── Dispatch by event type ───────────────────────────────────────────
    const { type, data } = payload;

    switch (type) {
      case "user.created": {
        const userData = clerkUserSchema.parse(data);
        await authService.createUser(userData);
        break;
      }

      case "user.updated": {
        const userData = clerkUserSchema.parse(data);
        await authService.updateUser(userData);
        break;
      }

      case "user.deleted": {
        // Clerk sends minimal data on delete — just the id
        const { id } = data as { id: string };
        if (id) {
          await authService.deleteUser(id);
        }
        break;
      }

      default:
        // Ignore events we don't handle (future-proofing)
        break;
    }

    sendSuccess(res, 200, { received: true });
  } catch (error) {
    next(error);
  }
};
