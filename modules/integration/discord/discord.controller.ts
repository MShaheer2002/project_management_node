/**
 * Discord Integration -- Controller
 *
 * HTTP handlers for Discord webhook management.
 * Controllers are thin: parse request, call service, send response.
 */

import type { RequestHandler } from "express";
import { sendSuccess } from "../../../shared/utils/api-response.js";
import { findConnectedIntegration, getSettings, upsertSettings } from "../integration.service.js";
import * as discordService from "./discord.service.js";
import { AppError } from "../../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../../shared/errors/error-codes.js";

/** POST /integrations/discord/connect */
export const connect: RequestHandler = async (req, res, next) => {
  try {
    const result = await discordService.connectDiscord(
      req.workspace!.id,
      req.user!.id,
      req.body,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

/** GET /integrations/discord/settings */
export const getDiscordSettings: RequestHandler = async (req, res, next) => {
  try {
    const integration = await findConnectedIntegration(req.workspace!.id, "DISCORD");
    if (!integration) {
      throw new AppError(404, ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Discord integration not connected");
    }
    const settings = await getSettings(integration.id);
    const webhooks = await discordService.getWebhooks(integration.id);

    sendSuccess(res, 200, { settings, webhooks });
  } catch (error) {
    next(error);
  }
};

/** PATCH /integrations/discord/settings */
export const updateDiscordSettings: RequestHandler = async (req, res, next) => {
  try {
    const integration = await findConnectedIntegration(req.workspace!.id, "DISCORD");
    if (!integration) {
      throw new AppError(404, ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Discord integration not connected");
    }
    await upsertSettings(integration.id, req.body);
    const settings = await getSettings(integration.id);
    sendSuccess(res, 200, { settings });
  } catch (error) {
    next(error);
  }
};

/** POST /integrations/discord/webhooks */
export const addWebhook: RequestHandler = async (req, res, next) => {
  try {
    const webhook = await discordService.addWebhook(req.workspace!.id, req.body);
    sendSuccess(res, 201, webhook);
  } catch (error) {
    next(error);
  }
};

/** DELETE /integrations/discord/webhooks/:webhookDbId */
export const removeWebhook: RequestHandler = async (req, res, next) => {
  try {
    await discordService.removeWebhook(req.workspace!.id, req.params.webhookDbId as string);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
