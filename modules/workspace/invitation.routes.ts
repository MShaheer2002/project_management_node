/**
 * Invitation Routes (Public + Authenticated)
 *
 * These routes are mounted at /invitations (NOT under /workspaces)
 * because they are accessed by invitees who may not be workspace members yet.
 *
 * Routes:
 *   GET  /invitations/resolve?t=<token>  — Public. Validate token, return invite metadata.
 *   POST /invitations/accept             — Authenticated. Accept invite (email-bound).
 */

import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { strictRateLimiter } from "../../shared/middleware/rate-limiter.js";
import { validate } from "../../shared/middleware/validate.js";
import * as controller from "./workspace.controller.js";
import {
  resolveInvitationSchema,
  acceptInvitationSchema,
} from "./workspace.schemas.js";

const router = Router();

// Resolve invite — PUBLIC (no auth), rate limited to prevent brute-force
// Returns: { workspaceName, role, invitedEmail } so the UI can show context before sign-in
router.get(
  "/resolve",
  strictRateLimiter,
  validate(resolveInvitationSchema),
  controller.resolveInvitation,
);

// Accept invite — AUTHENTICATED, email must match invitation email
// Token in body (not URL) to avoid leaking into logs/proxies/analytics
router.post(
  "/accept",
  authenticate,
  validate(acceptInvitationSchema),
  controller.acceptInvitation,
);

export default router;
