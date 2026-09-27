/**
 * Google Drive Integration — Service Layer
 *
 * Two kinds of Drive connection:
 *   PERSONAL  — anyone can connect their own Drive; only they upload into it.
 *   WORKSPACE — one per workspace, connected by an owner or admin; every
 *               member can upload into it (and chooses it or their own).
 * Each connection has a sharing setting (who can open uploaded files),
 * Public by default. For personal Drives, Public is only available while the
 * workspace allows it (Workspace.allowPublicDriveLinks); the Workspace Drive's
 * sharing is set by admins.
 *
 * Security:
 *   - Tokens encrypted at rest — never returned raw in API responses
 *   - `drive.file` scope — can only access files the app creates; a
 *     connection granted without it is refused
 *   - OAuth state is the shared signed, expiring state (integration/oauth-state.ts)
 *   - Disconnect revokes the Google token server-side before deleting
 *   - The Workspace Drive is removed if its admin leaves or is demoted
 */

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { Prisma } from "../../app/generated/prisma/client.js";
import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { env } from "../../config/env.js";
import { encrypt, decrypt } from "./drive.crypto.js";
import { createOAuthState, verifyOAuthState } from "../integration/oauth-state.js";
import { createNotification } from "../notification/notification.service.js";
import {
  DRIVE_FILE_SCOPE,
  driveScopeError,
  isScopeError,
  allowedSharingLevels,
  applyDriveSharing,
  assertSharingAllowed,
  type DriveSharingLevel,
} from "./drive.sharing.js";

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

const isAdminRole = (role: string | undefined) => role === "OWNER" || role === "ADMIN";

// ─── Connections ────────────────────────────────────────────────────────────

/** Whose Google Drive a call uses. */
export type DriveOwner = { kind: "PERSONAL"; userId: string } | { kind: "WORKSPACE"; workspaceId: string };

type StoredConnection = {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: Date;
  defaultSharing: DriveSharingLevel;
};

async function loadConnection(owner: DriveOwner): Promise<StoredConnection | null> {
  const select = { id: true, email: true, accessToken: true, refreshToken: true, tokenExpiresAt: true, defaultSharing: true } as const;
  if (owner.kind === "WORKSPACE") {
    return prisma.workspaceDriveConnection.findUnique({ where: { workspaceId: owner.workspaceId }, select });
  }
  const connection = await prisma.userDriveConnection.findUnique({ where: { userId: owner.userId }, select: { ...select, connected: true } });
  return connection?.connected ? connection : null;
}

function notConnected(owner: DriveOwner) {
  return new AppError(
    404,
    ERROR_CODES.DRIVE_NOT_CONNECTED,
    owner.kind === "WORKSPACE" ? "The workspace Google Drive is not connected" : "Google Drive is not connected",
  );
}

/**
 * In-memory lock so concurrent requests with an expired token refresh it once.
 * Keyed by connection, so a personal and the workspace Drive never collide.
 */
const refreshLocks = new Map<string, Promise<string>>();

/** A valid access token for this Drive, refreshed if needed. */
export async function getAccessToken(owner: DriveOwner): Promise<string> {
  const connection = await loadConnection(owner);
  if (!connection) throw notConnected(owner);

  // 5-minute buffer to avoid edge-of-expiry failures
  if (connection.tokenExpiresAt.getTime() - 5 * 60 * 1000 > Date.now()) {
    return decrypt(connection.accessToken);
  }

  const lockKey = `${owner.kind}:${connection.id}`;
  const existing = refreshLocks.get(lockKey);
  if (existing) return existing;

  const refresh = refreshAccessToken(owner, connection).finally(() => refreshLocks.delete(lockKey));
  refreshLocks.set(lockKey, refresh);
  return refresh;
}

