/**
 * AI Module — Controller
 *
 * HTTP handlers for AI endpoints.
 * Controllers are DUMB — parse request, call service, send response.
 */

import type { RequestHandler } from "express";
import * as aiService from "./ai.service.js";
import { sendSuccess } from "../../shared/utils/api-response.js";
import { listAvailableModels } from "./ai.provider.js";
import type { GenerateIssueInput } from "./ai.schemas.js";

/**
 * POST /ai/generate-issue — Generate a structured issue from natural language
 *
 * Accepts a prompt, runs rule-based detection + AI generation,
 * returns pre-filled issue data for the frontend form.
 *
 * AI never writes to DB. The user reviews and submits via the normal issue creation flow.
 */
export const generateIssue: RequestHandler = async (req, res, next) => {
  try {
    const { prompt, resolvedAssigneeId, resolvedProjectId } = req.body as GenerateIssueInput;
    const workspaceId = req.workspace!.id;

    const result = await aiService.generateIssue(prompt, workspaceId, {
      resolvedAssigneeId,
      resolvedProjectId,
    });

    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /ai/models — List available AI models
 *
 * Returns the list of models admins can choose from in workspace settings.
 */
export const getModels: RequestHandler = async (_req, res, next) => {
  try {
    const models = listAvailableModels();
    sendSuccess(res, 200, models);
  } catch (error) {
    next(error);
  }
};
