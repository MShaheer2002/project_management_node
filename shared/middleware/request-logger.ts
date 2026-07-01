/**
 * Request Logger Middleware
 *
 * Logs every HTTP request with:
 *   - Timestamp, method, URL, status, response time
 *   - User ID and workspace ID (if authenticated)
 *   - Request body (for POST/PATCH — helps debug what the frontend sent)
 *   - Error details (for 4xx/5xx responses)
 *
 * Color-coded by status: green=2xx, yellow=4xx, red=5xx
 *
 * Production: structured JSON (for log aggregation)
 * Development: colored human-readable format
 */

import type { RequestHandler } from "express";
import { env } from "../../config/env.js";

function sanitizeUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl, "http://localhost");
    for (const key of ["api_key", "token", "access_token"]) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return rawUrl;
  }
}

export const requestLogger: RequestHandler = (req, res, next) => {
  const start = Date.now();

  // Capture the response body for error logging
  const originalJson = res.json.bind(res);
  let responseBody: unknown;
  res.json = (body: unknown) => {
    responseBody = body;
    return originalJson(body);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);

    if (env.NODE_ENV === "production") {
      // Structured JSON for log aggregation (Datadog, CloudWatch, etc.)
      process.stdout.write(
        JSON.stringify({
          timestamp,
          method: req.method,
          path: sanitizeUrl(req.originalUrl),
          status,
          duration,
          userId: req.user?.id,
          workspaceId: req.workspace?.id,
        }) + "\n",
      );
      return;
    }

    // ─── Development: colored, detailed logs ──────────────────────────────

    // ANSI color codes
    const reset = "\x1b[0m";
    const dim = "\x1b[2m";
    const bold = "\x1b[1m";
    const green = "\x1b[32m";
    const yellow = "\x1b[33m";
    const red = "\x1b[31m";
    const cyan = "\x1b[36m";

    let statusColor = green;
    if (status >= 500) statusColor = red;
    else if (status >= 400) statusColor = yellow;

    // Main log line
    let line = `${dim}${timestamp}${reset} ${bold}${req.method}${reset} ${sanitizeUrl(req.originalUrl)} ${statusColor}${status}${reset} ${dim}${duration}ms${reset}`;

    // User context
    if (req.user?.id) {
      line += ` ${dim}[user:${req.user.id.slice(0, 15)}]${reset}`;
    }

    // Workspace context
    const wsId = req.workspace?.id || (req.headers["x-workspace-id"] as string);
    if (wsId) {
      line += ` ${dim}[ws:${wsId.slice(0, 8)}]${reset}`;
    }

    console.log(line);

    // Log request body for write operations (helps debug frontend issues)
    if (["POST", "PATCH", "PUT"].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
      console.log(`  ${cyan}→ body:${reset}`, JSON.stringify(req.body));
    }

    // Log error details for failed requests
    if (status >= 400 && responseBody && typeof responseBody === "object") {
      const err = (responseBody as { error?: { code?: string; message?: string } }).error;
      if (err) {
        console.log(`  ${statusColor}← error:${reset} ${err.code} — ${err.message}`);
      }
    }
  });

  next();
};