async function refreshAccessToken(owner: DriveOwner, connection: StoredConnection): Promise<string> {
  ensureConfigured();

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: decrypt(connection.refreshToken),
      grant_type: "refresh_token",
    }),
  });
  const tokenData = await safeParseJson<{ access_token?: string; expires_in?: number; error?: string; error_description?: string }>(tokenResponse);

  if (tokenData.error || !tokenData.access_token) {
    // Revoked or expired at Google: the connection is dead — surface "Connect" again.
    await dropConnection(owner, "Google no longer accepts its access, so it was disconnected. An admin can connect it again.");
    throw new AppError(
      401,
      ERROR_CODES.DRIVE_TOKEN_REFRESH_FAILED,
      tokenData.error_description || "Google Drive access expired. Connect Google Drive again.",
    );
  }

  const data = {
    accessToken: encrypt(tokenData.access_token),
    tokenExpiresAt: new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000),
  };
  if (owner.kind === "WORKSPACE") {
    await prisma.workspaceDriveConnection.updateMany({ where: { id: connection.id }, data });
  } else {
    await prisma.userDriveConnection.update({ where: { id: connection.id }, data });
  }
  return tokenData.access_token;
}

/**
 * A connection that can't work any more (permission missing, access revoked):
 * a personal one is marked disconnected; the Workspace Drive is removed and
 * the workspace's admins are told, since everyone's uploads depended on it.
 */
async function dropConnection(owner: DriveOwner, reason: string) {
  if (owner.kind === "PERSONAL") {
    await prisma.userDriveConnection.updateMany({ where: { userId: owner.userId }, data: { connected: false } });
    return;
  }
  const removed = await prisma.workspaceDriveConnection.deleteMany({ where: { workspaceId: owner.workspaceId } });
  if (removed.count > 0) await notifyAdmins(owner.workspaceId, reason);
}

async function notifyAdmins(workspaceId: string, message: string, exceptUserId?: string) {
  const admins = await prisma.workspaceMembership.findMany({
    where: { workspaceId, role: { in: ["OWNER", "ADMIN"] }, user: { deletedAt: null } },
    select: { userId: true },
  });
  await Promise.all(admins
    .filter((admin) => admin.userId !== exceptUserId)
    .map((admin) => createNotification({
      workspaceId,
      recipientUserId: admin.userId,
      type: "UPDATE",
      category: "update",
      title: "Workspace Google Drive disconnected",
      message,
      target: { type: "workspace", id: workspaceId, url: "/integrations" },
    }).catch(() => null)));
}

/** Run Drive work; if Google says the Drive permission is missing, drop the connection first. */
async function dropIfScopeMissing<T>(owner: DriveOwner, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError && error.code === ERROR_CODES.DRIVE_SCOPE_MISSING) {
      await dropConnection(owner, "It was connected without permission to add files, so it was disconnected. An admin can connect it again.");
    }
    throw error;
  }
}

async function revokeAtGoogle(encryptedAccessToken: string) {
  try {
    const token = decrypt(encryptedAccessToken);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } catch {
    // Best effort: an already expired or corrupted token is fine to drop locally.
  }
}

// ─── OAuth ──────────────────────────────────────────────────────────────────

export type ConnectMode = "PERSONAL" | "WORKSPACE";

/** Why this user can't connect the Workspace Drive right now, or null if they can. */
async function workspaceDriveBlocker(workspaceId: string, userId: string) {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true },
  });
  if (!isAdminRole(membership?.role)) {
    return new AppError(403, ERROR_CODES.INSUFFICIENT_ROLE, "Only owners and admins can connect a workspace Google Drive");
  }
  const existing = await prisma.workspaceDriveConnection.findUnique({
    where: { workspaceId },
    select: { email: true, connectedBy: { select: { name: true } } },
  });
  if (existing) {
    return new AppError(
      409,
      ERROR_CODES.WORKSPACE_DRIVE_EXISTS,
      `A workspace Google Drive is already connected by ${existing.connectedBy.name} (${existing.email}).`,
    );
  }
  return null;
}

