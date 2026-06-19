/**
 * Google Drive Integration — Controller
 *
 * HTTP handlers for per-user Google Drive OAuth.
 * Controllers are DUMB — parse request, call service, send response.
 *
 * Key difference from GitHub/Slack: Drive is USER-scoped, not workspace-scoped.
 * Any authenticated user can connect their own Drive. No requireWorkspace needed
 * for connection management.
 */

import type { RequestHandler } from "express";
import * as driveService from "./drive.service.js";
import { sendSuccess } from "../../shared/utils/api-response.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { env } from "../../config/env.js";
import type { DriveCallbackQuery } from "./drive.schemas.js";

/**
 * GET /me/drive — Get Drive connection status
 *
 * Returns whether the user has a connected Drive and the account email.
 * Never returns tokens.
 */
export const getStatus: RequestHandler = async (req, res, next) => {
  try {
    const status = await driveService.getConnectionStatus(req.user!.id);
    sendSuccess(res, 200, status);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /me/drive/connect — Start Google OAuth flow
 *
 * Returns the Google consent URL. Frontend opens this in a popup or redirect.
 * Any authenticated user can connect — no role restriction.
 */
export const connect: RequestHandler = async (req, res, next) => {
  try {
    const authUrl = driveService.getAuthUrl(req.user!.id);
    sendSuccess(res, 200, { authUrl });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /me/drive/callback — Google OAuth callback
 *
 * Google redirects the browser here after the user consents (or denies).
 * No auth middleware — user identity is encoded in the HMAC-signed `state` param.
 *
 * Google sends two possible shapes:
 *   - Success: ?code=...&state=...&scope=...
 *   - Denial:  ?error=access_denied&state=...
 *
 * Both result in a redirect to the frontend with appropriate query params.
 */
export const callback: RequestHandler = async (req, res) => {
  try {
    const query = (req.validated?.query as DriveCallbackQuery) ?? req.query;

    // Case 1: User denied consent — Google sends ?error=access_denied
    if (query.error) {
      const message = query.error === "access_denied"
        ? "You denied access to Google Drive"
        : (query.error_description as string) || query.error;
      res.redirect(
        `${env.FRONTEND_URL}/settings?tab=integrations&provider=drive&status=error&message=${encodeURIComponent(message as string)}`,
      );
      return;
    }

    // Case 2: Missing code or state (should not happen, but guard)
    if (!query.code || !query.state) {
      res.redirect(
        `${env.FRONTEND_URL}/settings?tab=integrations&provider=drive&status=error&message=${encodeURIComponent("Missing authorization parameters")}`,
      );
      return;
    }

    // Case 3: Success — exchange code for tokens
    await driveService.handleCallback(query.code as string, query.state as string);
    res.redirect(`${env.FRONTEND_URL}/settings?tab=integrations&provider=drive&status=connected`);
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Connection failed";
    res.redirect(
      `${env.FRONTEND_URL}/settings?tab=integrations&provider=drive&status=error&message=${encodeURIComponent(message)}`,
    );
  }
};

/**
 * DELETE /me/drive/disconnect — Disconnect Google Drive
 *
 * Revokes the token at Google and deletes the connection.
 * Existing Drive links in issues/docs remain functional (they're just URLs).
 */
export const disconnect: RequestHandler = async (req, res, next) => {
  try {
    await driveService.disconnect(req.user!.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

/**
 * POST /me/drive/upload — Upload a file to the user's Google Drive
 *
 * Accepts a multipart/form-data file upload with optional folder context.
 * The backend proxies the file to Google Drive using the user's encrypted
 * access token (auto-refreshed). Token NEVER leaves the server.
 *
 * Folder structure created in the user's Drive:
 *   Linearis/{workspaceName}/{teamName}/{projectName}/{issueIdentifier}/file.png
 *
 * Each segment is optional — only provided segments create folders.
 * Folders are reused if they already exist (find-or-create).
 *
 * Form fields:
 *   - file (required) — the file to upload
 *   - workspaceName (optional) — workspace display name
 *   - teamName (optional) — team name
 *   - projectName (optional) — project name
 *   - issueIdentifier (optional) — issue ID like "VAT-42"
 */
export const upload: RequestHandler = async (req, res, next) => {
  try {
    const file = req.file;
    if (!file) {
      throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "No file provided");
    }

    // Build folder path from form fields
    const folderPath: string[] = ["Linearis"];
    if (req.body.workspaceName) folderPath.push(String(req.body.workspaceName).trim());
    if (req.body.teamName) folderPath.push(String(req.body.teamName).trim());
    if (req.body.projectName) folderPath.push(String(req.body.projectName).trim());
    if (req.body.issueIdentifier) folderPath.push(String(req.body.issueIdentifier).trim());

    const result = await driveService.uploadFileToDrive(
      req.user!.id,
      {
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      },
      folderPath,
    );

    sendSuccess(res, 201, result);
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /me/drive/rename — Rename a file in the user's Google Drive
 *
 * Only works for files created by Linearis (drive.file scope).
 * Request body: { fileId: string, newName: string }
 */
export const rename: RequestHandler = async (req, res, next) => {
  try {
    const { fileId, newName } = req.body as { fileId?: string; newName?: string };

    if (!fileId || !newName) {
      throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "fileId and newName are required");
    }

    const result = await driveService.renameDriveFile(req.user!.id, fileId, newName);
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};
