import { Router } from "express";

import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import * as controller from "./activity.controller.js";
import { issueActivitySchema, listActivitySchema } from "./activity.schemas.js";

const router = Router();

router.get("/activity", authenticate, validate(listActivitySchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.list);
router.get("/issues/:issueId/activity", authenticate, validate(issueActivitySchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.listIssueActivity);

export default router;
