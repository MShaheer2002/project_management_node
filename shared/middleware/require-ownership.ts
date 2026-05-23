import type { Request, RequestHandler } from "express";

import { ERROR_CODES } from "../errors/error-codes.js";
import { AppError } from "../utils/api-error.js";

interface OwnershipCheckResult {
  exists: boolean;
  ownerId: string | null;
}

interface RequireOwnershipOptions {
  notFoundCode?: string;
  notFoundMessage?: string;
  forbiddenMessage?: string;
}

type OwnershipResolver = (req: Request) => Promise<OwnershipCheckResult> | OwnershipCheckResult;

export function requireOwnership(
  resolveOwnership: OwnershipResolver,
  options: RequireOwnershipOptions = {},
): RequestHandler {
  return async (req, _res, next) => {
    try {
      const workspaceRole = req.workspace?.role;

      if (workspaceRole === "OWNER" || workspaceRole === "ADMIN") {
        return next();
      }

      const result = await resolveOwnership(req);

      if (!result.exists) {
        throw new AppError(
          404,
          options.notFoundCode ?? ERROR_CODES.NOT_FOUND,
          options.notFoundMessage ?? "Resource not found",
        );
      }

      if (!req.user?.id || !result.ownerId || result.ownerId !== req.user.id) {
        throw new AppError(
          403,
          ERROR_CODES.FORBIDDEN,
          options.forbiddenMessage ?? "You do not have permission to perform this action",
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
