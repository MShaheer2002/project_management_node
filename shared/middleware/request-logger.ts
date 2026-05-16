/**
 * Request Logger Middleware
 *
 * Logs every incoming HTTP request with:
 *   - Timestamp
 *   - Method + URL
 *   - Status code (color-coded)
 *   - Response time
 *   - User ID (if authenticated)
 *   - Workspace ID (if present)
 *
 * Development: Custom colored format with context
 * Production: Structured JSON format (for log aggregation)
 *
 * Example dev output:
 *   [2026-05-16 12:30:45] POST /webhooks/clerk → 200 (4ms)
 *   [2026-05-16 12:30:46] GET /me → 401 (2ms)
 *   [2026-05-16 12:30:47] GET /issues → 200 (8ms) [user: user_2x1abc] [ws: abc-123]
 *   [2026-05-16 12:30:48] GET /nonexistent → 404 (0ms)
 */

import morgan from "morgan";
import type { Request, Response } from "express";
import { env } from "../../config/env.js";

// ─── Custom tokens ───────────────────────────────────────────────────────────

// Formatted timestamp: YYYY-MM-DD HH:MM:SS
morgan.token("ts", () => new Date().toISOString().replace("T", " ").slice(0, 19));

// User ID from req.user (set by authenticate middleware)
morgan.token("uid", (req: Request) => req.user?.id ?? "");

// Workspace ID from req.workspace or X-Workspace-Id header
morgan.token("wid", (req: Request) =>
  req.workspace?.id ?? (req.headers["x-workspace-id"] as string) ?? "",
);

// ─── Format strings ──────────────────────────────────────────────────────────

// Development: colored, human-readable
const DEV_FORMAT =
  "[:ts] \x1b[1m:method\x1b[0m :url → :status (:response-time ms) :uid :wid";

// Production: structured for log aggregation (JSON-like)
const PROD_FORMAT =
  '{"ts":":ts","method":":method","path":":url","status"::status,"duration":":response-time","userId":":uid","workspaceId":":wid"}';

// ─── Export ──────────────────────────────────────────────────────────────────

export const requestLogger = morgan(
  env.NODE_ENV === "production" ? PROD_FORMAT : DEV_FORMAT,
  {
    // Write to stdout (default) — Morgan handles flushing
    stream: process.stdout,
  },
);
