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
