/**
 * AI Module — Route Definitions
 *
 * All routes are mounted under /ai by app.ts.
 * All routes require authentication + workspace context.
 *
 * Routes:
 *   POST /generate-issue  — Generate a structured issue from natural language
 *   GET  /models           — List available AI models
 */

import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import { strictRateLimiter } from "../../shared/middleware/rate-limiter.js";
import * as controller from "./ai.controller.js";
import { generateIssueSchema } from "./ai.schemas.js";

const router = Router();

// Generate a structured issue from natural language.
// Rate-limited to prevent AI budget exhaustion.
// Requires workspace context for fetching projects, members, labels, templates.
router.post(
  "/generate-issue",
  authenticate,
  requireWorkspace,
  strictRateLimiter,
  validate(generateIssueSchema),
  controller.generateIssue,
);

// List available AI models for workspace settings.
router.get(
  "/models",
  authenticate,
  controller.getModels,
);

export default router;
