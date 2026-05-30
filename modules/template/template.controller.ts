import type { RequestHandler } from "express";

import { sendList, sendSuccess } from "../../shared/utils/api-response.js";
import * as templateService from "./template.service.js";
import type {
  CreateTemplateInput,
  ListActiveTemplatesQuery,
  ListTemplatesQuery,
  UpdateTemplateInput,
} from "./template.schemas.js";

export const getDefaults: RequestHandler = async (_req, res, next) => {
  try {
    const data = await templateService.getTemplateDefaults();
    sendSuccess(res, 200, data);
  } catch (error) {
    next(error);
  }
};

export const listActive: RequestHandler = async (req, res, next) => {
  try {
    const result = await templateService.listActiveTemplates(req.workspace!.id, req.user!.id, (req.validated?.query ?? req.query) as ListActiveTemplatesQuery);
    sendSuccess(res, 200, result.items);
  } catch (error) {
    next(error);
  }
};

export const list: RequestHandler = async (req, res, next) => {
  try {
    const result = await templateService.listTemplates(req.workspace!.id, req.user!.id, (req.validated?.query ?? req.query) as ListTemplatesQuery);
    sendList(res, result.items as any[], result.meta);
  } catch (error) {
    next(error);
  }
};

export const getById: RequestHandler = async (req, res, next) => {
  try {
    const template = await templateService.getTemplateById(req.workspace!.id, req.params.id as string, req.user!.id);
    sendSuccess(res, 200, template);
  } catch (error) {
    next(error);
  }
};

export const create: RequestHandler = async (req, res, next) => {
  try {
    const created = await templateService.createTemplate(req.workspace!.id, req.user!.id, req.body as CreateTemplateInput);
    sendSuccess(res, 201, created);
  } catch (error) {
    next(error);
  }
};

export const update: RequestHandler = async (req, res, next) => {
  try {
    const updated = await templateService.updateTemplate(req.workspace!.id, req.params.id as string, req.user!.id, req.body as UpdateTemplateInput);
    sendSuccess(res, 200, updated);
  } catch (error) {
    next(error);
  }
};

export const remove: RequestHandler = async (req, res, next) => {
  try {
    await templateService.deleteTemplate(req.workspace!.id, req.params.id as string, req.user!.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const duplicate: RequestHandler = async (req, res, next) => {
  try {
    const data = await templateService.duplicateTemplate(req.workspace!.id, req.params.id as string, req.user!.id, Boolean(req.body?.isActive));
    sendSuccess(res, 201, data);
  } catch (error) {
    next(error);
  }
};

export const apply: RequestHandler = async (req, res, next) => {
  try {
    const draft = await templateService.applyTemplate(req.workspace!.id, req.params.id as string, req.user!.id);
    sendSuccess(res, 200, draft);
  } catch (error) {
    next(error);
  }
};

export const activate: RequestHandler = async (req, res, next) => {
  try {
    const data = await templateService.activateTemplate(req.workspace!.id, req.params.id as string, req.user!.id);
    sendSuccess(res, 200, data);
  } catch (error) {
    next(error);
  }
};

export const activateConfirm: RequestHandler = async (req, res, next) => {
  try {
    const data = await templateService.confirmActivateTemplate(req.workspace!.id, req.params.id as string, req.user!.id);
    sendSuccess(res, 200, data);
  } catch (error) {
    next(error);
  }
};

export const confirmDefault: RequestHandler = async (req, res, next) => {
  try {
    const data = await templateService.confirmDefaultTemplate(req.workspace!.id, req.params.id as string, req.user!.id);
    sendSuccess(res, 200, data);
  } catch (error) {
    next(error);
  }
};

export const deactivate: RequestHandler = async (req, res, next) => {
  try {
    const data = await templateService.deactivateTemplate(req.workspace!.id, req.params.id as string, req.user!.id);
    sendSuccess(res, 200, data);
  } catch (error) {
    next(error);
  }
};
