/**
 * Figma Integration — Controller
 *
 * Thin HTTP handlers — parse request, call service, send response.
 */

import type { RequestHandler } from "express";
import * as figmaService from "./figma.service.js";
import {
  findConnectedIntegration,
  getSettings,
  upsertSettings,
} from "../integration.service.js";
import { sendSuccess } from "../../../shared/utils/api-response.js";
import { AppError } from "../../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../../shared/errors/error-codes.js";
import { resolveIssueRouteId } from "../../issue/issue.service.js";

/** POST /integrations/figma/connect — Connect with personal access token */
export const connect: RequestHandler = async (req, res, next) => {
  try {
    const result = await figmaService.connectFigma(
      req.workspace!.id,
      req.user!.id,
      req.body.accessToken,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

/** GET /integrations/figma/settings — Get Figma settings */
export const getFigmaSettings: RequestHandler = async (req, res, next) => {
  try {
    const integration = await findConnectedIntegration(req.workspace!.id, "FIGMA");
    if (!integration) {
      throw new AppError(404, ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Figma is not connected");
    }

    const settings = await getSettings(integration.id);
    const meta = integration.providerMeta as { figmaUser?: { handle: string; email: string } } | null;

    sendSuccess(res, 200, {
      settings,
      figmaUser: meta?.figmaUser ?? null,
    });
  } catch (error) {
    next(error);
  }
};

/** PATCH /integrations/figma/settings — Update Figma settings */
export const updateFigmaSettings: RequestHandler = async (req, res, next) => {
  try {
    const integration = await findConnectedIntegration(req.workspace!.id, "FIGMA");
    if (!integration) {
      throw new AppError(404, ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Figma is not connected");
    }

    await upsertSettings(integration.id, req.body);
    const updated = await getSettings(integration.id);
    sendSuccess(res, 200, { settings: updated });
  } catch (error) {
    next(error);
  }
};

/** POST /integrations/figma/batch-preview — { issueId, urls }: previews for Figma links on an issue the caller can see */
export const batchPreview: RequestHandler = async (req, res, next) => {
  try {
    const { urls, issueId } = req.body as { urls: string[]; issueId?: string };
    if (typeof issueId !== "string" || !issueId) {
      throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "issueId is required");
    }
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "urls must be a non-empty array");
    }
    if (urls.length > 20) {
      throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "Maximum 20 URLs per batch request");
    }
    const results = await figmaService.batchPreviewFigmaFiles(
      req.workspace!.id,
      { userId: req.user!.id, role: req.workspace!.role },
      await resolveIssueRouteId(req.workspace!.id, issueId),
      urls,
    );
    sendSuccess(res, 200, results);
  } catch (error) {
    next(error);
  }
};
