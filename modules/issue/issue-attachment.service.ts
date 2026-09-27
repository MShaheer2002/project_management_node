import { env } from "../../config/env.js";
import { isWebLink } from "../../shared/utils/web-link.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { incrementStorageUsage } from "../billing/billing.service.js";
import { prisma } from "../../shared/utils/prisma.js";

interface AttachmentInput {
  key: string;
  fileName: string;
  contentType: string;
  size: number;
  kind: "attachment" | "video";
  assetUrl?: string | null | undefined;
}

const allowedImageTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const allowedVideoTypes = new Set(["video/mp4", "video/quicktime", "video/webm"]);

function isAllowedType(contentType: string) {
  return allowedImageTypes.has(contentType) || allowedVideoTypes.has(contentType);
}

export function validateAttachmentRefs(workspaceId: string, attachments: AttachmentInput[]) {
  const uploadPrefix = env.AWS_S3_UPLOAD_PREFIX.replace(/\/$/, "");
  const workspacePrefix = `${uploadPrefix}/workspaces/${workspaceId}/`;

  for (const attachment of attachments) {
    if (!attachment.key.startsWith(workspacePrefix)) {
      throw new AppError(
        422,
        ERROR_CODES.ATTACHMENT_KEY_WORKSPACE_MISMATCH,
        "Attachment key does not belong to active workspace",
      );
    }

    const normalizedType = attachment.contentType.trim().toLowerCase();
    if (!isAllowedType(normalizedType)) {
      throw new AppError(422, ERROR_CODES.ATTACHMENT_TYPE_NOT_ALLOWED, "Attachment content type is not allowed");
    }

    if (attachment.kind === "video" && !allowedVideoTypes.has(normalizedType)) {
      throw new AppError(422, ERROR_CODES.ATTACHMENT_TYPE_NOT_ALLOWED, "Invalid video attachment type");
    }
  }
}

function workspaceUploadPrefix(workspaceId: string) {
  return `${env.AWS_S3_UPLOAD_PREFIX.replace(/\/$/, "")}/workspaces/${workspaceId}/`;
}

/** Stored in our S3 bucket (counts toward the storage quota) — the alternative is a Google Drive link. */
export function isStoredAttachment(workspaceId: string, key: string) {
  return key.startsWith(workspaceUploadPrefix(workspaceId));
}

/** Bytes these attachments add to the workspace's S3 storage; Drive files live in the user's Drive. */
export function storedAttachmentBytes(workspaceId: string, attachments: Array<{ key: string; size: number }>) {
  return attachments.filter((a) => isStoredAttachment(workspaceId, a.key)).reduce((sum, a) => sum + a.size, 0);
}

type Db = { driveUpload: typeof prisma.driveUpload };

/**
 * Validate attachment references from the client and return them ready to
 * store. S3 uploads must sit in this workspace's folder (validateAttachmentRefs).
 * Anything else must be a Google Drive file Trussen uploaded for this
 * workspace (DriveUpload) — Drive attachments were rejected outright before,
 * even though the upload itself had already happened (F-39). The link, type
 * and size come from that record, never from the client, so an attachment
 * can't point anywhere else.
 */
export async function resolveAttachmentRefs<T extends AttachmentInput>(db: Db, workspaceId: string, attachments: T[]): Promise<T[]> {
  // A client supplied link on an upload must be a web link (N-06).
  attachments = attachments.map((a) => (a.assetUrl && !isWebLink(a.assetUrl) ? { ...a, assetUrl: null } : a));
  const stored = attachments.filter((a) => isStoredAttachment(workspaceId, a.key));
  validateAttachmentRefs(workspaceId, stored);

  const driveRefs = attachments.filter((a) => !isStoredAttachment(workspaceId, a.key));
  if (driveRefs.length === 0) return attachments;

  const records = await db.driveUpload.findMany({
    where: { workspaceId, driveFileId: { in: driveRefs.map((a) => a.key) } },
    select: { driveFileId: true, webViewLink: true, mimeType: true, sizeBytes: true },
  });
  const byId = new Map(records.map((r) => [r.driveFileId, r]));

  return attachments.map((attachment) => {
    if (isStoredAttachment(workspaceId, attachment.key)) return attachment;
    const record = byId.get(attachment.key);
    if (!record) {
      throw new AppError(422, ERROR_CODES.ATTACHMENT_KEY_WORKSPACE_MISMATCH, "Attachment key does not belong to active workspace");
    }
    return { ...attachment, assetUrl: record.webViewLink, contentType: record.mimeType, size: record.sizeBytes };
  });
}

export async function createIssueAttachments(
  tx: any,
  issueId: string,
  workspaceId: string,
  createdById: string,
  attachments: AttachmentInput[],
) {
  if (attachments.length === 0) {
    return;
  }

  attachments = await resolveAttachmentRefs(tx, workspaceId, attachments);

  await tx.issueAttachment.createMany({
    data: attachments.map((attachment) => ({
      issueId,
      workspaceId,
      key: attachment.key,
      fileName: attachment.fileName,
      contentType: attachment.contentType.trim().toLowerCase(),
      size: attachment.size,
      kind: attachment.kind,
      assetUrl: attachment.assetUrl ?? null,
      createdById,
    })),
    skipDuplicates: true,
  });

  await incrementStorageUsage(workspaceId, storedAttachmentBytes(workspaceId, attachments));
}
