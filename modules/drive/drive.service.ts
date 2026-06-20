/**
 * Google Drive Integration — Service Layer
 *
 * Business logic for per-user Google Drive OAuth connection.
 * Unlike GitHub/Slack (workspace-scoped), Drive is USER-scoped.
 * Any workspace member can connect their own Drive.
 *
 * Flow:
 *   1. User clicks "Connect Google Drive" → getAuthUrl() returns Google consent URL
 *   2. Google redirects to callback → handleCallback() exchanges code for tokens
 *   3. Tokens are encrypted (AES-256-GCM) and stored in UserDriveConnection
 *   4. Frontend uploads files directly to Google Drive API using a short-lived access token
 *   5. Backend provides createUploadSession() which returns a fresh access token (auto-refreshed)
 *
 * Security:
 *   - Tokens encrypted at rest — never returned raw in API responses
 *   - `drive.file` scope — can only access files the app creates
 *   - Disconnect revokes the Google token server-side before deleting
 *   - OAuth state includes HMAC-signed nonce to prevent CSRF
 */

import { createHmac, randomBytes } from "node:crypto";
import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { env } from "../../config/env.js";
import { encrypt, decrypt } from "./drive.crypto.js";

// ─── Config Guard ───────────────────────────────────────────────────────────

function ensureConfigured(): void {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.ENCRYPTION_KEY) {
    throw new AppError(
      500,
      ERROR_CODES.DRIVE_NOT_CONFIGURED,
      "Google Drive integration is not configured on this server",
    );
  }
}

function getRedirectUri(): string {
  return env.GOOGLE_REDIRECT_URI ?? `${env.BACKEND_URL ?? `http://localhost:${env.PORT}`}/me/drive/callback`;
}

// ─── State Signing (CSRF Protection) ────────────────────────────────────────

/**
 * Create HMAC-signed OAuth state.
 * Embeds userId + random nonce, signed with ENCRYPTION_KEY to prevent tampering.
 *
 * Format: base64url(JSON({ userId, nonce, sig }))
 *   - nonce: 16 random hex chars (prevents replay)
 *   - sig: HMAC-SHA256(userId + nonce) using ENCRYPTION_KEY
 */
function createSignedState(userId: string): string {
  const nonce = randomBytes(8).toString("hex"); // 16 hex chars
  const payload = `${userId}:${nonce}`;
  const sig = createHmac("sha256", env.ENCRYPTION_KEY!).update(payload).digest("hex");
  return Buffer.from(JSON.stringify({ userId, nonce, sig })).toString("base64url");
}

/**
 * Verify and decode HMAC-signed OAuth state.
 * Throws if signature is invalid or state is malformed.
 */
function verifySignedState(state: string): { userId: string } {
  let stateData: { userId: string; nonce: string; sig: string };
  try {
    stateData = JSON.parse(Buffer.from(state, "base64url").toString());
  } catch {
    throw new AppError(400, ERROR_CODES.DRIVE_OAUTH_FAILED, "Invalid OAuth state parameter");
  }

  const { userId, nonce, sig } = stateData;
  if (!userId || !nonce || !sig) {
    throw new AppError(400, ERROR_CODES.DRIVE_OAUTH_FAILED, "Malformed OAuth state — missing fields");
  }

  // Verify HMAC signature
  const expectedSig = createHmac("sha256", env.ENCRYPTION_KEY!).update(`${userId}:${nonce}`).digest("hex");
  if (sig !== expectedSig) {
    throw new AppError(400, ERROR_CODES.DRIVE_OAUTH_FAILED, "Invalid OAuth state signature — possible CSRF attempt");
  }

  return { userId };
}

// ─── Concurrent Refresh Guard ───────────────────────────────────────────────

/**
 * In-memory lock to prevent concurrent token refresh for the same user.
 * If two requests hit getAccessToken() simultaneously when the token is expired,
 * only one will call Google's token endpoint. The other waits for the same promise.
 */
const refreshLocks = new Map<string, Promise<string>>();

// ─── OAuth ──────────────────────────────────────────────────────────────────

/**
 * Generate the Google OAuth2 consent URL for a user.
 * State is HMAC-signed to prevent CSRF.
 */
