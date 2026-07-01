import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { validate } from "../../shared/middleware/validate.js";
import { strictRateLimiter } from "../../shared/middleware/rate-limiter.js";
import * as controller from "./ai-connection.controller.js";
import {
  aiConnectionIdParamSchema,
  createAiConnectionSchema,
} from "./ai-connection.schemas.js";

const router = Router();

router.get(
  "/",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.list,
);

router.post(
  "/",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  strictRateLimiter,
  validate(createAiConnectionSchema),
  controller.create,
);

router.delete(
  "/:id",
  authenticate,
  validate(aiConnectionIdParamSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.revoke,
);

export default router;
