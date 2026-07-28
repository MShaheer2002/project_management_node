/**
 * Integration Module — Route Aggregator
 *
 * Mounts provider-specific sub-routers under /integrations/:
 *   /integrations/         — List all integrations (shared)
 *   /integrations/github/  — GitHub-specific routes
 *   /integrations/slack/   — Slack-specific routes
 *   /integrations/discord/ — Discord-specific routes
 *
 * Each provider has its own routes, controller, service, and schemas.
 * No shared settings endpoint — each provider validates its own shape.
 */

import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { sendSuccess } from "../../shared/utils/api-response.js";
import { listIntegrations, disconnectProvider } from "./integration.service.js";
import { requireRole } from "../../shared/middleware/require-role.js";

const router = Router();

// ─── Shared: List all integrations ───────────────────────────────────────────

router.get("/", authenticate, requireWorkspace, requireRole("ADMIN", "OWNER"), async (req, res, next) => {
  try {
    const integrations = await listIntegrations(req.workspace!.id);
    sendSuccess(res, 200, integrations);
  } catch (error) {
    next(error);
  }
});

// ─── Shared: Disconnect any provider ─────────────────────────────────────────

router.delete("/:provider/disconnect", authenticate, requireWorkspace, requireRole("ADMIN", "OWNER"), async (req, res, next) => {
  try {
    await disconnectProvider(req.workspace!.id, req.params.provider as string, req.user!.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// ─── Provider Sub-Routers (lazy-loaded to avoid circular imports) ────────────

router.use("/github", async (req, res, next) => {
  try {
    const { default: githubRoutes } = await import("./github/github.routes.js");
    return githubRoutes(req, res, next);
  } catch (error) {
    next(error);
  }
});

router.use("/slack", async (req, res, next) => {
  try {
    const { default: slackRoutes } = await import("./slack/slack.routes.js");
    return slackRoutes(req, res, next);
  } catch (error) {
    next(error);
  }
});

router.use("/discord", async (req, res, next) => {
  try {
    const { default: discordRoutes } = await import("./discord/discord.routes.js");
    return discordRoutes(req, res, next);
  } catch (error) {
    next(error);
  }
});

router.use("/figma", async (req, res, next) => {
  try {
    const { default: figmaRoutes } = await import("./figma/figma.routes.js");
    return figmaRoutes(req, res, next);
  } catch (error) {
    next(error);
  }
});

export default router;
