/**
 * Sharing for files Trussen uploads to a user's Google Drive (F-39).
 *
 * Uploads used to be made "anyone with the link" unconditionally, so every
 * Drive attachment was public and silently overrode the customer's own Drive
 * sharing policy. The uploader now chooses:
 *   PRIVATE — only them (the default; teammates use Google's "Request access")
 *   COMPANY — anyone signed in to their Google Workspace domain with the link
 *   PUBLIC  — anyone with the link, only if the workspace admin allows it
 * If Google refuses a share (an org policy, or a domain that isn't a Google
 * Workspace domain), the file is left private — never more open than asked.
 */
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";

export type DriveSharingLevel = "PRIVATE" | "COMPANY" | "PUBLIC";

/** The one Drive permission Trussen needs: files it creates, nothing else. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const SCOPE_MISSING_MESSAGE =
  "Trussen doesn't have permission to add files to your Google Drive. Connect Google Drive again and tick the Google Drive box on Google's permission screen.";

/**
 * Google's consent screen lets people untick individual permissions. Without
 * the Drive one, every Drive call fails with "insufficient authentication
 * scopes" — surfaced as one clear, actionable error.
 */
export function isScopeError(status: number, body: unknown) {
  return status === 403 && /insufficient[^"]*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(JSON.stringify(body ?? ""));
}

export function driveScopeError(status = 403) {
  return new AppError(status, ERROR_CODES.DRIVE_SCOPE_MISSING, SCOPE_MISSING_MESSAGE);
}

/** Personal Google accounts: no organisation to share with. */
const CONSUMER_GOOGLE_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** The Google Workspace domain to share with, or null for a personal account. */
export function companyDomainOf(email: string | null | undefined): string | null {
  const domain = email?.split("@")[1]?.trim().toLowerCase();
  return domain && !CONSUMER_GOOGLE_DOMAINS.has(domain) ? domain : null;
}

/** What this uploader may choose in this workspace — the UI shows exactly these. */
export function allowedSharingLevels(email: string | null | undefined, allowPublic: boolean): DriveSharingLevel[] {
  return [
    "PRIVATE",
    ...(companyDomainOf(email) ? (["COMPANY"] as const) : []),
    ...(allowPublic ? (["PUBLIC"] as const) : []),
  ];
}

export function assertSharingAllowed(level: DriveSharingLevel, email: string | null | undefined, allowPublic: boolean) {
  if (!allowedSharingLevels(email, allowPublic).includes(level)) {
    throw new AppError(
      403,
      ERROR_CODES.DRIVE_SHARING_NOT_ALLOWED,
      level === "PUBLIC"
        ? "Public Google Drive links are turned off for this workspace."
        : "Company sharing needs a Google Workspace (company) account.",
    );
  }
}

const API = "https://www.googleapis.com/drive/v3/files";

type Permission = { id: string; type: string };

async function listLinkPermissions(accessToken: string, fileId: string): Promise<Permission[]> {
  const response = await fetch(`${API}/${fileId}/permissions?fields=permissions(id,type)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    if (isScopeError(response.status, errorBody)) throw driveScopeError();
    throw new AppError(502, ERROR_CODES.DRIVE_SHARING_FAILED, `Could not read the file's sharing from Google Drive (HTTP ${response.status})`);
  }
  const body = (await response.json().catch(() => ({}))) as { permissions?: Permission[] };
  return (body.permissions ?? []).filter((p) => p.type === "anyone" || p.type === "domain");
}

/**
 * Put the file at `level`. Link-wide access is removed first and only then
 * added back as asked, so a failure part-way leaves the file *more* private,
 * never less. Returns the level actually in effect.
 */
export async function applyDriveSharing(
  accessToken: string,
  fileId: string,
  level: DriveSharingLevel,
  uploaderEmail: string | null,
  options: { freshUpload?: boolean } = {},
): Promise<{ sharing: DriveSharingLevel; notice: string | null }> {
  // A file we just created has no link permissions yet — skip the round trip.
  if (!options.freshUpload) {
    for (const permission of await listLinkPermissions(accessToken, fileId)) {
      const response = await fetch(`${API}/${fileId}/permissions/${permission.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok && response.status !== 404) {
        throw new AppError(502, ERROR_CODES.DRIVE_SHARING_FAILED, `Google Drive refused to change the file's sharing (HTTP ${response.status})`);
      }
    }
  }

  if (level === "PRIVATE") return { sharing: "PRIVATE", notice: null };

  const domain = companyDomainOf(uploaderEmail);
  const permission = level === "PUBLIC"
    ? { role: "reader", type: "anyone", allowFileDiscovery: false }
    : { role: "reader", type: "domain", domain, allowFileDiscovery: false };

  const response = await fetch(`${API}/${fileId}/permissions?sendNotificationEmail=false`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(permission),
  }).catch(() => null);

  if (!response?.ok) {
    return {
      sharing: "PRIVATE",
      notice: level === "PUBLIC"
        ? "Your Google organisation doesn't allow public links, so the file was kept private."
        : "Your Google organisation doesn't allow sharing with the whole company, so the file was kept private.",
    };
  }
  return { sharing: level, notice: null };
}
