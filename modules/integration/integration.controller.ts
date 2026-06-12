/**
 * Integration Module — Controller
 *
 * Handles HTTP request parsing and response sending.
 * Controllers are DUMB — parse request, call service, send response.
 */

import type { RequestHandler } from "express";
import * as integrationService from "./integration.service.js";
import * as slackService from "./slack.service.js";
import { sendSuccess } from "../../shared/utils/api-response.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { verifyGitHubSignature } from "./github.utils.js";
import { verifySlackSignature } from "./slack.utils.js";
import { env } from "../../config/env.js";

// ─── Integration Management ─────────────────────────────────────────────────

/** GET /integrations — List all integrations and their status */
export const list: RequestHandler = async (req, res, next) => {
  try {
    const integrations = await integrationService.listIntegrations(req.workspace!.id);
    sendSuccess(res, 200, integrations);
  } catch (error) {
    next(error);
  }
};

/** POST /integrations/:provider/connect — Start OAuth flow */
export const connect: RequestHandler = async (req, res, next) => {
  try {
    const provider = req.params.provider as string;

    if (provider === "github") {
      const authUrl = integrationService.getGitHubAuthUrl(req.workspace!.id, req.user!.id);
      sendSuccess(res, 200, { authUrl });
      return;
    }

    if (provider === "slack") {
      const authUrl = slackService.getSlackAuthUrl(req.workspace!.id, req.user!.id);
      sendSuccess(res, 200, { authUrl });
      return;
    }

    // Other providers not yet implemented
    throw new AppError(400, ERROR_CODES.INTEGRATION_PROVIDER_INVALID, `${provider} integration is not yet available`);
  } catch (error) {
    next(error);
  }
};

/** GET /integrations/:provider/callback — OAuth callback */
export const oauthCallback: RequestHandler = async (req, res, next) => {
  try {
    const provider = req.params.provider as string;

    if (provider === "github") {
      const { code, state } = req.validated?.query as { code: string; state: string } ?? req.query;
      const result = await integrationService.handleGitHubCallback(code as string, state as string);
      // Redirect to frontend integrations page with success
      res.redirect(`${env.FRONTEND_URL}/integrations?provider=github&status=connected`);
      return;
    }

    if (provider === "slack") {
      const { code, state } = req.validated?.query as { code: string; state: string } ?? req.query;
      await slackService.handleSlackCallback(code as string, state as string);
      res.redirect(`${env.FRONTEND_URL}/integrations?provider=slack&status=connected`);
      return;
    }

    throw new AppError(400, ERROR_CODES.INTEGRATION_PROVIDER_INVALID, `${provider} callback not supported`);
  } catch (error) {
    // On OAuth failure, redirect to frontend with error
    const provider = req.params.provider;
    if (provider === "github" || provider === "slack") {
      const message = error instanceof AppError ? error.message : "Connection failed";
      res.redirect(`${env.FRONTEND_URL}/integrations?provider=${provider}&status=error&message=${encodeURIComponent(message)}`);
      return;
    }
    next(error);
  }
};

