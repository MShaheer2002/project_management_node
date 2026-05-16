/**
 * API Response Helpers
 *
 * Every API response from Linearis follows a consistent format:
 *
 * Success: { success: true, data: { ... } }
 * Error:   { success: false, error: { code: "...", message: "..." } }
 * List:    { success: true, data: [...], meta: { total, cursor, hasMore } }
 *
 * These helpers enforce that contract so controllers never build responses manually.
 * The frontend depends on this exact shape — changing it breaks the client.
 */

import type { Response } from "express";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Pagination metadata returned with list endpoints */
interface PaginationMeta {
  total: number;
  cursor?: string | null;
  hasMore: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Send a success response with data.
 * Used for GET (single resource), POST (created), PATCH (updated).
 *
 * @example sendSuccess(res, 201, { id: "...", name: "..." })
 */
export function sendSuccess<T>(res: Response, statusCode: number, data: T) {
  return res.status(statusCode).json({
    success: true,
    data,
  });
}

/**
 * Send a paginated list response.
 * Used for all GET list endpoints (issues, projects, members, etc.).
 *
 * @example sendList(res, issues, { total: 100, cursor: "abc", hasMore: true })
 */
export function sendList<T>(res: Response, data: T[], meta: PaginationMeta) {
  return res.status(200).json({
    success: true,
    data,
    meta,
  });
}

/**
 * Send an error response.
 * Usually called by the global error handler, not directly in controllers.
 *
 * @example sendError(res, 404, "NOT_FOUND", "Issue not found")
 */
export function sendError(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown[],
) {
  const error: { code: string; message: string; details?: unknown[] } = {
    code,
    message,
  };

  // Attach validation field errors if present (for 422 responses)
  if (details) {
    error.details = details;
  }

  return res.status(statusCode).json({
    success: false,
    error,
  });
}
