import { Router } from "express";

import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import * as controller from "./template.controller.js";
import {
  createTemplateSchema,
  duplicateTemplateSchema,
  listActiveTemplatesSchema,
  listTemplatesSchema,
  templateDefaultConfirmSchema,
  templateIdParamsSchema,
  updateTemplateSchema,
} from "./template.schemas.js";

const router = Router();

router.get("/templates/defaults", authenticate, requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.getDefaults);
router.get("/templates/active", authenticate, validate(listActiveTemplatesSchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.listActive);
router.get("/templates", authenticate, validate(listTemplatesSchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.list);
router.get("/templates/:id", authenticate, validate(templateIdParamsSchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.getById);

router.post("/templates", authenticate, validate(createTemplateSchema), requireWorkspace, requireRole("ADMIN", "OWNER"), controller.create);
router.patch("/templates/:id", authenticate, validate(updateTemplateSchema), requireWorkspace, requireRole("ADMIN", "OWNER"), controller.update);
router.delete("/templates/:id", authenticate, validate(templateIdParamsSchema), requireWorkspace, requireRole("ADMIN", "OWNER"), controller.remove);

router.post("/templates/:id/duplicate", authenticate, validate(duplicateTemplateSchema), requireWorkspace, requireRole("ADMIN", "OWNER"), controller.duplicate);
router.post("/templates/:id/apply", authenticate, validate(templateIdParamsSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.apply);
router.post("/templates/:id/activate", authenticate, validate(templateIdParamsSchema), requireWorkspace, requireRole("ADMIN", "OWNER"), controller.activate);
router.post("/templates/:id/activate/confirm", authenticate, validate(templateIdParamsSchema), requireWorkspace, requireRole("ADMIN", "OWNER"), controller.activateConfirm);
router.post("/templates/:id/default/confirm", authenticate, validate(templateDefaultConfirmSchema), requireWorkspace, requireRole("ADMIN", "OWNER"), controller.confirmDefault);
router.post("/templates/:id/deactivate", authenticate, validate(templateIdParamsSchema), requireWorkspace, requireRole("ADMIN", "OWNER"), controller.deactivate);

export default router;
