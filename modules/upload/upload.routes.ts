import { Router } from "express";

import { authenticate } from "../../shared/middleware/authenticate.js";
import { strictRateLimiter } from "../../shared/middleware/rate-limiter.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import { createPresignedUrl, createPresignedUrls, getViewUrl } from "./upload.controller.js";
import { createPresignedUrlSchema, createPresignedUrlsSchema, getViewUrlSchema } from "./upload.schemas.js";

const router = Router();

router.post(
  "/presigned-url",
  authenticate,
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  strictRateLimiter,
  validate(createPresignedUrlSchema),
  createPresignedUrl,
);

router.post(
  "/presigned-urls",
  authenticate,
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  strictRateLimiter,
  validate(createPresignedUrlsSchema),
  createPresignedUrls,
);

router.get(
  "/view-url",
  authenticate,
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  strictRateLimiter,
  validate(getViewUrlSchema),
  getViewUrl,
);

export default router;
