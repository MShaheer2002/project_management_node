/**
 * Auth Module — Route Definitions
 *
 * Defines all auth-related routes and their middleware chains.
 *
 * Routes:
 *   POST /webhooks/clerk  — Clerk webhook receiver (NO auth — verified by signature)
 *   GET  /me              — Authenticated user's profile (requires auth)
 *
 * The webhook route uses express.raw() for signature verification to work correctly
 * with svix — but since we parse JSON globally, we handle it with the standard JSON body.
 */

import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { strictRateLimiter } from "../../shared/middleware/rate-limiter.js";
import { handleClerkWebhook } from "./webhook.handler.js";
import * as authController from "./auth.controller.js";

const router = Router();

// ─── Webhook (unprotected — Clerk calls this directly) ───────────────────────
// Rate limited more strictly to prevent webhook replay abuse
router.post("/webhooks/clerk", strictRateLimiter, handleClerkWebhook);

// ─── User Profile (protected) ────────────────────────────────────────────────
router.get("/me", authenticate, authController.getMe);

export default router;
