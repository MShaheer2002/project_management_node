/**
 * Slack Integration — Route Definitions
 *
 * Routes under /integrations/slack/:
 *   POST   /connect                  — Start Slack OAuth flow
 *   GET    /callback                 — Slack OAuth callback (no auth)
 *   GET    /settings                 — Get settings + channel mappings
 *   PATCH  /settings                 — Update notification settings
 *   GET    /channels                 — List Slack API channels (for picker)
 *   POST   /channels                 — Add channel mapping
 *   DELETE /channels/:channelDbId    — Remove channel mapping
 *
 * Note: Slash command webhook is in webhooks/webhook.routes.ts, not here.
 */

import { Router } from "express";
import { authenticate } from "../../../shared/middleware/authenticate.js";
import { requireWorkspace } from "../../../shared/middleware/require-workspace.js";
import { requireRole } from "../../../shared/middleware/require-role.js";
import { validate } from "../../../shared/middleware/validate.js";
import * as controller from "./slack.controller.js";
import {
  updateSlackSettingsSchema,
  setSlackChannelSchema,
  removeSlackChannelSchema,
} from "./slack.schemas.js";

const router = Router();

// Start OAuth flow — ADMIN/OWNER only
router.post(
  "/connect",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.connect,
);

// OAuth callback — NO auth (Slack redirects the browser here directly)
router.get(
  "/callback",
  controller.callback,
);

// Get settings + channels — ADMIN/OWNER only
router.get(
  "/settings",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.getSlackSettings,
);

// Update settings — ADMIN/OWNER only
router.patch(
  "/settings",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  validate(updateSlackSettingsSchema),
  controller.updateSlackSettings,
);

// List Slack API channels (for channel picker) — ADMIN/OWNER only
router.get(
  "/channels",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.listChannels,
);

// Add channel mapping — ADMIN/OWNER only
router.post(
  "/channels",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  validate(setSlackChannelSchema),
  controller.addChannel,
);

// Remove channel mapping — ADMIN/OWNER only
router.delete(
  "/channels/:channelDbId",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  validate(removeSlackChannelSchema),
  controller.removeChannel,
);

export default router;