export function getAuthUrl(userId: string): string {
  ensureConfigured();

  const state = createSignedState(userId);

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email",
    access_type: "offline", // Request refresh_token
    prompt: "consent", // Force consent to always get refresh_token
    state,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Handle OAuth callback — exchange authorization code for tokens, store encrypted.
 * Verifies HMAC-signed state before proceeding.
 */
export async function handleCallback(code: string, state: string) {
  ensureConfigured();

  // Verify state signature (CSRF protection)
  const { userId } = verifySignedState(state);

  // Verify the user actually exists in our DB
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });

  if (!user) {
    throw new AppError(400, ERROR_CODES.DRIVE_OAUTH_FAILED, "User not found — cannot complete Drive connection");
  }

  // Exchange code for tokens
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: getRedirectUri(),
    }),
  });

  const tokenData = await safeParseJson<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  }>(tokenResponse);

  if (tokenData.error || !tokenData.access_token) {
    throw new AppError(
      400,
      ERROR_CODES.DRIVE_OAUTH_FAILED,
      tokenData.error_description || "Failed to exchange Google authorization code",
    );
  }

  if (!tokenData.refresh_token) {
    throw new AppError(
      400,
      ERROR_CODES.DRIVE_OAUTH_FAILED,
      "No refresh token received. Please revoke Trussen access at https://myaccount.google.com/permissions and try again.",
    );
  }

  // Fetch Google user info to get the email
  const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  const userInfo = await safeParseJson<{
    email?: string;
    error?: { message?: string };
  }>(userInfoResponse);

  if (!userInfo.email) {
    throw new AppError(400, ERROR_CODES.DRIVE_OAUTH_FAILED, "Failed to retrieve Google account email");
  }

  // Calculate token expiry
  const tokenExpiresAt = new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000);

  // Encrypt tokens before storage
  const encryptedAccessToken = encrypt(tokenData.access_token);
  const encryptedRefreshToken = encrypt(tokenData.refresh_token);

  // Upsert — one Drive connection per user
  const connection = await prisma.userDriveConnection.upsert({
    where: { userId },
    create: {
      userId,
      provider: "google_drive",
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt,
      email: userInfo.email,
      connected: true,
    },
    update: {
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt,
      email: userInfo.email,
      connected: true,
    },
  });

  return { id: connection.id, email: userInfo.email, provider: "google_drive" };
}

// ─── Connection Status ──────────────────────────────────────────────────────

/**
 * Get the Drive connection status for a user.
 * Returns connection info without exposing tokens.
 */
