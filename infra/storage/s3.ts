import { randomUUID } from "node:crypto";
import { extname } from "node:path";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { env } from "../../config/env.js";

const contentTypeExtensions: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

const s3Client = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
  },
});

function normalizeExtension(fileName: string, contentType: string) {
  const mappedExtension = contentTypeExtensions[contentType];

  if (mappedExtension) {
    return mappedExtension;
  }

  const extension = extname(fileName).slice(1).toLowerCase();

  if (extension.length > 0 && extension.length <= 10 && /^[a-z0-9]+$/.test(extension)) {
    return extension;
  }

  return "bin";
}

function buildPublicAssetUrl(key: string) {
  if (!env.AWS_S3_PUBLIC_BASE_URL) {
    return null;
  }

  return `${env.AWS_S3_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;
}

export function buildUploadKey(workspaceId: string, kind: string, fileName: string, contentType: string) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const extension = normalizeExtension(fileName, contentType);

  return [
    env.AWS_S3_UPLOAD_PREFIX,
    "workspaces",
    workspaceId,
    kind,
    String(year),
    month,
    `${randomUUID()}.${extension}`,
  ].join("/");
}

export async function createPresignedPutUrl(key: string, contentType: string) {
  const command = new PutObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3Client, command, {
    expiresIn: env.AWS_S3_URL_TTL_SECONDS,
  });

  return {
    uploadUrl,
    method: "PUT" as const,
    headers: {
      "Content-Type": contentType,
    },
    key,
    expiresIn: env.AWS_S3_URL_TTL_SECONDS,
    assetUrl: buildPublicAssetUrl(key),
  };
}
