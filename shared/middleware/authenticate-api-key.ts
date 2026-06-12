/**
 * API Key Authentication Middleware
 *
 * Authenticates requests that use an API key (lin_live_* / lin_test_*) instead
 * of a Clerk JWT. On success, sets req.user, req.workspace, and req.apiKey.
 *
 * This middleware is NOT used directly on routes — it's called by the
 * dual-auth middleware (authenticate-dual.ts) when the token looks like an API key.
 *
 * Security:
 *   - SHA-256 hash lookup (O(1) via unique index)
 *   - Expiration checked on every request
 *   - Creator's workspace membership verified (prevents orphaned key access)
 *   - lastUsedAt updated with 5-minute debounce
 *   - API key auth auto-resolves workspace (no X-Workspace-Id header needed)
 */

import type { RequestHandler } from "express";
import { AppError } from "../utils/api-error.js";
import { ERROR_CODES } from "../errors/error-codes.js";
import { authenticateWithApiKey } from "../../modules/api-key/api-key.service.js";

export const API_KEY_PREFIXES = ["lin_live_", "lin_test_"];

export function isApiKeyToken(token: string): boolean {
  return API_KEY_PREFIXES.some((prefix) => token.startsWith(prefix));
}

export const authenticateApiKey: RequestHandler = async (req, _res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Authentication required");
    }

    const token = authHeader.slice(7);

    if (!isApiKeyToken(token)) {
      throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Authentication required");
    }

    const result = await authenticateWithApiKey(token);

    req.user = result.user;
    req.workspace = result.workspace;
    req.apiKey = result.apiKey;

    next();
  } catch (error) {
    next(error);
  }
};
