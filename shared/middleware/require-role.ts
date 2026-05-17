/**
 * Role-Based Permission Guard Middleware
 *
 * Checks if the authenticated user's workspace role is in the allowed list.
 * Must be placed AFTER requireWorkspace middleware (needs req.workspace.role).
 *
 * Usage in routes:
 *   requireRole("OWNER")                 → only workspace owner
 *   requireRole("ADMIN", "OWNER")        → admin or owner
 *   requireRole("MEMBER", "ADMIN", "OWNER") → any member except guest
 *
 * Returns 403 INSUFFICIENT_ROLE if the user's role is not in the allowed list.
 *
 * Middleware chain: authenticate → requireWorkspace → requireRole → controller
 */

import type { RequestHandler } from "express";
import type { WorkspaceRole } from "../../app/generated/prisma/client.js";
import { AppError } from "../utils/api-error.js";
import { ERROR_CODES } from "../errors/error-codes.js";

/**
 * Creates a middleware that checks if req.workspace.role is one of the allowed roles.
 *
 * @param allowedRoles - Roles that are permitted to access this route
 * @returns Express middleware that either calls next() or throws 403
 */
export function requireRole(...allowedRoles: WorkspaceRole[]): RequestHandler {
  return (req, _res, next) => {
    const userRole = req.workspace?.role;

    if (!userRole || !allowedRoles.includes(userRole)) {
      return next(
        new AppError(
          403,
          ERROR_CODES.INSUFFICIENT_ROLE,
          `This action requires one of these roles: ${allowedRoles.join(", ")}`,
        ),
      );
    }

    next();
  };
}
