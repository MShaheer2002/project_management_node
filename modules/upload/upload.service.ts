import { env } from "../../config/env.js";
import { buildUploadKey, createPresignedGetUrl, createPresignedPutUrl } from "../../infra/storage/s3.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import { prisma } from "../../shared/utils/prisma.js";
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

async function enforceStorageLimit(workspaceId: string, additionalBytes: number) {
  const subscription = await prisma.subscription.findUnique({
    where: { workspaceId },
    select: { plan: true, status: true, storageUsedBytes: true },
  });

  if (!subscription) return;

  const plan = subscription.status === "ACTIVE" || subscription.status === "TRIALING" || subscription.status === "PAST_DUE"
    ? subscription.plan
    : "FREE";

  const GIGABYTE = 1024 * 1024 * 1024;
  let storageLimitBytes: number | null = null;

  switch (plan) {
    case "FREE":
      storageLimitBytes = 2 * GIGABYTE;
      break;
    case "STANDARD":
      storageLimitBytes = 50 * GIGABYTE;
      break;
    case "PREMIUM":
      storageLimitBytes = null; // unlimited
      break;
  }

  if (storageLimitBytes === null) return;

  const currentUsage = Number(subscription.storageUsedBytes);

  if (currentUsage + additionalBytes > storageLimitBytes) {
    const limitLabel = plan === "FREE" ? "2 GB" : "50 GB";
    throw new AppError(
      409,
      ERROR_CODES.STORAGE_LIMIT_EXCEEDED,
      `Workspace storage limit of ${limitLabel} exceeded. Upgrade your plan for more storage.`,
    );
  }
}

async function buildPresignedUpload(workspaceId: string, input: CreatePresignedUrlInput | BatchUploadFileInput) {
  const contentType = validateUploadInput(input);
  const key = buildUploadKey(workspaceId, input.kind, input.fileName, contentType);

  return createPresignedPutUrl(key, contentType);
}

export async function createPresignedUrl(workspaceId: string, input: CreatePresignedUrlInput) {
  await enforceStorageLimit(workspaceId, input.size);
  return buildPresignedUpload(workspaceId, input);
}

export async function createPresignedUrls(workspaceId: string, input: CreatePresignedUrlsInput) {
  const totalSize = input.files.reduce((sum, file) => sum + file.size, 0);
  await enforceStorageLimit(workspaceId, totalSize);

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

export async function createViewUrl(workspaceId: string, key: string) {
  const normalizedKey = key.trim();
  const expectedPrefix = `${env.AWS_S3_UPLOAD_PREFIX.replace(/\/$/, "")}/workspaces/${workspaceId}/`;

  if (!normalizedKey.startsWith(expectedPrefix)) {
    throw new AppError(
      404,
      ERROR_CODES.NOT_FOUND,
      "Resource not found",
    );
  }

  return createPresignedGetUrl(normalizedKey, 300);
}
