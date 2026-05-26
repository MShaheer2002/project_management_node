import type { RequestHandler } from "express";

import { sendList, sendSuccess } from "../../shared/utils/api-response.js";
import * as projectService from "./project.service.js";
import * as projectMembershipService from "./project-membership.service.js";
import type {
  AddProjectMembersInput,
  ListProjectMembersQuery,
  ListProjectsQuery,
} from "./project.schemas.js";

export const create: RequestHandler = async (req, res, next) => {
  try {
    const created = await projectService.createProject(req.workspace!.id, req.user!.id, req.body);
    sendSuccess(res, 201, created);
  } catch (error) {
    next(error);
  }
};

export const list: RequestHandler = async (req, res, next) => {
  try {
    const result = await projectService.listProjects(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      (req.validated?.query ?? req.query) as ListProjectsQuery,
    );
    sendList(res, result.items as any[], result.meta);
  } catch (error) {
    next(error);
  }
};

export const getById: RequestHandler = async (req, res, next) => {
  try {
    const project = await projectService.getProjectById(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      req.params.id as string,
    );
    sendSuccess(res, 200, project);
  } catch (error) {
    next(error);
  }
};

export const update: RequestHandler = async (req, res, next) => {
  try {
    const updated = await projectService.updateProject(
      req.workspace!.id,
      req.params.id as string,
      req.user!.id,
      req.body,
    );
    sendSuccess(res, 200, updated);
  } catch (error) {
    next(error);
  }
};

export const remove: RequestHandler = async (req, res, next) => {
  try {
    await projectService.deleteProject(req.workspace!.id, req.params.id as string);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const listMembers: RequestHandler = async (req, res, next) => {
  try {
    const result = await projectMembershipService.listProjectMembers(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      req.params.id as string,
      (req.validated?.query ?? req.query) as ListProjectMembersQuery,
    );
    sendList(res, result.items as any[], result.meta);
  } catch (error) {
    next(error);
  }
};


export const addMembers: RequestHandler = async (req, res, next) => {
  try {
    const result = await projectMembershipService.addProjectMembers(
      req.workspace!.id,
      req.params.id as string,
      req.user!.id,
      req.body as AddProjectMembersInput,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const removeMember: RequestHandler = async (req, res, next) => {
  try {
    await projectMembershipService.removeProjectMember(
      req.workspace!.id,
      req.params.id as string,
      req.user!.id,
      req.params.uid as string,
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
