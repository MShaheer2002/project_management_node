/**
 * Request Logger Middleware
 *
 * Logs every incoming HTTP request with method, URL, status code, and response time.
 * Uses Morgan in "dev" format during development (colored, concise).
 * Uses "combined" format in production (Apache-style, suitable for log aggregation).
 *
 * Example dev output:
 *   GET /health 200 3.456 ms
 *   POST /issues 201 12.789 ms
 *   GET /unknown 404 0.456 ms
 */

import morgan from "morgan";
import { env } from "../../config/env.js";

// "dev" = concise colored output for development
// "combined" = standard Apache log format for production (works with log aggregators)
export const requestLogger = morgan(
  env.NODE_ENV === "production" ? "combined" : "dev",
);
