/**
 * Workspace Module — Route Definitions
 *
 * All workspace-related routes with their middleware chains.
 * Every route follows: authenticate → [requireWorkspace] → [requireRole] → validate → controller
 *
 * Routes:
 *   POST   /workspaces                                — Create workspace
 *   GET    /workspaces                                — List user's workspaces
 *   GET    /workspaces/check-slug/:slug               — Check slug availability
 *   GET    /workspaces/:workspaceId                   — Get workspace details
 *   PATCH  /workspaces/:workspaceId                   — Update workspace
 *   DELETE /workspaces/:workspaceId                   — Delete workspace
 *   POST   /workspaces/:workspaceId/members/invite    — Invite member
 *   GET    /workspaces/:workspaceId/members           — List members
 *   PATCH  /workspaces/:workspaceId/members/:userId   — Change member role
 *   DELETE /workspaces/:workspaceId/members/:userId   — Remove member
 */

import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { validate } from "../../shared/middleware/validate.js";
import * as controller from "./workspace.controller.js";
import { strictRateLimiter } from "../../shared/middleware/rate-limiter.js";
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  workspaceIdParamSchema,
  checkSlugSchema,
  inviteMemberSchema,
  changeMemberRoleSchema,
  removeMemberSchema,
  resolveInvitationSchema,
  acceptInvitationSchema,
  revokeInvitationSchema,
} from "./workspace.schemas.js";

const router = Router();

// ─── Workspace CRUD ──────────────────────────────────────────────────────────

// Create workspace — any authenticated user
router.post(
  "/",
  authenticate,
  validate(createWorkspaceSchema),
  controller.create,
);

// List user's workspaces — any authenticated user
router.get(
  "/",
  authenticate,
  controller.list,
);

// Check slug availability — any authenticated user (for onboarding form)
// NOTE: Must be before /:workspaceId to avoid treating "check-slug" as a UUID
router.get(
  "/check-slug/:slug",
  authenticate,
  validate(checkSlugSchema),
  controller.checkSlug,
);

// Get workspace details — must be a member
router.get(
  "/:workspaceId",
  authenticate,
  validate(workspaceIdParamSchema),
  requireWorkspace,
  controller.getById,
);

// Update workspace — ADMIN or OWNER only
router.patch(
  "/:workspaceId",
  authenticate,
  validate(updateWorkspaceSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.update,
);

// Delete workspace — OWNER only (cascades everything)
router.delete(
  "/:workspaceId",
  authenticate,
  validate(workspaceIdParamSchema),
  requireWorkspace,
  requireRole("OWNER"),
  controller.remove,
);

// ─── Invitation Management ───────────────────────────────────────────────────
// Invitations are SEPARATE from memberships — an invite is not membership yet.

// Send invitation email — ADMIN or OWNER only
router.post(
  "/:workspaceId/invitations",
  authenticate,
  validate(inviteMemberSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.createInvitation,
);

// List workspace invitations — ADMIN or OWNER only
router.get(
  "/:workspaceId/invitations",
  authenticate,
  validate(workspaceIdParamSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.listInvitations,
);

// Revoke a pending invitation — ADMIN or OWNER only
router.delete(
  "/:workspaceId/invitations/:invitationId",
  authenticate,
  validate(revokeInvitationSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.revokeInvitation,
);

// ─── Membership Management ───────────────────────────────────────────────────

// List members — any member can view
router.get(
  "/:workspaceId/members",
  authenticate,
  validate(workspaceIdParamSchema),
  requireWorkspace,
  controller.listMembers,
);

// Change member role — ADMIN or OWNER only
router.patch(
  "/:workspaceId/members/:userId",
  authenticate,
  validate(changeMemberRoleSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.changeMemberRole,
);

// Remove member — ADMIN or OWNER only
router.delete(
  "/:workspaceId/members/:userId",
  authenticate,
  validate(removeMemberSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.removeMember,
);

export default router;
