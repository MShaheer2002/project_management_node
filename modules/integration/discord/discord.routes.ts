/**
 * Discord Integration -- Route Definitions
 *
 * All routes require authentication, workspace context, and ADMIN/OWNER role.
 *
 * Routes:
 *   POST   /integrations/discord/connect              -- Connect with webhook URL
 *   GET    /integrations/discord/settings              -- Get settings + webhooks
 *   PATCH  /integrations/discord/settings              -- Update notification settings
 *   POST   /integrations/discord/webhooks              -- Add a webhook routing row
 *   DELETE /integrations/discord/webhooks/:webhookDbId -- Remove a webhook routing row
 */

import { Router } from "express";
import { authenticate } from "../../../shared/middleware/authenticate.js";
import { requireWorkspace } from "../../../shared/middleware/require-workspace.js";
import { requireRole } from "../../../shared/middleware/require-role.js";
import { validate } from "../../../shared/middleware/validate.js";
import * as controller from "./discord.controller.js";
import {
  connectDiscordSchema,
  updateDiscordSettingsSchema,
  addDiscordWebhookSchema,
  removeDiscordWebhookSchema,
} from "./discord.schemas.js";

const router = Router();

// Connect Discord -- provide a webhook URL
router.post(
  "/connect",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  validate(connectDiscordSchema),
  controller.connect,
);

// Get settings + webhook list
router.get(
  "/settings",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.getDiscordSettings,
);

// Update notification settings
router.patch(
  "/settings",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  validate(updateDiscordSettingsSchema),
  controller.updateDiscordSettings,
);

// Add a webhook routing row
router.post(
  "/webhooks",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  validate(addDiscordWebhookSchema),
  controller.addWebhook,
);

// Remove a webhook routing row
router.delete(
  "/webhooks/:webhookDbId",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  validate(removeDiscordWebhookSchema),
  controller.removeWebhook,
);

export default router;
