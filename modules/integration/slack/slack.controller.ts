/**
 * Slack Integration — Controller
 *
 * HTTP request handlers for Slack integration endpoints.
 * Controllers are DUMB — parse request, call service, send response.
 */

import type { RequestHandler } from "express";
import { sendSuccess } from "../../../shared/utils/api-response.js";
import { AppError } from "../../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../../shared/errors/error-codes.js";
import { env } from "../../../config/env.js";
import { findConnectedIntegration, getSettings, upsertSettings } from "../integration.service.js";
import * as slackService from "./slack.service.js";
import { handleSlashCommand } from "./slack.commands.js";
import { verifySlackSignature } from "./slack.utils.js";

/** POST /integrations/slack/connect — Start Slack OAuth flow */
export const connect: RequestHandler = async (req, res, next) => {
  try {
    const authUrl = slackService.getSlackAuthUrl(req.workspace!.id, req.user!.id);
    sendSuccess(res, 200, { authUrl });
  } catch (error) {
    next(error);
  }
};

/** GET /integrations/slack/callback — Slack OAuth callback */
export const callback: RequestHandler = async (req, res, next) => {
  try {
    const { code, state } = (req.validated?.query as { code: string; state: string }) ?? req.query;
    await slackService.handleSlackCallback(code as string, state as string);
    res.redirect(`${env.FRONTEND_URL}/integrations?provider=slack&status=connected`);
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Connection failed";
    res.redirect(`${env.FRONTEND_URL}/integrations?provider=slack&status=error&message=${encodeURIComponent(message)}`);
  }
};

/** GET /integrations/slack/settings — Get settings + channels */
export const getSlackSettings: RequestHandler = async (req, res, next) => {
  try {
    const integration = await findConnectedIntegration(req.workspace!.id, "SLACK");
    if (!integration) {
      throw new AppError(404, ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Slack is not connected");
    }
    const settings = await getSettings(integration.id);
    const channels = await slackService.getChannels(integration.id);
    const meta = integration.providerMeta as Record<string, any> | null;

    sendSuccess(res, 200, {
      settings,
      channels,
      team: meta?.team ?? null,
    });
  } catch (error) {
    next(error);
  }
};

/** PATCH /integrations/slack/settings — Update settings */
export const updateSlackSettings: RequestHandler = async (req, res, next) => {
  try {
    const integration = await findConnectedIntegration(req.workspace!.id, "SLACK");
    if (!integration) {
      throw new AppError(404, ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Slack is not connected");
    }
    const updated = await upsertSettings(integration.id, req.body);
    sendSuccess(res, 200, updated);
  } catch (error) {
    next(error);
  }
};

/** GET /integrations/slack/channels — List Slack API channels (for picker) */
export const listChannels: RequestHandler = async (req, res, next) => {
  try {
    const channels = await slackService.listSlackChannels(req.workspace!.id);
    sendSuccess(res, 200, channels);
  } catch (error) {
    next(error);
  }
};

/** POST /integrations/slack/channels — Add channel mapping */
export const addChannel: RequestHandler = async (req, res, next) => {
  try {
    const channel = await slackService.addChannel(req.workspace!.id, req.body);
    sendSuccess(res, 201, channel);
  } catch (error) {
    next(error);
  }
};

/** DELETE /integrations/slack/channels/:channelDbId — Remove channel mapping */
export const removeChannel: RequestHandler = async (req, res, next) => {
  try {
    const channelDbId = req.params.channelDbId as string;
    await slackService.removeChannel(req.workspace!.id, channelDbId);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

/** POST /webhooks/slack/commands — Slack slash command webhook */
export const slackCommandsWebhook: RequestHandler = async (req, res, next) => {
  try {
    if (!env.SLACK_SIGNING_SECRET) {
      throw new AppError(500, ERROR_CODES.SLACK_NOT_CONFIGURED, "Slack signing secret not configured");
    }

    const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
    const signature = req.headers["x-slack-signature"] as string | undefined;
    const rawBody = (req as any).rawBody as string | undefined;

    if (!rawBody || !verifySlackSignature(rawBody, timestamp, signature, env.SLACK_SIGNING_SECRET)) {
      throw new AppError(401, ERROR_CODES.SLACK_SIGNATURE_INVALID, "Invalid Slack signature");
    }

    const response = await handleSlashCommand(req.body);
    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
