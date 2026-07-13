import { Router } from "express";

import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import * as controller from "./cycle.controller.js";
import {
  assignIssueCycleSchema,
  carryOverSchema,
  createCycleSchema,
  cycleIdParamsSchema,
  listCyclesSchema,
  listCycleIssuesSchema,
  planCycleIssuesSchema,
  removeCycleIssueSchema,
  removeIssueCycleSchema,
  updateCycleSchema,
} from "./cycle.schemas.js";

const router = Router();

router.post("/cycles", authenticate, validate(createCycleSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.create);
router.get("/cycles", authenticate, validate(listCyclesSchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.list);
router.get("/cycles/current", authenticate, requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.current);
router.get("/cycles/:id", authenticate, validate(cycleIdParamsSchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.getById);
router.patch("/cycles/:id", authenticate, validate(updateCycleSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.update);
router.delete("/cycles/:id", authenticate, validate(cycleIdParamsSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.remove);
router.post("/cycles/:id/complete", authenticate, validate(cycleIdParamsSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.complete);
router.post("/cycles/:id/reopen", authenticate, validate(cycleIdParamsSchema), requireWorkspace, requireRole("ADMIN", "OWNER"), controller.reopen);
router.post("/cycles/:id/carry-over", authenticate, validate(carryOverSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.carryOver);
router.get("/cycles/:id/issues", authenticate, validate(listCycleIssuesSchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.listIssues);
router.post("/cycles/:id/issues", authenticate, validate(planCycleIssuesSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.planIssues);
router.delete("/cycles/:id/issues/:issueId", authenticate, validate(removeCycleIssueSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.removePlannedIssue);

router.post("/issues/:id/cycle", authenticate, validate(assignIssueCycleSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.assignIssue);
router.delete("/issues/:id/cycle", authenticate, validate(removeIssueCycleSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.removeIssue);

export default router;
