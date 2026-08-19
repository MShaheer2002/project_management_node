/**
 * Scope Permission Guard Middleware
 *
 * Checks that an API-key-authenticated request's linked AiConnection has the
 * required scope. A no-op for Clerk-session requests (req.apiKey unset) —
 * scopes only restrict token-based access, never the web app itself.
 *
 * Must be placed after authenticateDual/authenticateApiKey in the chain.
 *
 * Middleware chain: authenticateDual → requireWorkspace → requireRole → requireScope → controller
 */

import type { RequestHandler } from "express";
import { AppError } from "../utils/api-error.js";
import { ERROR_CODES } from "../errors/error-codes.js";
import { hasScope } from "../utils/scopes.js";
import type { Scope } from "../../modules/ai-connection/ai-connection.scopes.js";

export function requireScope(scope: Scope): RequestHandler {
  return (req, _res, next) => {
    if (!req.apiKey) return next();

    if (!hasScope(req.apiKey.scopes, scope)) {
      return next(
        new AppError(403, ERROR_CODES.INSUFFICIENT_SCOPE, `This action requires the "${scope}" scope`),
      );
    }

    next();
  };
}
