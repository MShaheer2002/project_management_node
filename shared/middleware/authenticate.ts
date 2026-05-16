/**
 * Authentication Middleware
 *
 * Verifies the Clerk session JWT on every protected request.
 * After verification, looks up the user in our database and attaches
 * their profile to `req.user` for use by downstream controllers.
 *
 * Flow:
 *   1. Use Clerk's clerkMiddleware to verify the JWT (handles signature + expiry)
 *   2. Extract userId from verified auth state via getAuth()
 *   3. Look up User in our DB (ensure webhook has synced)
 *   4. Attach to req.user = { id, email, name }
 *   5. Call next()
 *
 * Error cases:
 *   - No token / invalid token → 401 UNAUTHORIZED
 *   - Valid token but user not in DB (webhook race) → 403 USER_NOT_SYNCED
 *
 * CRITICAL: Backend NEVER trusts a userId from the request body.
 * Only the verified JWT claims are trusted as the user identity.
 */

import type { RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { AppError } from "../utils/api-error.js";
import { ERROR_CODES } from "../errors/error-codes.js";
import { prisma } from "../utils/prisma.js";

export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    // ─── Verify JWT via Clerk ─────────────────────────────────────────────
    // getAuth() reads the session from the request (set by clerkMiddleware in app.ts)
    // It returns { userId } if the token is valid, or { userId: null } if not
    const auth = getAuth(req);

    if (!auth.userId) {
      throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Authentication required");
    }

    // ─── Look up user in our database ─────────────────────────────────────
    // This ensures the Clerk webhook has synced the user to our DB.
    // If the user signed up 1 second ago, the webhook might not have fired yet.
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { id: true, email: true, name: true },
    });

    if (!user) {
      throw new AppError(
        403,
        ERROR_CODES.USER_NOT_SYNCED,
        "User not synced yet. Please try again in a moment.",
      );
    }

    // ─── Attach user to request ───────────────────────────────────────────
    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
    };

    next();
  } catch (error) {
    next(error);
  }
};
