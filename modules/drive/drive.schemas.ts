/**
 * Google Drive Integration — Zod Schemas
 *
 * Validation schemas for Drive OAuth callback and upload metadata endpoints.
 */

import { z } from "zod/v4";

/**
 * GET /me/drive/callback — OAuth callback query params
 *
 * Google sends EITHER:
 *   - Success: ?code=...&state=...&scope=...
 *   - Error:   ?error=access_denied&state=...
 *
 * Both must be accepted — the controller handles the error case with a redirect.
 */
export const driveCallbackSchema = {
  query: z.object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().optional(), // "access_denied" when user denies consent
    error_description: z.string().optional(),
  }).passthrough(), // Google sends extra params (iss, scope, authuser, prompt) — don't reject them
};

/** POST /me/drive/upload-url — Request a resumable upload URL */
export const driveUploadUrlSchema = {
  body: z.object({
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(255),
    folderId: z.string().trim().min(1).optional(), // Optional Drive folder ID
  }),
};

// ─── Inferred Types ──────────────────────────────────────────────────────────

export type DriveCallbackQuery = z.infer<typeof driveCallbackSchema.query>;
export type DriveUploadUrlBody = z.infer<typeof driveUploadUrlSchema.body>;
