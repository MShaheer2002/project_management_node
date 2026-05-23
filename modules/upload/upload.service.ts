import { env } from "../../config/env.js";
import { buildUploadKey, createPresignedPutUrl } from "../../infra/storage/s3.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import type {
  BatchUploadFileInput,
  CreatePresignedUrlInput,
  CreatePresignedUrlsInput,
  UploadKind,
} from "./upload.schemas.js";

const imageContentTypes = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const videoContentTypes = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

function normalizeContentType(contentType: string) {
  return contentType.trim().toLowerCase();
}

function isImageContentType(contentType: string) {
  return imageContentTypes.has(contentType);
}

function isVideoContentType(contentType: string) {
  return videoContentTypes.has(contentType);
}

function isAllowedContentType(kind: UploadKind, contentType: string) {
  switch (kind) {
    case "workspace-logo":
    case "avatar":
      return isImageContentType(contentType);
    case "video":
      return isVideoContentType(contentType);
    case "attachment":
      return isImageContentType(contentType) || isVideoContentType(contentType);
  }
}

function getMaxAllowedBytes(contentType: string) {
  return isVideoContentType(contentType)
    ? env.UPLOAD_VIDEO_MAX_BYTES
    : env.UPLOAD_IMAGE_MAX_BYTES;
}

function validateUploadInput(input: CreatePresignedUrlInput | BatchUploadFileInput) {
  const normalizedContentType = normalizeContentType(input.contentType);

  if (!isAllowedContentType(input.kind, normalizedContentType)) {
    throw new AppError(
      422,
      ERROR_CODES.UPLOAD_TYPE_NOT_ALLOWED,
      `Content type "${normalizedContentType}" is not allowed for upload kind "${input.kind}"`,
    );
  }

  const maxAllowedBytes = getMaxAllowedBytes(normalizedContentType);

  if (input.size > maxAllowedBytes) {
    throw new AppError(
      422,
      ERROR_CODES.UPLOAD_FILE_TOO_LARGE,
      `File size exceeds the ${maxAllowedBytes}-byte limit for "${input.kind}" uploads`,
    );
  }

  return normalizedContentType;
}

async function buildPresignedUpload(workspaceId: string, input: CreatePresignedUrlInput | BatchUploadFileInput) {
  const contentType = validateUploadInput(input);
  const key = buildUploadKey(workspaceId, input.kind, input.fileName, contentType);

  return createPresignedPutUrl(key, contentType);
}

export async function createPresignedUrl(workspaceId: string, input: CreatePresignedUrlInput) {
  return buildPresignedUpload(workspaceId, input);
}

export async function createPresignedUrls(workspaceId: string, input: CreatePresignedUrlsInput) {
  const uploads = await Promise.all(
    input.files.map(async (file) => ({
      clientId: file.clientId ?? null,
      ...(await buildPresignedUpload(workspaceId, file)),
    })),
  );

  return {
    uploads,
  };
}
