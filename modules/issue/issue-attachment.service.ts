import { env } from "../../config/env.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";

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

  validateAttachmentRefs(workspaceId, attachments);

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
}
