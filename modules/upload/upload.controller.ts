import type { RequestHandler } from "express";

import { env } from "../../config/env.js";
import { sendSuccess } from "../../shared/utils/api-response.js";
import type { CreatePresignedUrlInput, CreatePresignedUrlsInput, GetViewUrlInput } from "./upload.schemas.js";
import {
  createPresignedUrl as createPresignedUrlService,
  createPresignedUrls as createPresignedUrlsService,
  createViewUrl as createViewUrlService,
} from "./upload.service.js";

export const createPresignedUrl: RequestHandler = async (req, res) => {
  if (env.NODE_ENV !== "production") {
    console.log("[Upload] createPresignedUrl request", {
      workspaceId: req.workspace?.id,
      userId: req.user?.id,
      payload: req.body,
    });
  }

  const upload = await createPresignedUrlService(
    req.workspace!.id,
    req.body as CreatePresignedUrlInput,
  );

  if (env.NODE_ENV !== "production") {
    console.log("[Upload] createPresignedUrl response", {
      workspaceId: req.workspace?.id,
      key: upload.key,
      expiresIn: upload.expiresIn,
      contentType: upload.headers["Content-Type"],
      hasAssetUrl: Boolean(upload.assetUrl),
    });
  }

  sendSuccess(res, 200, upload);
};

export const createPresignedUrls: RequestHandler = async (req, res) => {
  if (env.NODE_ENV !== "production") {
    console.log("[Upload] createPresignedUrls request", {
      workspaceId: req.workspace?.id,
      userId: req.user?.id,
      fileCount: Array.isArray((req.body as CreatePresignedUrlsInput).files)
        ? (req.body as CreatePresignedUrlsInput).files.length
        : 0,
      payload: req.body,
    });
  }

  const uploads = await createPresignedUrlsService(
    req.workspace!.id,
    req.body as CreatePresignedUrlsInput,
  );

  if (env.NODE_ENV !== "production") {
    console.log("[Upload] createPresignedUrls response", {
      workspaceId: req.workspace?.id,
      uploadCount: uploads.uploads.length,
      keys: uploads.uploads.map((upload) => upload.key),
    });
  }

  sendSuccess(res, 200, uploads);
};

export const getViewUrl: RequestHandler = async (req, res) => {
  const query = req.validated?.query as GetViewUrlInput | undefined;
  const key = query?.key ?? (req.query.key as string | undefined);

  if (env.NODE_ENV !== "production") {
    console.log("[Upload] getViewUrl request", {
      workspaceId: req.workspace?.id,
      userId: req.user?.id,
      key,
    });
  }

  const url = await createViewUrlService(req.workspace!.id, key ?? "");

  if (env.NODE_ENV !== "production") {
    console.log("[Upload] getViewUrl response", {
      workspaceId: req.workspace?.id,
      key: url.key,
      expiresIn: url.expiresIn,
    });
  }

  sendSuccess(res, 200, url);
};
