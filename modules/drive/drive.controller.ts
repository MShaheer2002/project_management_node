/**
 * Google Drive Integration — Controller
 *
 * HTTP handlers for Google Drive: a personal Drive per user, and one optional
 * Workspace Drive per workspace (owners/admins). Everything except the OAuth
 * callback runs inside a workspace (X-Workspace-Id).
 * Controllers are DUMB — parse request, call service, send response.
 */

import type { RequestHandler } from "express";
import * as driveService from "./drive.service.js";
import { sendSuccess } from "../../shared/utils/api-response.js";
import { AppError } from "../../shared/utils/api-error.js";
import { unlink } from "node:fs/promises";
import { prisma } from "../../shared/utils/prisma.js";
import { oauthReturnUrl } from "../../shared/utils/workspace-url.js";
import { oauthStateWorkspaceId } from "../integration/oauth-state.js";
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
    const status = await driveService.getConnectionStatus(req.user!.id, req.workspace!.id, req.workspace!.role);
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
    const mode = req.body?.mode === "WORKSPACE" ? "WORKSPACE" : "PERSONAL";
    const authUrl = await driveService.getAuthUrl(req.user!.id, req.workspace!.id, mode);
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
  const query = (req.validated?.query as DriveCallbackQuery) ?? req.query;
  // Back to the workspace the user connected from — the bare domain would open
  // whichever workspace the browser used last, possibly one they aren't signed in to.
  const back = async (params: string) =>
    res.redirect(await oauthReturnUrl(oauthStateWorkspaceId(query.state), `/integrations?provider=drive&${params}`));

  try {
    // Case 1: User denied consent — Google sends ?error=access_denied
    if (query.error) {
      const message = query.error === "access_denied"
        ? "You denied access to Google Drive"
        : (query.error_description as string) || query.error;
      await back(`status=error&message=${encodeURIComponent(message as string)}`);
      return;
    }

    // Case 2: Missing code or state (should not happen, but guard)
    if (!query.code || !query.state) {
      await back(`status=error&message=${encodeURIComponent("Missing authorization parameters")}`);
      return;
    }

    // Case 3: Success — exchange code for tokens
    await driveService.handleCallback(query.code as string, query.state as string);
    await back("status=connected");
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Connection failed";
    await back(`status=error&message=${encodeURIComponent(message)}`);
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

/** DELETE /me/drive/workspace — Disconnect the Workspace Drive (owners/admins) */
export const disconnectWorkspace: RequestHandler = async (req, res, next) => {
  try {
    await driveService.disconnectWorkspaceDrive(req.workspace!.id, {
      reason: "An admin disconnected it. Uploads now go to each person's own Drive, if they connected one.",
      actorUserId: req.user!.id,
    });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

const SHARING_LEVELS = ["PRIVATE", "COMPANY", "PUBLIC"] as const;
type SharingLevel = (typeof SHARING_LEVELS)[number];

function parseSharing(value: unknown): SharingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (SHARING_LEVELS as readonly string[]).includes(value)) return value as SharingLevel;
  throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "sharing must be PRIVATE, COMPANY or PUBLIC");
}

/** PATCH /me/drive/settings — { sharing?, uploadTarget? } for this user's own Drive use */
export const updateSettings: RequestHandler = async (req, res, next) => {
  try {
    const uploadTarget = req.body?.uploadTarget;
    if (uploadTarget !== undefined && uploadTarget !== "PERSONAL" && uploadTarget !== "WORKSPACE") {
      throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "uploadTarget must be PERSONAL or WORKSPACE");
    }
    await driveService.updateMyDriveSettings(req.user!.id, req.workspace!.id, { sharing: parseSharing(req.body?.sharing), uploadTarget });
    sendSuccess(res, 200, await driveService.getConnectionStatus(req.user!.id, req.workspace!.id, req.workspace!.role));
  } catch (error) {
    next(error);
  }
};

/** PATCH /me/drive/workspace — { sharing } for the Workspace Drive (owners/admins) */
export const updateWorkspaceDrive: RequestHandler = async (req, res, next) => {
  try {
    const sharing = parseSharing(req.body?.sharing);
    if (!sharing) throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "sharing is required");
    await driveService.updateWorkspaceDriveSharing(req.workspace!.id, sharing);
    sendSuccess(res, 200, await driveService.getConnectionStatus(req.user!.id, req.workspace!.id, req.workspace!.role));
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
 *   Trussen/{workspaceName}/{teamName}/{projectName}/{issueIdentifier}/file.png
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
/** Drive folder names come from the client; they only name folders in the user's own Drive. */
function folderName(value: unknown) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f/]/g, " ").trim().slice(0, 100) : "";
}

export const upload: RequestHandler = async (req, res, next) => {
  const file = req.file;
  try {
    if (!file) {
      throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "No file provided");
    }

    // The workspace folder is named from the database, not the client.
    const workspace = await prisma.workspace.findUnique({ where: { id: req.workspace!.id }, select: { name: true } });
    const folderPath = ["Trussen", folderName(workspace?.name), folderName(req.body.teamName), folderName(req.body.projectName), folderName(req.body.issueIdentifier)]
      .filter(Boolean);

    const result = await driveService.uploadFileToDrive(
      req.user!.id,
      req.workspace!.id,
      { path: file.path, originalname: file.originalname, mimetype: file.mimetype, size: file.size },
      folderPath,
    );

    sendSuccess(res, 201, result);
  } catch (error) {
    next(error);
  } finally {
    if (file?.path) await unlink(file.path).catch(() => {});
  }
};

/** GET /me/drive/files?ids=a,b — sharing badges for Drive attachments */
export const listFiles: RequestHandler = async (req, res, next) => {
  try {
    const ids = typeof req.query.ids === "string"
      ? req.query.ids.split(",").map((id) => id.trim()).filter((id) => /^[\w-]+$/.test(id))
      : [];
    sendSuccess(res, 200, ids.length > 0 ? await driveService.listDriveFiles(req.workspace!.id, ids) : []);
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /me/drive/rename — Rename a file in the user's Google Drive
 *
 * Only works for files created by Trussen (drive.file scope).
 * Request body: { fileId: string, newName: string }
 */
export const rename: RequestHandler = async (req, res, next) => {
  try {
    const { fileId, newName } = req.body as { fileId?: string; newName?: string };

    if (!fileId || !newName) {
      throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "fileId and newName are required");
    }

    const result = await driveService.renameDriveFile(req.user!.id, req.workspace!.id, req.workspace!.role, fileId, newName);
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};
