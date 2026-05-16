/**
 * Auth Module — Controller
 *
 * Handles HTTP request parsing and response sending for auth endpoints.
 * Controllers are DUMB — they parse the request, call the service, and send the response.
 * No business logic lives here.
 */

import type { RequestHandler } from "express";
import * as authService from "./auth.service.js";
import { sendSuccess } from "../../shared/utils/api-response.js";

/**
 * GET /me
 *
 * Returns the authenticated user's profile from our database.
 * The user is already verified and attached to req.user by the authenticate middleware.
 * This endpoint fetches the full profile (including avatar, lastActiveAt, createdAt).
 */
export const getMe: RequestHandler = async (req, res, next) => {
  try {
    // req.user is guaranteed to exist here (authenticate middleware ran first)
    const user = await authService.getUserById(req.user!.id);

    // Update last active timestamp (fire-and-forget, don't block the response)
    authService.touchLastActive(req.user!.id).catch(() => {
      // Silently ignore — this is non-critical
    });

    sendSuccess(res, 200, user);
  } catch (error) {
    next(error);
  }
};
