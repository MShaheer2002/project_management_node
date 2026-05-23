/**
 * Dashboard Module — Route Definitions
 *
 * Routes:
 *   GET /dashboard — Workspace dashboard aggregate
 */

import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import * as controller from "./dashboard.controller.js";

const router = Router();

router.get("/", authenticate, requireWorkspace, controller.getOverview);

export default router;
