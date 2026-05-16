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
