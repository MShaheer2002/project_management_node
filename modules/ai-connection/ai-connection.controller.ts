import type { RequestHandler } from "express";
import { sendSuccess } from "../../shared/utils/api-response.js";
import * as aiConnectionService from "./ai-connection.service.js";

export const catalog: RequestHandler = async (_req, res, next) => {
  try {
    const catalog = await aiConnectionService.getAiConnectionCatalog();
    sendSuccess(res, 200, catalog);
  } catch (error) {
    next(error);
  }
};

export const list: RequestHandler = async (req, res, next) => {
  try {
    const connections = await aiConnectionService.listAiConnections(req.workspace!.id);
    sendSuccess(res, 200, connections);
  } catch (error) {
    next(error);
  }
};

export const getHealth: RequestHandler = async (req, res, next) => {
  try {
    const health = await aiConnectionService.getAiConnectionHealth(
      req.workspace!.id,
      req.params.id as string,
    );
    sendSuccess(res, 200, health);
  } catch (error) {
    next(error);
  }
};

export const listSessions: RequestHandler = async (req, res, next) => {
  try {
    const sessions = await aiConnectionService.listAiConnectionSessions(
      req.workspace!.id,
      req.params.id as string,
      req.validated?.query && typeof req.validated.query === "object" && "limit" in req.validated.query
        ? (req.validated.query.limit as number | undefined)
        : undefined,
    );
    sendSuccess(res, 200, sessions);
  } catch (error) {
    next(error);
  }
};

export const create: RequestHandler = async (req, res, next) => {
  try {
    const result = await aiConnectionService.createAiConnection(
      req.workspace!.id,
      req.user!.id,
      req.body,
    );
    sendSuccess(res, 201, result);
  } catch (error) {
    next(error);
  }
};

export const completeOAuthSetup: RequestHandler = async (req, res, next) => {
  try {
    const result = await aiConnectionService.completeOAuthSetup(
      req.workspace!.id,
      req.user!.id,
      req.body,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const updateScopes: RequestHandler = async (req, res, next) => {
  try {
    const result = await aiConnectionService.updateAiConnectionScopes(
      req.workspace!.id,
      req.params.id as string,
      req.body.scopes,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const rotate: RequestHandler = async (req, res, next) => {
  try {
    const result = await aiConnectionService.rotateAiConnection(
      req.workspace!.id,
      req.params.id as string,
      req.user!.id,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const revoke: RequestHandler = async (req, res, next) => {
  try {
    await aiConnectionService.revokeAiConnection(
      req.workspace!.id,
      req.params.id as string,
      req.user!.id,
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
