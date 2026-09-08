import type { RequestHandler } from "express";

import { sendList, sendSuccess } from "../../shared/utils/api-response.js";
import * as teamService from "./team.service.js";
import * as teamMembershipService from "./team-membership.service.js";
import type {
  AddTeamMembersInput,
  ListTeamMembersQuery,
  ListTeamsQuery,
} from "./team.schemas.js";

export const create: RequestHandler = async (req, res, next) => {
  try {
    const team = await teamService.createTeam(req.workspace!.id, req.user!.id, req.body);
    sendSuccess(res, 201, team);
  } catch (error) {
    next(error);
  }
};

export const list: RequestHandler = async (req, res, next) => {
  try {
    const result = await teamService.listTeams(
      req.workspace!.id,
      req.workspace!.role,
      (req.validated?.query ?? req.query) as ListTeamsQuery,
    );
    sendList(res, result.items, result.meta);
  } catch (error) {
    next(error);
  }
};

export const getById: RequestHandler = async (req, res, next) => {
  try {
    const team = await teamService.getTeamById(
      req.workspace!.id,
      req.workspace!.role,
      req.params.id as string,
    );
    sendSuccess(res, 200, team);
  } catch (error) {
    next(error);
  }
};

export const update: RequestHandler = async (req, res, next) => {
  try {
    const team = await teamService.updateTeam(
      req.workspace!.id,
      req.workspace!.role,
      req.params.id as string,
      req.body,
    );
    sendSuccess(res, 200, team);
  } catch (error) {
    next(error);
  }
};

export const remove: RequestHandler = async (req, res, next) => {
  try {
    await teamService.deleteTeam(req.workspace!.id, req.params.id as string);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const listMembers: RequestHandler = async (req, res, next) => {
  try {
    const result = await teamMembershipService.listTeamMembers(
      req.workspace!.id,
      req.workspace!.role,
      req.params.id as string,
      (req.validated?.query ?? req.query) as ListTeamMembersQuery,
    );
    sendList(res, result.items, result.meta);
  } catch (error) {
    next(error);
  }
};

export const addMembers: RequestHandler = async (req, res, next) => {
  try {
    const result = await teamMembershipService.addTeamMembers(
      req.workspace!.id,
      req.params.id as string,
      req.user!.id,
      req.body as AddTeamMembersInput,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const removeMember: RequestHandler = async (req, res, next) => {
  try {
    await teamMembershipService.removeTeamMember(
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
