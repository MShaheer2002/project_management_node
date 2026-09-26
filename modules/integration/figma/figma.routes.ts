/**
 * Figma Integration — Routes
 *
 * Routes under /integrations/figma/:
 *   POST  /connect        — Connect with personal access token (ADMIN/OWNER)
 *   GET   /settings       — Get settings (ADMIN/OWNER)
 *   PATCH /settings       — Update settings (ADMIN/OWNER)
 *   POST  /batch-preview  — Previews for Figma links on an issue the caller can see (F-41)
 */

import { Router } from "express";
import { authenticate } from "../../../shared/middleware/authenticate.js";
import { requireWorkspace } from "../../../shared/middleware/require-workspace.js";
import { requireRole } from "../../../shared/middleware/require-role.js";
import { validate } from "../../../shared/middleware/validate.js";
import { strictRateLimiter } from "../../../shared/middleware/rate-limiter.js";
import * as controller from "./figma.controller.js";
import {
  connectFigmaSchema,
  updateFigmaSettingsSchema,
} from "./figma.schemas.js";

const router = Router();

// Connect — ADMIN/OWNER only
router.post(
  "/connect",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  validate(connectFigmaSchema),
  controller.connect,
);

// Settings — ADMIN/OWNER only
router.get(
  "/settings",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.getFigmaSettings,
);

router.patch(
  "/settings",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  validate(updateFigmaSettingsSchema),
  controller.updateFigmaSettings,
);

// Preview — any workspace member, rate limited (hits external Figma API)
// Batch preview — any workspace member, rate limited
router.post(
  "/batch-preview",
  authenticate,
  requireWorkspace,
  strictRateLimiter,
  controller.batchPreview,
);

export default router;
