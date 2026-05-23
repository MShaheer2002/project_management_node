import type { RequestHandler } from "express";

import { sendSuccess } from "../../shared/utils/api-response.js";
import type { CreatePresignedUrlInput, CreatePresignedUrlsInput } from "./upload.schemas.js";
import {
  createPresignedUrl as createPresignedUrlService,
  createPresignedUrls as createPresignedUrlsService,
} from "./upload.service.js";

export const createPresignedUrl: RequestHandler = async (req, res) => {
  const upload = await createPresignedUrlService(
    req.workspace!.id,
    req.body as CreatePresignedUrlInput,
  );

  sendSuccess(res, 200, upload);
};

export const createPresignedUrls: RequestHandler = async (req, res) => {
  const uploads = await createPresignedUrlsService(
    req.workspace!.id,
    req.body as CreatePresignedUrlsInput,
  );

  sendSuccess(res, 200, uploads);
};
