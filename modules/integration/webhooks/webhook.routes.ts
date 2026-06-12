/**
 * Integration Webhooks — Route Definitions
 *
 * Inbound webhook endpoints for external services.
 * These routes have NO auth middleware — they verify signatures internally.
 *
 * Routes:
 *   POST /webhooks/github          — GitHub push/PR/review events
 *   POST /webhooks/slack/commands  — Slack slash commands
 */

import { Router } from "express";

const router = Router();

// GitHub webhook — signature verified in the controller
router.post("/github", async (req, res, next) => {
  try {
    const { githubWebhook } = await import("../github/github.controller.js");
    return githubWebhook(req, res, next);
  } catch (error) {
    next(error);
  }
});

// Slack slash commands — signature verified in the controller
router.post("/slack/commands", async (req, res, next) => {
  try {
    const { slackCommandsWebhook } = await import("../slack/slack.controller.js");
    return slackCommandsWebhook(req, res, next);
  } catch (error) {
    next(error);
  }
});

export default router;
