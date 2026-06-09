import { env } from "../../config/env.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import type { DocumentDraftInput } from "./documents.schemas.js";

const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

const allowedDocumentTypes = new Set([
  "application/msword",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/csv",
  "text/markdown",
  "text/plain",
]);

function getWorkspacePrefix(workspaceId: string) {
  const uploadPrefix = env.AWS_S3_UPLOAD_PREFIX.replace(/\/$/, "");
  return `${uploadPrefix}/workspaces/${workspaceId}/`;
}

export function validateDocumentRef(workspaceId: string, file: DocumentDraftInput["file"]) {
  if (!file.key.startsWith(getWorkspacePrefix(workspaceId))) {
    throw new AppError(
      422,
      ERROR_CODES.DOCUMENT_KEY_WORKSPACE_MISMATCH,
      "Document key does not belong to the active workspace",
    );
  }

  const normalizedType = file.contentType.trim().toLowerCase();

  if (!allowedDocumentTypes.has(normalizedType)) {
    throw new AppError(422, ERROR_CODES.DOCUMENT_TYPE_NOT_ALLOWED, "Document content type is not allowed");
  }

  if (file.size > DOCUMENT_MAX_BYTES) {
    throw new AppError(422, ERROR_CODES.UPLOAD_FILE_TOO_LARGE, "Document file size exceeds the 10 MB limit");
  }

  return {
    key: file.key,
    fileName: file.fileName,
    mimeType: normalizedType,
    sizeBytes: file.size,
    fileUrl: file.assetUrl ?? null,
  };
}