export async function getConnectionStatus(userId: string) {
  const connection = await prisma.userDriveConnection.findUnique({
    where: { userId },
    select: {
      id: true,
      provider: true,
      email: true,
      connected: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!connection || !connection.connected) {
    return { connected: false, email: null, provider: null };
  }

  return {
    connected: true,
    email: connection.email,
    provider: connection.provider,
    connectedAt: connection.createdAt,
  };
}

// ─── Disconnect ─────────────────────────────────────────────────────────────

/**
 * Disconnect Google Drive for a user.
 * Revokes the token at Google (best-effort) then deletes the record.
 * Also clears any in-flight refresh lock.
 */
export async function disconnect(userId: string) {
  const connection = await prisma.userDriveConnection.findUnique({
    where: { userId },
    select: { id: true, connected: true, accessToken: true, refreshToken: true },
  });

  if (!connection || !connection.connected) {
    throw new AppError(404, ERROR_CODES.DRIVE_NOT_CONNECTED, "Google Drive is not connected");
  }

  // Clear any in-flight refresh lock for this user
  refreshLocks.delete(userId);

  // Revoke token at Google (best-effort — don't fail if revocation fails)
  try {
    const token = decrypt(connection.accessToken);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } catch {
    // Best-effort: if revocation fails (e.g., token already expired/corrupted), we still delete locally
  }

  // Delete the connection record entirely
  await prisma.userDriveConnection.delete({ where: { userId } });
}

// ─── Token Management ───────────────────────────────────────────────────────

/**
 * Get a fresh access token for a user's Drive connection.
 * If the token is expired, refreshes it automatically and updates the DB.
 * Returns the decrypted access token for the frontend to use.
 *
 * Uses an in-memory lock to prevent concurrent refresh calls for the same user.
 */
export async function getAccessToken(userId: string): Promise<string> {
  const connection = await prisma.userDriveConnection.findUnique({
    where: { userId },
    select: {
      id: true,
      connected: true,
      accessToken: true,
      refreshToken: true,
      tokenExpiresAt: true,
    },
  });

  if (!connection || !connection.connected) {
    throw new AppError(404, ERROR_CODES.DRIVE_NOT_CONNECTED, "Google Drive is not connected");
  }

  // Check if token is still valid (with 5-minute buffer to avoid edge-of-expiry failures)
  const bufferMs = 5 * 60 * 1000;
  const isExpired = connection.tokenExpiresAt.getTime() - bufferMs < Date.now();

  if (!isExpired) {
    return decrypt(connection.accessToken);
  }

  // Token expired — refresh it (with concurrency guard)
  const existingLock = refreshLocks.get(userId);
  if (existingLock) {
    // Another request is already refreshing — wait for it
    return existingLock;
  }

  // Start refresh and register the lock
  const refreshPromise = refreshAccessToken(connection.id, connection.refreshToken)
    .finally(() => {
      // Clean up lock after resolve or reject
      refreshLocks.delete(userId);
    });

  refreshLocks.set(userId, refreshPromise);
  return refreshPromise;
}

/**
 * Refresh the access token using the refresh token.
 * Updates the encrypted token in the database.
 * If refresh fails (revoked/expired), marks the connection as disconnected.
 */
async function refreshAccessToken(connectionId: string, encryptedRefreshToken: string): Promise<string> {
  ensureConfigured();

  const refreshToken = decrypt(encryptedRefreshToken);

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const tokenData = await safeParseJson<{
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  }>(tokenResponse);

  if (tokenData.error || !tokenData.access_token) {
    // If refresh fails, mark connection as disconnected so the user sees "reconnect" in UI
    await prisma.userDriveConnection.update({
      where: { id: connectionId },
      data: { connected: false },
    });

    throw new AppError(
      401,
      ERROR_CODES.DRIVE_TOKEN_REFRESH_FAILED,
      tokenData.error_description || "Failed to refresh Google Drive access token. Please reconnect.",
    );
  }

  const tokenExpiresAt = new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000);
  const encryptedAccessToken = encrypt(tokenData.access_token);

  // Update the stored token
  await prisma.userDriveConnection.update({
    where: { id: connectionId },
    data: {
      accessToken: encryptedAccessToken,
      tokenExpiresAt,
    },
  });

  return tokenData.access_token;
}

// ─── Rename ─────────────────────────────────────────────────────────────────

/**
 * Rename a file in Google Drive.
 * Only works for files created by this app (drive.file scope).
 */
export async function renameDriveFile(
  userId: string,
  fileId: string,
  newName: string,
): Promise<{ id: string; name: string }> {
  if (!fileId || !/^[\w-]+$/.test(fileId)) {
    throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "Invalid Drive file ID");
  }

  const trimmed = newName.trim();
  if (!trimmed || trimmed.length > 255) {
    throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "File name must be 1-255 characters");
  }

  const accessToken = await getAccessToken(userId);

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: trimmed }),
    },
  );

  if (!response.ok) {
    const errorBody = await safeParseJson<{ error?: { message?: string } }>(response);
    throw new AppError(
      502,
      ERROR_CODES.DRIVE_UPLOAD_SESSION_FAILED,
      errorBody.error?.message || `Failed to rename file in Google Drive (HTTP ${response.status})`,
    );
  }

  const result = await safeParseJson<{ id?: string; name?: string }>(response);
  return { id: result.id ?? fileId, name: result.name ?? trimmed };
}

// ─── Drive Folder Management ────────────────────────────────────────────────

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Find a folder by name inside a parent folder.
 * Returns the folder ID if found, null otherwise.
 */
async function findFolder(
  accessToken: string,
  name: string,
  parentId?: string,
): Promise<string | null> {
  const q = parentId
    ? `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='${DRIVE_FOLDER_MIME}' and trashed=false`
    : `name='${name.replace(/'/g, "\\'")}' and 'root' in parents and mimeType='${DRIVE_FOLDER_MIME}' and trashed=false`;

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!response.ok) return null;

  const data = await safeParseJson<{ files?: Array<{ id: string }> }>(response);
  return data.files?.[0]?.id ?? null;
}

/**
 * Create a folder inside a parent folder.
 * Returns the new folder's ID.
 */
async function createFolder(
  accessToken: string,
  name: string,
  parentId?: string,
): Promise<string> {
  const metadata: Record<string, unknown> = {
    name,
    mimeType: DRIVE_FOLDER_MIME,
  };
  if (parentId) {
    metadata.parents = [parentId];
  }

  const response = await fetch(
    "https://www.googleapis.com/drive/v3/files?fields=id",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(metadata),
    },
  );

  if (!response.ok) {
    const errorBody = await safeParseJson<{ error?: { message?: string } }>(response);
    throw new AppError(
      502,
      ERROR_CODES.DRIVE_UPLOAD_SESSION_FAILED,
      errorBody.error?.message || "Failed to create folder in Google Drive",
    );
  }

  const folder = await safeParseJson<{ id?: string }>(response);
  if (!folder.id) {
    throw new AppError(502, ERROR_CODES.DRIVE_UPLOAD_SESSION_FAILED, "Google Drive did not return folder ID");
  }
  return folder.id;
}

