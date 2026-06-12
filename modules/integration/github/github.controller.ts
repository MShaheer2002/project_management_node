/**
 * GitHub Integration — Controller
 *
 * HTTP handlers for GitHub OAuth, settings, and webhook processing.
 * Controllers are DUMB — parse request, call service, send response.
 */

import type { RequestHandler } from "express";
import * as githubService from "./github.service.js";
import { verifyGitHubSignature } from "./github.utils.js";
import { sendSuccess } from "../../../shared/utils/api-response.js";
import { AppError } from "../../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../../shared/errors/error-codes.js";
import { env } from "../../../config/env.js";
import { prisma } from "../../../shared/utils/prisma.js";
import {
  findConnectedIntegration,
  getSettings,
  upsertSettings,
} from "../integration.service.js";

/** POST /integrations/github/connect — Start GitHub OAuth flow */
export const connect: RequestHandler = async (req, res, next) => {
  try {
    const authUrl = githubService.getGitHubAuthUrl(req.workspace!.id, req.user!.id);
    sendSuccess(res, 200, { authUrl });
  } catch (error) {
    next(error);
  }
};

/** GET /integrations/github/callback — GitHub OAuth callback (no auth middleware) */
export const callback: RequestHandler = async (req, res, next) => {
  try {
    const { code, state } = (req.validated?.query as { code: string; state: string }) ?? req.query;
    await githubService.handleGitHubCallback(code as string, state as string);
    res.redirect(`${env.FRONTEND_URL}/integrations?provider=github&status=connected`);
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Connection failed";
    res.redirect(`${env.FRONTEND_URL}/integrations?provider=github&status=error&message=${encodeURIComponent(message)}`);
  }
};

/** GET /integrations/github/settings — Get GitHub settings (safe, no tokens) */
export const getSettingsHandler: RequestHandler = async (req, res, next) => {
  try {
    const integration = await findConnectedIntegration(req.workspace!.id, "GITHUB");
    if (!integration) {
      throw new AppError(404, ERROR_CODES.INTEGRATION_NOT_CONNECTED, "GitHub is not connected");
    }

    const settings = await getSettings(integration.id);
    const providerMeta = integration.providerMeta as Record<string, unknown> | null;

    sendSuccess(res, 200, {
      settings,
      githubUser: providerMeta?.githubUser ?? null,
      repos: providerMeta?.repos ?? [],
    });
  } catch (error) {
    next(error);
  }
};

/** PATCH /integrations/github/settings — Update GitHub settings */
export const updateSettingsHandler: RequestHandler = async (req, res, next) => {
  try {
    const integration = await findConnectedIntegration(req.workspace!.id, "GITHUB");
    if (!integration) {
      throw new AppError(404, ERROR_CODES.INTEGRATION_NOT_CONNECTED, "GitHub is not connected");
    }

    const updated = await upsertSettings(integration.id, req.body);
    sendSuccess(res, 200, { settings: updated });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /webhooks/github — GitHub webhook receiver
 *
 * NOT authenticated via Clerk or API key — verified by HMAC SHA-256 signature.
 * Resolves which workspace(s) the event belongs to and dispatches processing.
 */
export const githubWebhook: RequestHandler = async (req, res, next) => {
  try {
    if (!env.GITHUB_WEBHOOK_SECRET) {
      throw new AppError(500, ERROR_CODES.GITHUB_NOT_CONFIGURED, "GitHub webhook secret not configured");
    }

    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    const rawBody = JSON.stringify(req.body);

    if (!verifyGitHubSignature(rawBody, signature, env.GITHUB_WEBHOOK_SECRET)) {
      throw new AppError(401, ERROR_CODES.GITHUB_WEBHOOK_SIGNATURE_INVALID, "Invalid webhook signature");
    }

    const event = req.headers["x-github-event"] as string;

    // Find all workspaces with GitHub connected
    const connectedWorkspaces = await prisma.integration.findMany({
      where: { provider: "GITHUB", connected: true },
      select: { workspaceId: true },
    });

    // Process event for each matching workspace
    for (const { workspaceId } of connectedWorkspaces) {
      try {
        switch (event) {
          case "push":
            await githubService.handleGitHubPush(workspaceId, req.body);
            break;
          case "pull_request":
            await githubService.handleGitHubPullRequest(workspaceId, req.body);
            break;
          case "pull_request_review":
            await githubService.handleGitHubPullRequestReview(workspaceId, req.body);
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
