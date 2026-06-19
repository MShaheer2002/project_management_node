/**
 * Google Drive Integration — Route Definitions
 *
 * All routes are mounted under /me/drive by app.ts.
 * Drive is USER-scoped (not workspace-scoped like GitHub/Slack).
 * Any authenticated user can connect their own Drive — no role restriction.
 *
 * Routes:
 *   GET    /              — Get connection status (connected, email, provider)
 *   POST   /connect       — Start OAuth flow (returns Google consent URL)
 *   GET    /callback      — OAuth callback (Google redirects browser here)
 *   DELETE /disconnect    — Revoke tokens and delete connection
 *   POST   /upload        — Upload a file to the user's Google Drive (proxied server-side)
 */

import { Router } from "express";
import multer from "multer";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { strictRateLimiter } from "../../shared/middleware/rate-limiter.js";
import * as controller from "./drive.controller.js";

const router = Router();

// Multer config — store in memory (file is proxied to Google Drive, not persisted)
// 50 MB limit — matches the existing UPLOAD_VIDEO_MAX_BYTES default
const driveUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Get connection status — any authenticated user
router.get(
  "/",
  authenticate,
  controller.getStatus,
);

// Start OAuth flow — any authenticated user (rate-limited to prevent OAuth abuse)
router.post(
  "/connect",
  authenticate,
  strictRateLimiter,
  controller.connect,
);

// OAuth callback — NO auth middleware, NO validation middleware.
// Google redirects the browser here with extra query params (iss, scope, authuser, prompt)
// that would fail Zod strict validation. The controller handles all edge cases
// (missing code, error param, malformed state) with redirects, not JSON errors.
router.get(
  "/callback",
  controller.callback,
);

// Disconnect Drive — any authenticated user (their own connection)
router.delete(
  "/disconnect",
  authenticate,
  controller.disconnect,
);

// Upload a file to the user's Google Drive (server-side proxy).
// Token NEVER leaves the backend. File bytes flow: Frontend → Backend → Google Drive.
// Rate-limited to prevent Google API quota exhaustion.
router.post(
  "/upload",
  authenticate,
  strictRateLimiter,
  driveUpload.single("file"),
  controller.upload,
);

// Rename a file in the user's Google Drive
router.patch(
  "/rename",
  authenticate,
  controller.rename,
);

export default router;
