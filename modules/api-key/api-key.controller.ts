/**
 * API Key Module — Controller
 *
 * Handles HTTP request parsing and response sending.
 * Controllers are DUMB — parse request, call service, send response.
 * No business logic here.
 */

import type { RequestHandler } from "express";
import * as apiKeyService from "./api-key.service.js";
import { sendSuccess } from "../../shared/utils/api-response.js";

/** POST /api-keys — Create a new API key (returns raw key ONCE) */
export const create: RequestHandler = async (req, res, next) => {
  try {
    const result = await apiKeyService.createApiKey(
      req.workspace!.id,
      req.user!.id,
      req.body,
    );
    sendSuccess(res, 201, result);
  } catch (error) {
    next(error);
  }
};

/** GET /api-keys — List all API keys in workspace (masked) */
export const list: RequestHandler = async (req, res, next) => {
  try {
    const keys = await apiKeyService.listApiKeys(req.workspace!.id);
    sendSuccess(res, 200, keys);
  } catch (error) {
    next(error);
  }
};

/** GET /api-keys/:id — Get single API key details (masked) */
export const getById: RequestHandler = async (req, res, next) => {
  try {
    const key = await apiKeyService.getApiKeyById(
      req.workspace!.id,
      req.params.id as string,
    );
    sendSuccess(res, 200, key);
  } catch (error) {
    next(error);
  }
};

/** DELETE /api-keys/:id — Revoke (delete) an API key */
export const revoke: RequestHandler = async (req, res, next) => {
  try {
    await apiKeyService.revokeApiKey(
      req.workspace!.id,
      req.params.id as string,
      req.user!.id,
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