/** Google's consent URL. `mode` travels in the signed state. */
export async function getAuthUrl(userId: string, workspaceId: string, mode: ConnectMode): Promise<string> {
  ensureConfigured();
  if (mode === "WORKSPACE") {
    const blocker = await workspaceDriveBlocker(workspaceId, userId);
    if (blocker) throw blocker;
  }

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
    access_type: "offline", // Request refresh_token
    prompt: "consent", // Force consent to always get refresh_token
    state: createOAuthState(workspaceId, userId, mode),
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Exchange the code, check the Drive permission was granted, and store the connection. */
export async function handleCallback(code: string, state: string) {
  ensureConfigured();

  const { userId, workspaceId, mode } = verifyOAuthState(state, ERROR_CODES.DRIVE_OAUTH_FAILED);
  const connectMode: ConnectMode = mode === "WORKSPACE" ? "WORKSPACE" : "PERSONAL";

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, deletedAt: true } });
  if (!user || user.deletedAt) {
    throw new AppError(400, ERROR_CODES.DRIVE_OAUTH_FAILED, "User not found. Could not connect Google Drive.");
  }

  // Minutes pass on Google's screen: re-check before storing a workspace-wide connection.
  if (connectMode === "WORKSPACE") {
    const blocker = await workspaceDriveBlocker(workspaceId, userId);
    if (blocker) throw blocker;
  }

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
    scope?: string;
    error?: string;
    error_description?: string;
  }>(tokenResponse);

  if (tokenData.error || !tokenData.access_token) {
    throw new AppError(400, ERROR_CODES.DRIVE_OAUTH_FAILED, tokenData.error_description || "Failed to exchange Google authorization code");
  }

  // Google lets people untick the Drive permission. Such a connection would
  // look connected yet fail on every upload, so refuse it and drop the grant.
  if (!(tokenData.scope ?? "").split(" ").includes(DRIVE_FILE_SCOPE)) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokenData.access_token)}`, { method: "POST" }).catch(() => {});
    throw driveScopeError(400);
  }

  if (!tokenData.refresh_token) {
    throw new AppError(
      400,
      ERROR_CODES.DRIVE_OAUTH_FAILED,
      "No refresh token received. Please revoke Trussen access at https://myaccount.google.com/permissions and try again.",
    );
  }

  const userInfo = await safeParseJson<{ email?: string }>(
    await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${tokenData.access_token}` } }),
  );
  if (!userInfo.email) {
    throw new AppError(400, ERROR_CODES.DRIVE_OAUTH_FAILED, "Failed to retrieve Google account email");
  }

  const tokens = {
    accessToken: encrypt(tokenData.access_token),
    refreshToken: encrypt(tokenData.refresh_token),
    tokenExpiresAt: new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000),
    email: userInfo.email,
  };

  if (connectMode === "WORKSPACE") {
    try {
      await prisma.workspaceDriveConnection.create({ data: { workspaceId, connectedById: userId, ...tokens } });
    } catch (error) {
      // Another admin finished connecting between the check and here.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        await revokeAtGoogle(tokens.accessToken);
        const blocker = await workspaceDriveBlocker(workspaceId, userId);
        throw blocker ?? error;
      }
      throw error;
    }
    return { mode: connectMode, email: userInfo.email };
  }

  await prisma.userDriveConnection.upsert({
    where: { userId },
    create: { userId, provider: "google_drive", connected: true, ...tokens },
    update: { connected: true, ...tokens },
  });
  refreshLocks.delete(`PERSONAL:${userId}`);
  return { mode: connectMode, email: userInfo.email };
}

// ─── Status & settings ──────────────────────────────────────────────────────

/** Sharing levels allowed for a Drive, and what a stored setting falls back to when not allowed. */
function sharingFor(email: string, isWorkspaceDrive: boolean, allowPublic: boolean, setting: DriveSharingLevel) {
  // The switch governs members' personal Drives; admins set the Workspace Drive.
  const options = allowedSharingLevels(email, isWorkspaceDrive || allowPublic);
  const effective: DriveSharingLevel = options.includes(setting)
    ? setting
    : options.includes("COMPANY") ? "COMPANY" : "PRIVATE";
  return { options, effective };
}

/** Which Drive this member's uploads go to right now, or null if none is usable. */
async function resolveUploadTarget(userId: string, workspaceId: string): Promise<DriveOwner | null> {
  const [membership, personal, workspace] = await Promise.all([
    prisma.workspaceMembership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } }, select: { driveUploadTarget: true } }),
    loadConnection({ kind: "PERSONAL", userId }),
    prisma.workspaceDriveConnection.findUnique({ where: { workspaceId }, select: { id: true } }),
  ]);
  if (workspace && (membership?.driveUploadTarget !== "PERSONAL" || !personal)) return { kind: "WORKSPACE", workspaceId };
  if (personal) return { kind: "PERSONAL", userId };
  return null;
}

