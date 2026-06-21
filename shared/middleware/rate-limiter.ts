/**
 * Rate Limiter Middleware
 *
 * Protects the API from abuse by limiting the number of requests per IP address.
 * Uses a sliding window approach — if a client exceeds the limit, they get 429.
 *
 * Configuration:
 *   - Global: 100 requests per 1 minute per IP (covers all routes)
 *   - Can create stricter limiters for sensitive endpoints (auth, webhooks)
 *
 * The response on rate limit includes a Retry-After header so clients know
 * when they can make requests again.
 */

import rateLimit from "express-rate-limit";
import { ERROR_CODES } from "../errors/error-codes.js";

/**
 * Global rate limiter — applied to all routes.
 * 100 requests per minute per IP address.
 */
export const globalRateLimiter = rateLimit({
  // Time window: 1 minute
  windowMs: 60 * 1000,

  // Max requests per IP in the window
  limit: 100,

  // Return standard error format when rate limited
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: ERROR_CODES.RATE_LIMITED,
        message: "Too many requests. Please try again later.",
      },
    });
  },

  // Include rate limit info in response headers (X-RateLimit-*)
  standardHeaders: true,

  // Disable the legacy X-RateLimit-* headers
  legacyHeaders: false,
});

/**
 * Strict rate limiter — for sensitive endpoints (auth, webhook, password reset).
 * 20 requests per minute per IP address.
 */
export const strictRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: ERROR_CODES.RATE_LIMITED,
        message: "Too many requests. Please try again later.",
      },
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * AI Assistance user limiter — keeps the free guide available without letting
 * one user burn provider calls. Must run after authenticate + requireWorkspace.
 */
export const aiAssistUserRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => {
    const workspaceId = req.workspace?.id;
    const userId = req.user?.id;
    return workspaceId && userId ? `ai-assist:user:${workspaceId}:${userId}` : "ai-assist:user:missing-context";
  },
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: ERROR_CODES.RATE_LIMITED,
        message: "Too many assistant requests. Please try again shortly.",
      },
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * AI Assistance workspace limiter — protects shared workspace cost if multiple
 * users spam the guide at once. Must run after authenticate + requireWorkspace.
 */
export const aiAssistWorkspaceRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  keyGenerator: (req) => {
    const workspaceId = req.workspace?.id;
    return workspaceId ? `ai-assist:workspace:${workspaceId}` : "ai-assist:workspace:missing-context";
  },
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: ERROR_CODES.RATE_LIMITED,
        message: "This workspace is sending too many assistant requests. Please try again shortly.",
      },
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});
