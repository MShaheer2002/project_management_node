/**
 * GitHub Integration — Route Definitions
 *
 * All routes are mounted under /integrations/github/ by the parent integration router.
 * The webhook route (/webhooks/github) is NOT here — it lives in webhooks/webhook.routes.ts.
 *
 * Routes:
 *   POST   /connect     — Start OAuth flow (ADMIN/OWNER)
 *   GET    /callback    — OAuth callback (no auth — GitHub redirects browser here)
 *   GET    /settings    — Get GitHub settings (ADMIN/OWNER)
 *   PATCH  /settings    — Update GitHub settings (ADMIN/OWNER)
 */

import { Router } from "express";
import { authenticate } from "../../../shared/middleware/authenticate.js";
import { requireWorkspace } from "../../../shared/middleware/require-workspace.js";
import { requireRole } from "../../../shared/middleware/require-role.js";
import { validate } from "../../../shared/middleware/validate.js";
import * as controller from "./github.controller.js";
import { updateGithubSettingsSchema } from "./github.schemas.js";

const router = Router();

// Start OAuth flow — ADMIN/OWNER only
router.post(
  "/connect",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.connect,
);

// OAuth callback — NO auth middleware (GitHub redirects the browser here directly)
// User identity is encoded in the `state` param, verified in the service layer
router.get(
  "/callback",
  controller.callback,
);

// Get GitHub settings — ADMIN/OWNER only
router.get(
  "/settings",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.getSettingsHandler,
);

// Update GitHub settings — ADMIN/OWNER only
router.patch(
  "/settings",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  validate(updateGithubSettingsSchema),
  controller.updateSettingsHandler,
);

export default router;
