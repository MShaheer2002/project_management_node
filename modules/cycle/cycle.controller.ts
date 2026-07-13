import type { RequestHandler } from "express";

import { sendList, sendSuccess } from "../../shared/utils/api-response.js";
import * as cycleService from "./cycle.service.js";
import type {
  AssignIssueCycleInput,
  CarryOverInput,
  CreateCycleInput,
  ListCycleIssuesQuery,
  ListCyclesQuery,
  PlanCycleIssuesInput,
  UpdateCycleInput,
} from "./cycle.schemas.js";

export const create: RequestHandler = async (req, res, next) => {
  try {
    const created = await cycleService.createCycle(
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
      req.body as CreateCycleInput,
    );
    sendSuccess(res, 201, created);
  } catch (error) {
    next(error);
  }
};

export const list: RequestHandler = async (req, res, next) => {
  try {
    const result = await cycleService.listCycles(req.workspace!.id, (req.validated?.query ?? req.query) as ListCyclesQuery);
    sendList(res, result.items as any[], result.meta);
  } catch (error) {
    next(error);
  }
};

export const current: RequestHandler = async (req, res, next) => {
  try {
    const cycle = await cycleService.getCurrentCycle(req.workspace!.id, (req.query.teamId as string | undefined));
    sendSuccess(res, 200, cycle);
  } catch (error) {
    next(error);
  }
};

export const getById: RequestHandler = async (req, res, next) => {
  try {
    const cycle = await cycleService.getCycleById(req.workspace!.id, req.params.id as string, req.user!.id, req.workspace!.role);
    sendSuccess(res, 200, cycle);
  } catch (error) {
    next(error);
  }
};

export const update: RequestHandler = async (req, res, next) => {
  try {
    const updated = await cycleService.updateCycle(req.workspace!.id, req.params.id as string, req.user!.id, req.workspace!.role, req.body as UpdateCycleInput);
    sendSuccess(res, 200, updated);
  } catch (error) {
    next(error);
  }
};

export const remove: RequestHandler = async (req, res, next) => {
  try {
    await cycleService.deleteCycle(req.workspace!.id, req.params.id as string, req.user!.id, req.workspace!.role);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const complete: RequestHandler = async (req, res, next) => {
  try {
    const completed = await cycleService.completeCycle(req.workspace!.id, req.params.id as string, req.user!.id, req.workspace!.role);
    sendSuccess(res, 200, completed);
  } catch (error) {
    next(error);
  }
};

export const reopen: RequestHandler = async (req, res, next) => {
  try {
    const reopened = await cycleService.reopenCycle(req.workspace!.id, req.params.id as string, req.user!.id, req.workspace!.role);
    sendSuccess(res, 200, reopened);
  } catch (error) {
    next(error);
  }
};

export const carryOver: RequestHandler = async (req, res, next) => {
  try {
    const result = await cycleService.carryOverCycle(req.workspace!.id, req.params.id as string, req.user!.id, req.workspace!.role, req.body as CarryOverInput);
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const listIssues: RequestHandler = async (req, res, next) => {
  try {
    const result = await cycleService.listCycleIssues(
      req.workspace!.id,
      req.params.id as string,
      req.user!.id,
      req.workspace!.role,
      (req.validated?.query ?? req.query) as ListCycleIssuesQuery,
    );
    sendList(res, result.items as any[], result.meta);
  } catch (error) {
    next(error);
  }
};

export const planIssues: RequestHandler = async (req, res, next) => {
  try {
    const result = await cycleService.planIssuesIntoCycle(
      req.workspace!.id,
      req.params.id as string,
      req.user!.id,
      req.workspace!.role,
      req.body as PlanCycleIssuesInput,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const removePlannedIssue: RequestHandler = async (req, res, next) => {
  try {
    const result = await cycleService.removeIssueFromSpecificCycle(
      req.workspace!.id,
      req.params.id as string,
      req.params.issueId as string,
      req.user!.id,
      req.workspace!.role,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const assignIssue: RequestHandler = async (req, res, next) => {
  try {
    const issue = await cycleService.assignIssueToCycle(
      req.workspace!.id,
      req.params.id as string,
      req.user!.id,
      req.workspace!.role,
      req.body as AssignIssueCycleInput,
    );
    sendSuccess(res, 200, issue);
  } catch (error) {
    next(error);
  }
};

export const removeIssue: RequestHandler = async (req, res, next) => {
  try {
    await cycleService.removeIssueFromCycle(req.workspace!.id, req.params.id as string, req.user!.id, req.workspace!.role);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
