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
 *   GET    /files         — Sharing badges for Drive attachments (?ids=)
 *   PATCH  /settings      — Own sharing setting and upload target
 *   PATCH  /workspace     — Workspace Drive sharing (owners/admins)
 *   DELETE /workspace     — Disconnect the Workspace Drive (owners/admins)
 */

import { Router, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import multer from "multer";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { strictRateLimiter } from "../../shared/middleware/rate-limiter.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import * as controller from "./drive.controller.js";
import { DRIVE_UPLOAD_MAX_BYTES } from "./drive.limits.js";

const router = Router();


// Written to a temp file and streamed to Google from there — memoryStorage
// held every in-flight upload in RAM, so parallel 50 MB uploads could take the
// API down (F-40). The controller deletes the file when done.
const driveUpload = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_req, _file, cb) => cb(null, `trussen-drive-${randomUUID()}`),
  }),
  limits: { fileSize: DRIVE_UPLOAD_MAX_BYTES, files: 1 },
});

/** multer's own errors (file too large, unexpected field) as normal API errors. */
const receiveFile: RequestHandler = (req, res, next) => {
  driveUpload.single("file")(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      return next(error.code === "LIMIT_FILE_SIZE"
        ? new AppError(413, ERROR_CODES.DRIVE_FILE_TOO_LARGE, "Files uploaded to Google Drive can be at most 50 MB")
        : new AppError(400, ERROR_CODES.VALIDATION_ERROR, error.message));
    }
    next(error as Error | undefined);
  });
};

// Upper bound on uploads in flight — each holds a temp file and a Google
// connection. Checked before the body is read, so refused requests cost nothing.
// ponytail: per-process counters; move to Redis if several replicas share a small disk.
const MAX_UPLOADS_PER_PROCESS = 8;
const MAX_UPLOADS_PER_USER = 2;
let uploadsInFlight = 0;
const uploadsPerUser = new Map<string, number>();

const limitConcurrentUploads: RequestHandler = (req, res, next) => {
  const userId = req.user!.id;
  const mine = uploadsPerUser.get(userId) ?? 0;
  if (uploadsInFlight >= MAX_UPLOADS_PER_PROCESS || mine >= MAX_UPLOADS_PER_USER) {
    return next(new AppError(429, ERROR_CODES.DRIVE_UPLOAD_BUSY, "Too many uploads in progress. Try again in a moment."));
  }
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > DRIVE_UPLOAD_MAX_BYTES + 1024 * 1024) {
    return next(new AppError(413, ERROR_CODES.DRIVE_FILE_TOO_LARGE, "Files uploaded to Google Drive can be at most 50 MB"));
  }

  uploadsInFlight += 1;
  uploadsPerUser.set(userId, mine + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    uploadsInFlight -= 1;
    const left = (uploadsPerUser.get(userId) ?? 1) - 1;
    if (left > 0) uploadsPerUser.set(userId, left);
    else uploadsPerUser.delete(userId);
  };
  res.on("finish", release);
  res.on("close", release);
  next();
};

// Status covers both the personal Drive and this workspace's Workspace Drive.
router.get(
  "/",
  authenticate,
  requireWorkspace,
  controller.getStatus,
);

// { mode: "PERSONAL" | "WORKSPACE" }. Started from inside a workspace, so the
// callback can return the user there; WORKSPACE needs an owner or admin.
router.post(
  "/connect",
  authenticate,
  requireWorkspace,
  strictRateLimiter,
  controller.connect,
);

router.get(
  "/callback",
  controller.callback,
);

router.delete(
  "/disconnect",
  authenticate,
  controller.disconnect,
);

// Uploads belong to a workspace: its admins decide whether public links are
// allowed, and the file is recorded against it (X-Workspace-Id).
router.post(
  "/upload",
  authenticate,
  requireWorkspace,
  strictRateLimiter,
  limitConcurrentUploads,
  receiveFile,
  controller.upload,
);

router.patch(
  "/settings",
  authenticate,
  requireWorkspace,
  controller.updateSettings,
);

router.patch(
  "/workspace",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.updateWorkspaceDrive,
);

router.delete(
  "/workspace",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.disconnectWorkspace,
);

router.get(
  "/files",
  authenticate,
  requireWorkspace,
  controller.listFiles,
);

router.patch(
  "/rename",
  authenticate,
  requireWorkspace,
  controller.rename,
);

export default router;
