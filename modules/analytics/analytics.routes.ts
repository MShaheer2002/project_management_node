import { Router } from "express";

import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import * as controller from "./analytics.controller.js";
import {
  analyticsQuerySchema,
  cycleAnalyticsParamsSchema,
  exportQuerySchema,
  memberAnalyticsParamsSchema,
  projectAnalyticsParamsSchema,
  teamAnalyticsParamsSchema,
} from "./analytics.schemas.js";

const router = Router();

router.get("/analytics/workspace", authenticate, validate(analyticsQuerySchema), requireWorkspace, requireRole("ADMIN", "OWNER"), controller.getWorkspaceAnalytics);
router.get("/analytics/projects/:id", authenticate, validate({ ...projectAnalyticsParamsSchema, ...analyticsQuerySchema }), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.getProjectAnalytics);
router.get("/analytics/teams/:id", authenticate, validate({ ...teamAnalyticsParamsSchema, ...analyticsQuerySchema }), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.getTeamAnalytics);
router.get("/analytics/members/:id", authenticate, validate({ ...memberAnalyticsParamsSchema, ...analyticsQuerySchema }), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.getMemberAnalytics);
router.get("/analytics/cycles/:id", authenticate, validate({ ...cycleAnalyticsParamsSchema, ...analyticsQuerySchema }), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.getCycleAnalytics);
router.get("/analytics/export", authenticate, validate(exportQuerySchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.exportAnalytics);

export default router;