/** DELETE /integrations/:provider/disconnect — Disconnect integration */
export const disconnect: RequestHandler = async (req, res, next) => {
  try {
    await integrationService.disconnectProvider(
      req.workspace!.id,
      req.params.provider as string,
      req.user!.id,
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

/** PATCH /integrations/:provider/settings — Update provider settings */
export const updateSettings: RequestHandler = async (req, res, next) => {
  try {
    const settings = await integrationService.updateSettings(
      req.workspace!.id,
      req.params.provider as string,
      req.body,
    );
    sendSuccess(res, 200, settings);
  } catch (error) {
    next(error);
  }
};

/** GET /integrations/:provider/settings — Get provider settings (safe, no tokens) */
export const getSettings: RequestHandler = async (req, res, next) => {
  try {
    const provider = req.params.provider as string;
    const dbProvider = provider.toUpperCase();

    const integration = await (await import("../../shared/utils/prisma.js")).prisma.integration.findUnique({
      where: {
        workspaceId_provider: {
          workspaceId: req.workspace!.id,
          provider: dbProvider as any,
        },
      },
      select: { connected: true, config: true },
    });

    if (!integration?.connected || !integration.config) {
      throw new AppError(404, ERROR_CODES.INTEGRATION_NOT_CONNECTED, `${provider} is not connected`);
    }

    const config = integration.config as Record<string, unknown>;
    // Strip sensitive fields
    const { accessToken, ...safeConfig } = config;

    sendSuccess(res, 200, {
      settings: safeConfig.settings ?? null,
      channelRouting: safeConfig.channelRouting ?? null,
      defaultChannelId: safeConfig.defaultChannel ?? null,
      defaultChannelName: safeConfig.defaultChannelName ?? null,
      ...(dbProvider === "GITHUB" ? { githubUser: safeConfig.githubUser, repos: safeConfig.repos } : {}),
      ...(dbProvider === "SLACK" ? { team: safeConfig.team } : {}),
    });
  } catch (error) {
    next(error);
  }
};

// ─── Slack Channel Management ────────────────────────────────────────────────

/** GET /integrations/slack/channels — List available Slack channels */
export const listSlackChannels: RequestHandler = async (req, res, next) => {
  try {
    const channels = await slackService.listSlackChannels(req.workspace!.id);
    sendSuccess(res, 200, channels);
  } catch (error) {
    next(error);
  }
};

/** POST /integrations/slack/channel — Set default notification channel */
export const setSlackChannel: RequestHandler = async (req, res, next) => {
  try {
    const { channelId, channelName } = req.body;
    if (!channelId || !channelName) {
      throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "channelId and channelName are required");
    }
    const result = await slackService.setDefaultChannel(req.workspace!.id, channelId, channelName);
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

// ─── GitHub Webhook Handler ──────────────────────────────────────────────────

/**
 * POST /webhooks/github
 *
 * Receives GitHub webhook events. NOT authenticated via Clerk or API key —
 * verified by HMAC SHA-256 signature using the webhook secret.
 *
 * The webhook handler needs to resolve which workspace this event belongs to.
 * Strategy: check the payload's installation/org/repo against connected integrations.
 */
export const githubWebhook: RequestHandler = async (req, res, next) => {
  try {
    // Verify webhook signature
    if (!env.GITHUB_WEBHOOK_SECRET) {
      throw new AppError(500, ERROR_CODES.GITHUB_NOT_CONFIGURED, "GitHub webhook secret not configured");
    }

    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    const rawBody = JSON.stringify(req.body);

    if (!verifyGitHubSignature(rawBody, signature, env.GITHUB_WEBHOOK_SECRET)) {
      throw new AppError(401, ERROR_CODES.GITHUB_WEBHOOK_SIGNATURE_INVALID, "Invalid webhook signature");
    }

    const event = req.headers["x-github-event"] as string;

    // Find which workspace(s) have GitHub connected
    // For now, check all connected GitHub integrations and match by repo
    const connectedWorkspaces = await findWorkspacesForGitHubEvent(req.body);

    // Process event for each matching workspace
    for (const workspaceId of connectedWorkspaces) {
      try {
        switch (event) {
          case "push":
            await integrationService.handleGitHubPush(workspaceId, req.body);
            break;
          case "pull_request":
            await integrationService.handleGitHubPullRequest(workspaceId, req.body);
            break;
          case "pull_request_review":
            await integrationService.handleGitHubPullRequestReview(workspaceId, req.body);
            break;
          // Ignore other events silently
        }
      } catch (err) {
        // Log but don't fail — one workspace's error shouldn't affect others
        console.error(`[GitHub Webhook] Error processing event for workspace ${workspaceId}:`, err);
      }
    }

    // Always respond 200 to GitHub (even if processing failed — GitHub will retry on 4xx/5xx)
    res.status(200).json({ received: true });
  } catch (error) {
    next(error);
  }
};

// ─── Slack Webhook Handler ────────────────────────────────────────────────────

/**
 * POST /webhooks/slack/commands
 *
 * Receives Slack slash command requests. Verified via signing secret.
 * Slack requires a response within 3 seconds — keep processing fast.
 */
export const slackCommands: RequestHandler = async (req, res, next) => {
  try {
    if (!env.SLACK_SIGNING_SECRET) {
      throw new AppError(500, ERROR_CODES.SLACK_NOT_CONFIGURED, "Slack signing secret not configured");
    }

    // Verify Slack request signature using raw body (before URL-decode parsing)
    const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
    const signature = req.headers["x-slack-signature"] as string | undefined;
    const rawBody = (req as any).rawBody as string | undefined;

    if (!rawBody || !verifySlackSignature(rawBody, timestamp, signature, env.SLACK_SIGNING_SECRET)) {
      throw new AppError(401, ERROR_CODES.SLACK_SIGNATURE_INVALID, "Invalid Slack signature");
    }

    const response = await slackService.handleSlashCommand(req.body);
    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};

/**
 * Find workspaces that have GitHub integration connected.
 * For a more targeted approach, you could match by repo/org — for now,
 * we process the event for all connected workspaces and let the service
 * layer handle issue reference matching (if no LIN-XXX refs, it's a no-op).
 */
async function findWorkspacesForGitHubEvent(_payload: any): Promise<string[]> {
  const integrations = await (await import("../../shared/utils/prisma.js")).prisma.integration.findMany({
    where: { provider: "GITHUB", connected: true },
    select: { workspaceId: true },
  });

  return integrations.map((i) => i.workspaceId);
}
