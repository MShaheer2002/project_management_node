/**
 * Figma Integration — Routes
 *
 * Routes under /integrations/figma/:
 *   POST  /connect        — Connect with personal access token (ADMIN/OWNER)
 *   GET   /settings       — Get settings (ADMIN/OWNER)
 *   PATCH /settings       — Update settings (ADMIN/OWNER)
 *   GET   /preview        — Fetch file metadata from URL (any member)
 *   POST  /batch-preview  — Fetch metadata for multiple URLs (any member)
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
  previewFigmaSchema,
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
router.get(
  "/preview",
  authenticate,
  requireWorkspace,
  strictRateLimiter,
  validate(previewFigmaSchema),
  controller.preview,
);

// Batch preview — any workspace member, rate limited
router.post(
  "/batch-preview",
  authenticate,
  requireWorkspace,
  strictRateLimiter,
  controller.batchPreview,
);

export default router;
