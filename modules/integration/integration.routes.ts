/**
 * Integration Module — Route Definitions
 *
 * Two sets of routes:
 *   1. Integration management (authenticated, workspace-scoped, ADMIN/OWNER)
 *   2. GitHub webhook (unauthenticated, signature-verified)
 *
 * Routes:
 *   GET    /integrations                        — List all integrations + status
 *   POST   /integrations/:provider/connect      — Start OAuth flow
 *   GET    /integrations/:provider/callback     — OAuth callback (GitHub redirects here)
 *   DELETE /integrations/:provider/disconnect   — Disconnect integration
 *   PATCH  /integrations/:provider/settings     — Update provider settings
 *   POST   /webhooks/github                     — GitHub webhook receiver (no auth)
 */

import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { validate } from "../../shared/middleware/validate.js";
import * as controller from "./integration.controller.js";
import {
  connectProviderSchema,
  disconnectProviderSchema,
  oauthCallbackSchema,
  updateSettingsSchema,
} from "./integration.schemas.js";

const router = Router();

// ─── Integration Management (authenticated) ─────────────────────────────────

// List integrations — ADMIN/OWNER can see full status, MEMBER can see connection status
router.get(
  "/",
  authenticate,
  requireWorkspace,
  controller.list,
);

// Start OAuth flow — ADMIN/OWNER only
router.post(
  "/:provider/connect",
  authenticate,
  validate(connectProviderSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.connect,
);

// OAuth callback — NO auth middleware (GitHub redirects the browser here directly)
// User identity is encoded in the `state` param, verified in the service layer
router.get(
  "/:provider/callback",
  validate(oauthCallbackSchema),
  controller.oauthCallback,
);

// Disconnect — ADMIN/OWNER only
router.delete(
  "/:provider/disconnect",
  authenticate,
  validate(disconnectProviderSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.disconnect,
);

// Update settings — ADMIN/OWNER only
router.patch(
  "/:provider/settings",
  authenticate,
  validate(updateSettingsSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.updateSettings,
);

export default router;

// ─── Webhook Routes (separate router, no auth) ──────────────────────────────
// These are mounted separately in app.ts since they don't use auth middleware

export const webhookRouter = Router();

// GitHub webhook — signature verified internally, no Clerk/API key auth
webhookRouter.post(
  "/github",
  controller.githubWebhook,
);