/**
 * Resolve a folder path in Google Drive, creating folders as needed.
 * Example: ["Trussen", "Acme Corp", "Engineering", "Website Redesign", "VAT-42"]
 *
 * Creates:
 *   My Drive/
 *     Trussen/
 *       Acme Corp/
 *         Engineering/
 *           Website Redesign/
 *             VAT-42/
 *               <uploaded file>
 *
 * Folders are reused if they already exist (find-or-create pattern).
 * Returns the final folder's ID.
 */
async function resolveOrCreateFolderPath(
  accessToken: string,
  segments: string[],
): Promise<string | undefined> {
  if (segments.length === 0) return undefined;

  let parentId: string | undefined;

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const existingId = await findFolder(accessToken, trimmed, parentId);
    if (existingId) {
      parentId = existingId;
    } else {
      parentId = await createFolder(accessToken, trimmed, parentId);
    }
  }

  return parentId;
}

// ─── Server-Side Upload ─────────────────────────────────────────────────────

/**
 * Upload a file to Google Drive on behalf of a user.
 * The entire upload happens server-side — the access token never leaves the backend.
 *
 * Files are organized in a structured folder hierarchy:
 *   Trussen/{workspaceName}/{teamName}/{projectName}/{issueIdentifier}/file.png
 *
 * Folders are created on-demand and reused if they already exist.
 *
 * Uses Google Drive API v3 multipart upload:
 *   POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart
 *
 * After upload, sets sharing to "anyone with link can view" (best-effort).
 */
export async function uploadFileToDrive(
  userId: string,
  file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  folderPath?: string[],
): Promise<{
  driveFileId: string;
  driveUrl: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}> {
  const accessToken = await getAccessToken(userId);

  // Resolve or create the folder hierarchy
  const folderId = folderPath && folderPath.length > 0
    ? await resolveOrCreateFolderPath(accessToken, folderPath)
    : undefined;

  // Build multipart/related body for Google Drive API
  const boundary = `trussen_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const fileMetadata: Record<string, unknown> = {
    name: file.originalname,
    mimeType: file.mimetype,
  };
  if (folderId) {
    fileMetadata.parents = [folderId];
  }

  const metadata = JSON.stringify(fileMetadata);

  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${file.mimetype}\r\n\r\n`,
    "utf8",
  );
  const closing = Buffer.from(`\r\n--${boundary}--`, "utf8");
  const body = Buffer.concat([preamble, file.buffer, closing]);

  // Upload to Google Drive
  const uploadResponse = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
    },
  );

  if (!uploadResponse.ok) {
    const errorBody = await safeParseJson<{ error?: { message?: string } }>(uploadResponse);
    throw new AppError(
      502,
      ERROR_CODES.DRIVE_UPLOAD_SESSION_FAILED,
      errorBody.error?.message || `Google Drive upload failed (HTTP ${uploadResponse.status})`,
    );
  }

  const driveFile = await safeParseJson<{
    id?: string;
    name?: string;
    mimeType?: string;
    size?: string;
    webViewLink?: string;
  }>(uploadResponse);

  if (!driveFile.id) {
    throw new AppError(502, ERROR_CODES.DRIVE_UPLOAD_SESSION_FAILED, "Google Drive did not return a file ID");
  }

  // Validate file ID (alphanumeric + hyphens/underscores only)
  if (!/^[\w-]+$/.test(driveFile.id)) {
    throw new AppError(502, ERROR_CODES.DRIVE_UPLOAD_SESSION_FAILED, "Invalid file ID from Google Drive");
  }

  // Set sharing permissions (best-effort — don't fail if org restricts sharing)
  try {
    await fetch(
      `https://www.googleapis.com/drive/v3/files/${driveFile.id}/permissions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "reader", type: "anyone" }),
      },
    );
  } catch {
    // Non-critical — file is still accessible by the uploader
  }

  return {
    driveFileId: driveFile.id,
    driveUrl: driveFile.webViewLink ?? `https://drive.google.com/file/d/${driveFile.id}/view`,
    fileName: driveFile.name ?? file.originalname,
    mimeType: driveFile.mimeType ?? file.mimetype,
    sizeBytes: driveFile.size ? parseInt(driveFile.size, 10) : file.size,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Safely parse a JSON response. If the body is not valid JSON (e.g., Google
 * returns HTML on a 500), returns an empty object instead of throwing.
 * Prevents crashes when Google APIs return unexpected response formats.
 */
async function safeParseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    return {} as T;
  }
}
