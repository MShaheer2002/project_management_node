import type { RequestHandler } from "express";

import { sendList, sendSuccess } from "../../shared/utils/api-response.js";
import * as issueService from "./issue.service.js";
import * as subtaskService from "./subtask.service.js";
import type { ListIssuesQuery } from "./issue.schemas.js";

export const create: RequestHandler = async (req, res, next) => {
  try {
    const issue = await issueService.createIssue(req.workspace!.id, req.user!.id, req.body);
    sendSuccess(res, 201, issue);
  } catch (error) {
    next(error);
  }
};

export const list: RequestHandler = async (req, res, next) => {
  try {
    const result = await issueService.listIssues(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      (req.validated?.query ?? req.query) as ListIssuesQuery,
    );
    sendList(res, result.items as any[], result.meta);
  } catch (error) {
    next(error);
  }
};

export const checkAssignmentEligibility: RequestHandler = async (req, res, next) => {
  try {
    const result = await issueService.checkAssignmentEligibility(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      req.body,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const getById: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    const issue = await issueService.getIssueById(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      issueId,
    );
    sendSuccess(res, 200, issue);
  } catch (error) {
    next(error);
  }
};

export const update: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    const issue = await issueService.updateIssue(req.workspace!.id, issueId, req.user!.id, req.body);
    sendSuccess(res, 200, issue);
  } catch (error) {
    next(error);
  }
};

export const remove: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    await issueService.deleteIssue(req.workspace!.id, issueId);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const updateStatus: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    const issue = await issueService.updateIssueStatus(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      issueId,
      req.body.status,
    );
    sendSuccess(res, 200, issue);
  } catch (error) {
    next(error);
  }
};

export const createSubtask: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    const subtask = await subtaskService.createSubtask(req.workspace!.id, issueId, req.body);
    sendSuccess(res, 201, subtask);
  } catch (error) {
    next(error);
  }
};

export const updateSubtask: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    const subtask = await subtaskService.updateSubtask(
      req.workspace!.id,
      issueId,
      req.params.sid as string,
      req.body,
    );
    sendSuccess(res, 200, subtask);
  } catch (error) {
    next(error);
  }
};

export const deleteSubtask: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    await subtaskService.deleteSubtask(req.workspace!.id, issueId, req.params.sid as string);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const reorderSubtasks: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    const subtasks = await subtaskService.reorderSubtasks(req.workspace!.id, issueId, req.body.items);
    sendSuccess(res, 200, subtasks);
  } catch (error) {
    next(error);
  }
};

export const addAttachments: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    const issue = await issueService.addAttachments(
      req.workspace!.id,
      issueId,
      req.user!.id,
      req.body.attachments,
    );
    sendSuccess(res, 200, issue);
  } catch (error) {
    next(error);
  }
};

export const removeAttachment: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    await issueService.removeAttachment(req.workspace!.id, issueId, req.params.attachmentId as string);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const addDependency: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    const relatedIssueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.body.issueId);
    const dependency = await issueService.addDependency(
      req.workspace!.id,
      issueId,
      relatedIssueId,
      req.body.relation,
    );
    sendSuccess(res, 201, dependency);
  } catch (error) {
    next(error);
  }
};

export const removeDependency: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    const relatedIssueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.relatedId as string);
    await issueService.removeDependency(req.workspace!.id, issueId, relatedIssueId);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const listWatchers: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    const watchers = await issueService.listWatchers(req.workspace!.id, issueId);
    sendSuccess(res, 200, watchers);
  } catch (error) {
    next(error);
  }
};

export const addWatchers: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    const added = await issueService.addWatchers(req.workspace!.id, issueId, req.body.userIds);
    sendSuccess(res, 200, added);
  } catch (error) {
    next(error);
  }
};

export const removeWatcher: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    await issueService.removeWatcher(req.workspace!.id, issueId, req.params.userId as string);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const updateIntegrationRef: RequestHandler = async (req, res, next) => {
  try {
    const issueId = await issueService.resolveIssueRouteId(req.workspace!.id, req.params.id as string);
    const integrationRefs = await issueService.updateIntegrationRefs(req.workspace!.id, issueId, req.body.integrationRefs);
    sendSuccess(res, 200, integrationRefs);
  } catch (error) {
    next(error);
  }
};
