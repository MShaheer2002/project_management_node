/**
 * Dual-Mode Authentication Middleware
 *
 * Tries API key auth if the token starts with "lin_live_" or "lin_test_",
 * otherwise falls back to Clerk JWT auth.
 *
 * After this middleware, req.user is guaranteed to be set.
 * If authenticated via API key, req.workspace and req.apiKey are also set
 * (workspace is auto-resolved from the key, no X-Workspace-Id header needed).
 *
 * Usage — replace `authenticate` with `authenticateDual` on routes that
 * should accept both Clerk JWT and API key auth:
 *
 *   // Before: router.get("/", authenticate, requireWorkspace, controller.list);
 *   // After:  router.get("/", authenticateDual, requireWorkspace, controller.list);
 */

import type { RequestHandler } from "express";
import { isApiKeyToken, authenticateApiKey } from "./authenticate-api-key.js";
import { authenticate } from "./authenticate.js";

export const authenticateDual: RequestHandler = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (isApiKeyToken(token)) {
    return authenticateApiKey(req, res, next);
  }

  return authenticate(req, res, next);
};