/** Everything the Drive settings and the upload button need, for this user in this workspace. */
export async function getConnectionStatus(userId: string, workspaceId: string, role: string) {
  const [personal, workspaceDrive, workspace, membership, target] = await Promise.all([
    loadConnection({ kind: "PERSONAL", userId }),
    prisma.workspaceDriveConnection.findUnique({
      where: { workspaceId },
      select: { email: true, defaultSharing: true, createdAt: true, connectedBy: { select: { id: true, name: true } } },
    }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { allowPublicDriveLinks: true } }),
    prisma.workspaceMembership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } }, select: { driveUploadTarget: true } }),
    resolveUploadTarget(userId, workspaceId),
  ]);
  const allowPublic = workspace?.allowPublicDriveLinks ?? true;
  const isAdmin = isAdminRole(role);

  const personalSharing = personal ? sharingFor(personal.email, false, allowPublic, personal.defaultSharing) : null;
  const workspaceSharing = workspaceDrive ? sharingFor(workspaceDrive.email, true, true, workspaceDrive.defaultSharing) : null;

  return {
    // Kept for the upload button: can this user upload to some Drive here?
    connected: target !== null,
    // Members aren't told which Google account holds the company Drive.
    email: target?.kind === "WORKSPACE" ? (isAdmin ? workspaceDrive?.email ?? null : null) : personal?.email ?? null,
    provider: target ? "google_drive" : null,
    uploadTarget: target?.kind ?? null,
    preferredTarget: membership?.driveUploadTarget ?? "WORKSPACE",
    canConnectWorkspace: isAdmin && !workspaceDrive,
    personal: personal && personalSharing
      ? { connected: true, email: personal.email, sharing: personalSharing.effective, sharingOptions: personalSharing.options }
      : { connected: false },
    workspace: workspaceDrive && workspaceSharing
      ? isAdmin
        ? {
            connected: true,
            email: workspaceDrive.email,
            connectedBy: workspaceDrive.connectedBy,
            connectedAt: workspaceDrive.createdAt,
            canManage: true,
            sharing: workspaceSharing.effective,
            sharingOptions: workspaceSharing.options,
          }
        // Members only learn it exists — not whose Google account it is.
        : { connected: true, canManage: false }
      : { connected: false },
  };
}

/** A member's own settings: who can open their personal Drive uploads, and where their uploads go. */
export async function updateMyDriveSettings(
  userId: string,
  workspaceId: string,
  input: { sharing?: DriveSharingLevel | undefined; uploadTarget?: "PERSONAL" | "WORKSPACE" | undefined },
) {
  if (input.sharing) {
    const personal = await loadConnection({ kind: "PERSONAL", userId });
    if (!personal) throw notConnected({ kind: "PERSONAL", userId });
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { allowPublicDriveLinks: true } });
    assertSharingAllowed(input.sharing, personal.email, workspace?.allowPublicDriveLinks ?? true);
    await prisma.userDriveConnection.update({ where: { userId }, data: { defaultSharing: input.sharing } });
  }
  if (input.uploadTarget) {
    await prisma.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId } },
      data: { driveUploadTarget: input.uploadTarget },
    });
  }
}

/** Admins only: who can open files uploaded to the Workspace Drive. */
export async function updateWorkspaceDriveSharing(workspaceId: string, sharing: DriveSharingLevel) {
  const connection = await loadConnection({ kind: "WORKSPACE", workspaceId });
  if (!connection) throw notConnected({ kind: "WORKSPACE", workspaceId });
  assertSharingAllowed(sharing, connection.email, true);
  await prisma.workspaceDriveConnection.update({ where: { workspaceId }, data: { defaultSharing: sharing } });
}

// ─── Disconnect ─────────────────────────────────────────────────────────────

/** Disconnect this user's personal Drive. Files already uploaded stay in their Drive. */
export async function disconnect(userId: string) {
  const connection = await prisma.userDriveConnection.findUnique({ where: { userId }, select: { connected: true, accessToken: true } });
  if (!connection || !connection.connected) {
    throw notConnected({ kind: "PERSONAL", userId });
  }
  refreshLocks.delete(`PERSONAL:${userId}`);
  await revokeAtGoogle(connection.accessToken);
  await prisma.userDriveConnection.delete({ where: { userId } });
}

