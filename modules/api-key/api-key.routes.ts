/**
 * API Key Module — Route Definitions
 *
 * All API key management routes require Clerk JWT auth (NOT API key auth).
 * You cannot use an API key to create/list/revoke API keys.
 *
 * Routes:
 *   POST   /api-keys      — Create a new API key (ADMIN/OWNER)
 *   GET    /api-keys       — List all keys in workspace (ADMIN/OWNER)
 *   GET    /api-keys/:id   — Get single key details (ADMIN/OWNER)
 *   DELETE /api-keys/:id   — Revoke a key (ADMIN/OWNER)
 */

import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { validate } from "../../shared/middleware/validate.js";
import { strictRateLimiter } from "../../shared/middleware/rate-limiter.js";
import * as controller from "./api-key.controller.js";
import { createApiKeySchema, apiKeyIdParamSchema } from "./api-key.schemas.js";

const router = Router();

// Create API key — ADMIN/OWNER only, strict rate limit
router.post(
  "/",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  strictRateLimiter,
  validate(createApiKeySchema),
  controller.create,
);

// List API keys — ADMIN/OWNER only
router.get(
  "/",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.list,
);

// Get single API key — ADMIN/OWNER only
router.get(
  "/:id",
  authenticate,
  validate(apiKeyIdParamSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.getById,
);

// Revoke API key — ADMIN/OWNER only
router.delete(
  "/:id",
  authenticate,
  validate(apiKeyIdParamSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.revoke,
);

export default router;
