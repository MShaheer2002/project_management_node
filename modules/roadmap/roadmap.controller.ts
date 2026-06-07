import type { RequestHandler } from "express";

import { sendSuccess } from "../../shared/utils/api-response.js";
import type {
  CancelDependencyInput,
  CreateDependencyInput,
  CreateMilestoneInput,
  ListRoadmapQuery,
  ReorderMilestonesInput,
  ResolveDependencyInput,
  UpdateMilestoneInput,
  UpdateRoadmapScheduleInput,
} from "./roadmap.schemas.js";
import * as roadmapService from "./roadmap.service.js";

export const list: RequestHandler = async (req, res, next) => {
  try {
    const result = await roadmapService.listRoadmap(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      (req.validated?.query ?? req.query) as ListRoadmapQuery,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const getProjectDetail: RequestHandler = async (req, res, next) => {
  try {
    const result = await roadmapService.getProjectRoadmapDetail(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      req.params.projectId as string,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const updateSchedule: RequestHandler = async (req, res, next) => {
  try {
    const result = await roadmapService.updateProjectSchedule(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      req.params.projectId as string,
      req.body as UpdateRoadmapScheduleInput,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const createMilestone: RequestHandler = async (req, res, next) => {
  try {
    const result = await roadmapService.createMilestone(
      req.workspace!.id,
      req.user!.id,
      req.params.projectId as string,
      req.body as CreateMilestoneInput,
    );
    sendSuccess(res, 201, result);
  } catch (error) {
    next(error);
  }
};

export const updateMilestone: RequestHandler = async (req, res, next) => {
  try {
    const result = await roadmapService.updateMilestone(
      req.workspace!.id,
      req.user!.id,
      req.params.projectId as string,
      req.params.milestoneId as string,
      req.body as UpdateMilestoneInput,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const reorderMilestones: RequestHandler = async (req, res, next) => {
  try {
    const result = await roadmapService.reorderMilestones(
      req.workspace!.id,
      req.user!.id,
      req.params.projectId as string,
      req.body as ReorderMilestonesInput,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const deleteMilestone: RequestHandler = async (req, res, next) => {
  try {
    await roadmapService.deleteMilestone(
      req.workspace!.id,
      req.user!.id,
      req.params.projectId as string,
      req.params.milestoneId as string,
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const createDependency: RequestHandler = async (req, res, next) => {
  try {
    const result = await roadmapService.createDependency(
      req.workspace!.id,
      req.user!.id,
      req.body as CreateDependencyInput,
    );
    sendSuccess(res, 201, result);
  } catch (error) {
    next(error);
  }
};

export const resolveDependency: RequestHandler = async (req, res, next) => {
  try {
    const result = await roadmapService.resolveDependency(
      req.workspace!.id,
      req.user!.id,
      req.params.dependencyId as string,
      req.body as ResolveDependencyInput,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const cancelDependency: RequestHandler = async (req, res, next) => {
  try {
    const result = await roadmapService.cancelDependency(
      req.workspace!.id,
      req.user!.id,
      req.params.dependencyId as string,
      req.body as CancelDependencyInput,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const deleteDependency: RequestHandler = async (req, res, next) => {
  try {
    await roadmapService.deleteDependency(
      req.workspace!.id,
      req.user!.id,
      req.params.dependencyId as string,
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