/**
 * Remove the Workspace Drive: by an admin, or automatically when the admin who
 * connected it can't hold it any more. Files stay in that Google account.
 */
export async function disconnectWorkspaceDrive(workspaceId: string, options: { reason?: string; actorUserId?: string } = {}) {
  const connection = await prisma.workspaceDriveConnection.findUnique({ where: { workspaceId }, select: { accessToken: true } });
  if (!connection) throw notConnected({ kind: "WORKSPACE", workspaceId });
  await revokeAtGoogle(connection.accessToken);
  const removed = await prisma.workspaceDriveConnection.deleteMany({ where: { workspaceId } });
  if (removed.count > 0 && options.reason) await notifyAdmins(workspaceId, options.reason, options.actorUserId);
}

/**
 * Call when someone leaves a workspace, loses the admin role, or is offboarded:
 * a Workspace Drive they connected lives in their Google account, so it goes.
 */
export async function releaseWorkspaceDrivesOf(userId: string, workspaceId?: string) {
  const drives = await prisma.workspaceDriveConnection.findMany({
    where: { connectedById: userId, ...(workspaceId ? { workspaceId } : {}) },
    select: { workspaceId: true, connectedBy: { select: { name: true } } },
  });
  for (const drive of drives) {
    await disconnectWorkspaceDrive(drive.workspaceId, {
      reason: `${drive.connectedBy.name} connected it and is no longer an admin here, so it was disconnected. Connect a new one, ideally a shared company account.`,
    }).catch(() => null);
  }
}

// ─── Rename ─────────────────────────────────────────────────────────────────

/**
 * Rename a Drive file Trussen uploaded in this workspace. Its uploader can;
 * for the Workspace Drive, admins can too.
 */
