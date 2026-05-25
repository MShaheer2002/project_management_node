import { Router } from "express";

import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import * as controller from "./label.controller.js";
import {
  attachIssueLabelsSchema,
  createLabelSchema,
  deleteLabelSchema,
  listLabelsSchema,
  removeIssueLabelSchema,
  updateLabelSchema,
} from "./label.schemas.js";

const router = Router();

router.post("/labels", authenticate, validate(createLabelSchema), requireWorkspace, requireRole("ADMIN", "OWNER"), controller.create);
router.get("/labels", authenticate, validate(listLabelsSchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.list);
router.patch("/labels/:labelId", authenticate, validate(updateLabelSchema), requireWorkspace, requireRole("ADMIN", "OWNER"), controller.update);
router.delete("/labels/:labelId", authenticate, validate(deleteLabelSchema), requireWorkspace, requireRole("ADMIN", "OWNER"), controller.remove);

router.post("/issues/:issueId/labels", authenticate, validate(attachIssueLabelsSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.attachToIssue);
router.delete("/issues/:issueId/labels/:labelId", authenticate, validate(removeIssueLabelSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.removeFromIssue);

export default router;
