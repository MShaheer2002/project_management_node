/**
 * Help Routes — in-app help articles (content/help/*.md)
 *
 *   GET /help/articles      — list, filtered to the member's role
 *   GET /help/articles/:id  — one article
 *   GET /help/search?q=     — hybrid keyword + meaning search, rate limited per user
 *   GET /help/insights      — Trussen staff only: anonymized AI Assistance insights
 *   GET /help/insights/access
 *
 * Any workspace member, every plan.
 */
import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import { helpSearchUserRateLimiter } from "../../shared/middleware/rate-limiter.js";
import * as controller from "./help.controller.js";
import { helpArticleParamsSchema, helpInsightsSchema, helpSearchSchema } from "./help.schemas.js";

const router = Router();

router.get("/articles", authenticate, requireWorkspace, controller.list);
router.get("/articles/:id", authenticate, validate(helpArticleParamsSchema), requireWorkspace, controller.getById);
router.get("/search", authenticate, validate(helpSearchSchema), requireWorkspace, helpSearchUserRateLimiter, controller.search);

// Staff only, not tied to a workspace: checked against HELP_INSIGHTS_STAFF_EMAILS.
router.get("/insights/access", authenticate, controller.insightsAccess);
router.get("/insights", authenticate, validate(helpInsightsSchema), controller.insights);

export default router;
