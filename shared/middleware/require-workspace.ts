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

export const requireWorkspace: RequestHandler = async (req, _res, next) => {
  try {
    // ─── Extract workspace ID from param or header ──────────────────────
    const workspaceId =
      (req.params.workspaceId as string | undefined) ||
      (req.headers["x-workspace-id"] as string | undefined);

    if (!workspaceId) {
      throw new AppError(
        400,
        ERROR_CODES.WORKSPACE_NOT_FOUND,
        "Workspace ID is required. Provide it as a route parameter or X-Workspace-Id header.",
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