export async function renameDriveFile(userId: string, workspaceId: string, role: string, fileId: string, newName: string) {
  if (!fileId || !/^[\w-]+$/.test(fileId)) {
    throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "Invalid Drive file ID");
  }
  const trimmed = newName.trim();
  if (!trimmed || trimmed.length > 255) {
    throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "File name must be 1-255 characters");
  }

  const record = await prisma.driveUpload.findFirst({ where: { driveFileId: fileId, workspaceId }, select: { id: true, uploaderId: true, target: true } });
  if (!record) throw new AppError(404, ERROR_CODES.DRIVE_FILE_NOT_FOUND, "File not found");
  const allowed = record.uploaderId === userId || (record.target === "WORKSPACE" && isAdminRole(role));
  if (!allowed) throw new AppError(403, ERROR_CODES.FORBIDDEN, "Only the person who uploaded this file can rename it");

  const owner: DriveOwner = record.target === "WORKSPACE" ? { kind: "WORKSPACE", workspaceId } : { kind: "PERSONAL", userId: record.uploaderId };
  return dropIfScopeMissing(owner, async () => {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${await getAccessToken(owner)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    if (!response.ok) {
      const errorBody = await safeParseJson<{ error?: { message?: string } }>(response);
      if (isScopeError(response.status, errorBody)) throw driveScopeError();
      throw new AppError(502, ERROR_CODES.DRIVE_UPLOAD_SESSION_FAILED, errorBody.error?.message || `Failed to rename file in Google Drive (HTTP ${response.status})`);
    }
    const result = await safeParseJson<{ id?: string; name?: string }>(response);
    await prisma.driveUpload.update({ where: { id: record.id }, data: { fileName: result.name ?? trimmed } });
    return { id: result.id ?? fileId, name: result.name ?? trimmed };
  });
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
    if (isScopeError(response.status, errorBody)) throw driveScopeError();
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
 * Upload a file to the Drive this member uploads to here (their own, or the
 * Workspace Drive), share it per that Drive's setting, and record it.
 *
 * Folders: Trussen/{workspaceName}/{teamName}/{projectName}/{issueIdentifier}/file.png
 *
 * Streamed from the temp file multer wrote through a resumable upload
 * session, so memory stays flat however large or concurrent uploads are (F-40).
 */
export async function uploadFileToDrive(
  userId: string,
  workspaceId: string,
  file: { path: string; originalname: string; mimetype: string; size: number },
  folderPath: string[],
) {
  const owner = await resolveUploadTarget(userId, workspaceId);
  if (!owner) throw notConnected({ kind: "PERSONAL", userId });

  const [connection, workspace] = await Promise.all([
    loadConnection(owner),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { allowPublicDriveLinks: true } }),
  ]);
  if (!connection) throw notConnected(owner);
  const { effective: requestedSharing } = sharingFor(
    connection.email, owner.kind === "WORKSPACE", workspace?.allowPublicDriveLinks ?? true, connection.defaultSharing,
  );

  return dropIfScopeMissing(owner, async () => {
    const accessToken = await getAccessToken(owner);
    const folderId = folderPath.length > 0 ? await resolveOrCreateFolderPath(accessToken, folderPath) : undefined;

    const session = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size,webViewLink",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": file.mimetype,
          "X-Upload-Content-Length": String(file.size),
        },
        body: JSON.stringify({ name: file.originalname, mimeType: file.mimetype, ...(folderId ? { parents: [folderId] } : {}) }),
      },
    );
    const sessionUrl = session.headers.get("location");
    if (!session.ok || !sessionUrl) {
      const errorBody = await safeParseJson<{ error?: { message?: string } }>(session);
      if (isScopeError(session.status, errorBody)) throw driveScopeError();
      throw new AppError(502, ERROR_CODES.DRIVE_UPLOAD_SESSION_FAILED, errorBody.error?.message || `Google Drive upload failed (HTTP ${session.status})`);
    }

    const uploadResponse = await fetch(sessionUrl, {
      method: "PUT",
      headers: { "Content-Type": file.mimetype, "Content-Length": String(file.size) },
      body: Readable.toWeb(createReadStream(file.path)) as unknown as BodyInit,
      duplex: "half",
    } as RequestInit);

    if (!uploadResponse.ok) {
      const errorBody = await safeParseJson<{ error?: { message?: string } }>(uploadResponse);
      if (isScopeError(uploadResponse.status, errorBody)) throw driveScopeError();
      throw new AppError(502, ERROR_CODES.DRIVE_UPLOAD_SESSION_FAILED, errorBody.error?.message || `Google Drive upload failed (HTTP ${uploadResponse.status})`);
    }

    const driveFile = await safeParseJson<{ id?: string; name?: string; mimeType?: string; size?: string; webViewLink?: string }>(uploadResponse);
    // Validated before it is used in any URL (alphanumeric + hyphens/underscores only)
    if (!driveFile.id || !/^[\w-]+$/.test(driveFile.id)) {
      throw new AppError(502, ERROR_CODES.DRIVE_UPLOAD_SESSION_FAILED, "Google Drive did not return a valid file ID");
    }

    const { sharing, notice } = await applyDriveSharing(accessToken, driveFile.id, requestedSharing, connection.email, { freshUpload: true });

    const result = {
      driveFileId: driveFile.id,
      driveUrl: driveFile.webViewLink ?? `https://drive.google.com/file/d/${driveFile.id}/view`,
      fileName: driveFile.name ?? file.originalname,
      mimeType: driveFile.mimeType ?? file.mimetype,
      sizeBytes: driveFile.size ? parseInt(driveFile.size, 10) : file.size,
      target: owner.kind,
      sharing,
      sharingNotice: notice,
    };

    await prisma.driveUpload.create({
      data: {
        workspaceId,
        uploaderId: userId,
        driveFileId: result.driveFileId,
        fileName: result.fileName,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
        webViewLink: result.driveUrl,
        sharing,
        target: owner.kind,
      },
    });

    return result;
  });
}

/** Sharing badges for the Drive attachments on screen (any member of the workspace). */
export async function listDriveFiles(workspaceId: string, ids: string[]) {
  return prisma.driveUpload.findMany({
    where: { workspaceId, driveFileId: { in: ids.slice(0, 100) } },
    select: { driveFileId: true, sharing: true, target: true },
  });
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
