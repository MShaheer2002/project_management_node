import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { validate } from "../../shared/middleware/validate.js";
import { strictRateLimiter } from "../../shared/middleware/rate-limiter.js";
import * as controller from "./ai-connection.controller.js";
import {
  aiConnectionIdParamSchema,
  aiConnectionSessionListQuerySchema,
  createAiConnectionSchema,
  updateAiConnectionScopesSchema,
} from "./ai-connection.schemas.js";

const router = Router();

router.get(
  "/catalog",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.catalog,
);

router.get(
  "/",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.list,
);

router.get(
  "/:id/health",
  authenticate,
  validate(aiConnectionIdParamSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.getHealth,
);

router.get(
  "/:id/sessions",
  authenticate,
  validate(aiConnectionIdParamSchema),
  validate(aiConnectionSessionListQuerySchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.listSessions,
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

router.patch(
  "/:id/scopes",
  authenticate,
  validate(updateAiConnectionScopesSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.updateScopes,
);

router.post(
  "/:id/rotate",
  authenticate,
  validate(aiConnectionIdParamSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  strictRateLimiter,
  controller.rotate,
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
