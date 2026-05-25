import type { RequestHandler } from "express";

import { sendList, sendSuccess } from "../../shared/utils/api-response.js";
import { resolveIssueRouteId } from "../issue/issue.service.js";
import * as commentService from "./comment.service.js";
import type { ListCommentsQuery } from "./comment.schemas.js";

export const create: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    const comment = await commentService.createComment(req.workspace!.id, issueId, req.user!.id, req.body);
    sendSuccess(res, 201, comment);
  } catch (error) {
    next(error);
  }
};

export const listByIssue: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    const result = await commentService.listComments(
      req.workspace!.id,
      issueId,
      (req.validated?.query ?? req.query) as ListCommentsQuery,
    );
    sendList(res, result.items, result.meta);
  } catch (error) {
    next(error);
  }
};

export const update: RequestHandler = async (req, res, next) => {
  try {
    const updated = await commentService.updateComment(req.workspace!.id, req.params.id as string, req.user!.id, req.body);
    sendSuccess(res, 200, updated);
  } catch (error) {
    next(error);
  }
};

export const remove: RequestHandler = async (req, res, next) => {
  try {
    await commentService.deleteComment(
      req.workspace!.id,
      req.params.id as string,
      req.user!.id,
      req.workspace!.role,
    );
    sendSuccess(res, 200, { id: req.params.id as string });
  } catch (error) {
    next(error);
  }
};

export const addAttachments: RequestHandler = async (req, res, next) => {
  try {
    const comment = await commentService.addCommentAttachments(
      req.workspace!.id,
      req.params.id as string,
      req.user!.id,
      req.body.attachments,
    );
    sendSuccess(res, 200, comment);
  } catch (error) {
    next(error);
  }
};

export const removeAttachment: RequestHandler = async (req, res, next) => {
  try {
    await commentService.removeCommentAttachment(
      req.workspace!.id,
      req.params.id as string,
      req.params.attachmentId as string,
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
