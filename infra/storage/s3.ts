import { randomUUID } from "node:crypto";
import { extname } from "node:path";

import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
  requestChecksumCalculation: "WHEN_REQUIRED",
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

/**
 * The only logo a workspace may show: an image uploaded to its own
 * workspace-logo folder, served from our public asset host. The logo is
 * rendered on the public invite and sign-in pages, so an arbitrary URL let an
 * admin point it at a tracking server and log every invitee's IP, browser and
 * open time before they had even signed in (F-36).
 *
 * Mirrors buildUploadKey + buildPublicAssetUrl exactly; the file name must be
 * the UUID and image extension those generate, so nothing else (another
 * workspace's folder, a query string, a path trick) can match.
 */
const LOGO_FILE_PATTERN = /^\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(gif|jpg|png|webp)$/;

/** The S3 key behind a stored logo URL, or null if it isn't this workspace's own upload. */
export function workspaceLogoKey(workspaceId: string, url: string) {
  const folderKey = [env.AWS_S3_UPLOAD_PREFIX, "workspaces", workspaceId, "workspace-logo", ""].join("/");
  const folderUrl = buildPublicAssetUrl(folderKey);
  if (!folderUrl || !url.startsWith(folderUrl)) return null;
  const file = url.slice(folderUrl.length);
  return LOGO_FILE_PATTERN.test(file) ? `${folderKey}${file}` : null;
}

export function isWorkspaceLogoUrl(workspaceId: string, url: string) {
  return workspaceLogoKey(workspaceId, url) !== null;
}

/**
 * Headers bound into the presigned PUT signature.
 *
 * Plan/quota limits are checked against the size the *client declares* when
 * asking for the URL. The URL itself used to sign only `host`, so the client
 * could declare 1 byte, get a valid URL, and PUT 5 GB of any content type —
 * storing arbitrarily large objects while reporting 1 byte of usage (F-12).
 *
 * Signing these makes S3 the enforcer: a PUT whose Content-Length or
 * Content-Type differs from what was declared fails the signature check.
 * Browsers set Content-Length from the body themselves and refuse to let
 * scripts forge it, so the declared size must equal the real one.
 */
export const PRESIGN_SIGNABLE_HEADERS = new Set(["content-length", "content-type"]);

export async function createPresignedPutUrl(key: string, contentType: string, contentLength: number) {
  const command = new PutObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  });

  const uploadUrl = await getSignedUrl(s3Client, command, {
    expiresIn: env.AWS_S3_URL_TTL_SECONDS,
    signableHeaders: PRESIGN_SIGNABLE_HEADERS,
  });

  return {
    uploadUrl,
    method: "PUT" as const,
    headers: {
      "Content-Type": contentType,
    },
    // Informational: the signature is bound to this exact byte count. Browsers
    // set the header from the body, so callers there must not send it manually.
    contentLength,
    key,
    expiresIn: env.AWS_S3_URL_TTL_SECONDS,
    assetUrl: buildPublicAssetUrl(key),
  };
}

export async function createPresignedGetUrl(key: string, expiresIn = 300) {
  const command = new GetObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: key,
  });

  const url = await getSignedUrl(s3Client, command, {
    expiresIn,
  });

  return {
    url,
    key,
    expiresIn,
  };
}

/**
 * Delete every object under `prefix`. Idempotent — an empty prefix is a no-op,
 * so a retried purge simply finds nothing left. Throws on any per-object
 * failure so the caller retries instead of reporting a partial wipe as done.
 */
export async function deleteObjectsWithPrefix(prefix: string) {
  if (!prefix.endsWith("/") || prefix.length < 2) {
    throw new Error(`Refusing to delete an unterminated S3 prefix: "${prefix}"`);
  }

  let deleted = 0;
  let continuationToken: string | undefined;
  do {
    const page = await s3Client.send(new ListObjectsV2Command({
      Bucket: env.AWS_S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    const keys = (page.Contents ?? []).flatMap((object) => (object.Key ? [{ Key: object.Key }] : []));

    if (keys.length > 0) {
      // ListObjectsV2 pages hold at most 1000 keys, which is DeleteObjects' limit.
      const result = await s3Client.send(new DeleteObjectsCommand({
        Bucket: env.AWS_S3_BUCKET,
        Delete: { Objects: keys, Quiet: true },
      }));
      if (result.Errors?.length) {
        throw new Error(`S3 refused to delete ${result.Errors.length} object(s) under ${prefix}: ${result.Errors[0]?.Code ?? "unknown"}`);
      }
      deleted += keys.length;
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
}
