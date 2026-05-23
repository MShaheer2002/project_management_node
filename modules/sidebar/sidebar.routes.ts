/**
 * Sidebar Module — Route Definitions
 *
 * Routes:
*   GET /sidebar — Workspace-scoped app shell data
 */

import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import * as controller from "./sidebar.controller.js";

const router = Router();

router.get("/", authenticate, requireWorkspace, controller.getSidebar);

export default router;
