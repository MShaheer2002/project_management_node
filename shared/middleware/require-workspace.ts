/**
 * Workspace Context Middleware
 *
 * Resolves the active workspace from the request and verifies the
 * authenticated user is a member. After this middleware, `req.workspace`
 * is guaranteed to have the workspace ID and the user's role.
 *
 * Where the workspace ID comes from (checked in order):
 *   1. Route parameter: :workspaceId (e.g., /workspaces/:workspaceId/members)
 *   2. Request header: X-Workspace-Id (e.g., for /issues, /projects)
 *
 * If neither is present → 400
 * If user is not a member of that workspace → 403
 *
 * Must be placed AFTER authenticate middleware in the chain:
 *   authenticate → requireWorkspace → requireRole → controller
 */

import type { RequestHandler } from "express";
import { prisma } from "../utils/prisma.js";
import { AppError } from "../utils/api-error.js";
import { ERROR_CODES } from "../errors/error-codes.js";
import { assertWorkspaceAccessAllowed } from "../../modules/billing/billing.service.js";

/**
 * A deactivated workspace (soft-deleted by an OWNER, see
 * workspace-lifecycle.service.ts) is closed to everyone, OWNERs included —
 * they get a restore screen instead. `canRestore` tells the client which
 * screen to show. Only checked after membership, so non-members can't learn
 * a workspace's state.
 */
function assertNotDeactivated(
  workspace: { deactivatedAt: Date | null; purgeAt: Date | null; name: string },
  role: string,
) {
  if (!workspace.deactivatedAt) return;
  throw new AppError(403, ERROR_CODES.WORKSPACE_DEACTIVATED, "Deactivated by Owner", {
    workspaceName: workspace.name,
    deactivatedAt: workspace.deactivatedAt,
    purgeAt: workspace.purgeAt,
    canRestore: role === "OWNER",
  });
}

function createRequireWorkspace(options: { allowDeactivated: boolean }): RequestHandler {
  return async (req, _res, next) => {
    try {
      // ─── API key auth already resolved workspace — skip ─────────────────
      // (authenticateWithApiKey refuses keys of deactivated workspaces itself)
      if (req.apiKey && req.workspace) {
        return next();
      }

      // ─── Extract workspace ID from param or header ──────────────────────
      const workspaceId =
        (req.params.workspaceId as string | undefined) ||
        (req.headers["x-workspace-id"] as string | undefined);

      if (!workspaceId) {
        throw new AppError(
          400,
          ERROR_CODES.VALIDATION_ERROR,
          "Workspace ID is required. Provide it as a route parameter or X-Workspace-Id header.",
        );
      }

      // ─── Verify workspace exists ──────────────────────────────────────────
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, name: true, deactivatedAt: true, purgeAt: true },
      });

      if (!workspace) {
        throw new AppError(
          404,
          ERROR_CODES.WORKSPACE_NOT_FOUND,
          "Workspace not found",
        );
      }

      // ─── Verify user is a member of this workspace ──────────────────────
      const membership = await prisma.workspaceMembership.findUnique({
        where: {
          userId_workspaceId: {
            userId: req.user?.id ?? "",
            workspaceId,
          },
        },
        select: { role: true },
      });

      if (!membership) {
        throw new AppError(
          403,
          ERROR_CODES.NOT_WORKSPACE_MEMBER,
          "You are not a member of this workspace",
        );
      }

      if (!options.allowDeactivated) {
        assertNotDeactivated(workspace, membership.role);
      }

      // ─── Block access if the workspace is over the Free plan's member cap ──
      // (e.g. a paid subscription with >10 seats lapsed back to Free). Owners
      // are always allowed; everyone else is gated to the earliest-joined seats.
      await assertWorkspaceAccessAllowed(workspaceId, req.user?.id ?? "", membership.role);

      // ─── Attach workspace context to request ────────────────────────────
      req.workspace = {
        id: workspaceId,
        role: membership.role,
      };

      next();
    } catch (error) {
      next(error);
    }
  };
}

export const requireWorkspace = createRequireWorkspace({ allowDeactivated: false });

/** Only for the restore route: the one thing a deactivated workspace still allows. */
export const requireWorkspaceIncludingDeactivated = createRequireWorkspace({ allowDeactivated: true });
