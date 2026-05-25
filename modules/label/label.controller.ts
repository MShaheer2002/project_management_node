import type { RequestHandler } from "express";

import { sendList, sendSuccess } from "../../shared/utils/api-response.js";
import type { AttachIssueLabelsInput, ListLabelsQuery } from "./label.schemas.js";
import * as labelService from "./label.service.js";

export const create: RequestHandler = async (req, res, next) => {
  try {
    const label = await labelService.createLabel(req.workspace!.id, req.user!.id, req.body);
    sendSuccess(res, 201, label);
  } catch (error) {
    next(error);
  }
};

export const list: RequestHandler = async (req, res, next) => {
  try {
    const result = await labelService.listLabels(req.workspace!.id, (req.validated?.query ?? req.query) as ListLabelsQuery);
    sendList(res, result.items, result.meta);
  } catch (error) {
    next(error);
  }
};

export const update: RequestHandler = async (req, res, next) => {
  try {
    const label = await labelService.updateLabel(req.workspace!.id, req.user!.id, req.params.labelId as string, req.body);
    sendSuccess(res, 200, label);
  } catch (error) {
    next(error);
  }
};

export const remove: RequestHandler = async (req, res, next) => {
  try {
    await labelService.deleteLabel(req.workspace!.id, req.user!.id, req.params.labelId as string);
    sendSuccess(res, 200, { id: req.params.labelId as string });
  } catch (error) {
    next(error);
  }
};

export const attachToIssue: RequestHandler = async (req, res, next) => {
  try {
    const result = await labelService.attachIssueLabels(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      req.params.issueId as string,
      req.body as AttachIssueLabelsInput,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const removeFromIssue: RequestHandler = async (req, res, next) => {
  try {
    const result = await labelService.removeIssueLabel(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      req.params.issueId as string,
      req.params.labelId as string,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};
