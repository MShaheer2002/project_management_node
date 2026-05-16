/**
 * Global Error Handler Middleware
 *
 * This is the LAST middleware in the Express stack. It catches ALL errors
 * that are thrown or passed via next(err) from any route or middleware.
 *
 * It distinguishes between:
 *   - AppError (operational, expected) → send the error details to the client
 *   - Unknown errors (bugs, crashes) → log the full error, send generic 500
 *
 * In production, stack traces and internal details are NEVER exposed to the client.
 * In development, we log the full stack for debugging.
 */

import type { ErrorRequestHandler } from "express";
import { AppError } from "../utils/api-error.js";
import { sendError } from "../utils/api-response.js";
import { ERROR_CODES } from "../errors/error-codes.js";
import { env } from "../../config/env.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // ─── Known operational error (thrown intentionally in services) ──────
  if (err instanceof AppError) {
    return sendError(res, err.statusCode, err.code, err.message);
  }

  // ─── Unknown/unexpected error (programming bug or external failure) ──
  // Always log unexpected errors for debugging
  console.error("💥 Unhandled error:", err);

  // In development, include the error message for easier debugging
  const message =
    env.NODE_ENV === "development"
      ? (err as Error).message || "An unexpected error occurred"
      : "An unexpected error occurred";

  return sendError(res, 500, ERROR_CODES.INTERNAL_ERROR, message);
};
