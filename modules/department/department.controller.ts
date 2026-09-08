import type { RequestHandler } from "express";

import { sendList, sendSuccess } from "../../shared/utils/api-response.js";
import * as departmentService from "./department.service.js";
import * as departmentMembershipService from "./department-membership.service.js";
import type {
  AddDepartmentMembersInput,
  ListDepartmentMembersQuery,
  ListDepartmentsQuery,
} from "./department.schemas.js";

export const create: RequestHandler = async (req, res, next) => {
  try {
    const department = await departmentService.createDepartment(req.workspace!.id, req.body);
    sendSuccess(res, 201, department);
  } catch (error) {
    next(error);
  }
};

export const list: RequestHandler = async (req, res, next) => {
  try {
    const result = await departmentService.listDepartments(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      (req.validated?.query ?? req.query) as ListDepartmentsQuery,
    );
    sendList(res, result.items, result.meta);
  } catch (error) {
    next(error);
  }
};

export const getById: RequestHandler = async (req, res, next) => {
  try {
    const department = await departmentService.getDepartmentById(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      req.params.id as string,
    );
    sendSuccess(res, 200, department);
  } catch (error) {
    next(error);
  }
};

export const update: RequestHandler = async (req, res, next) => {
  try {
    const department = await departmentService.updateDepartment(
      req.workspace!.id,
      req.params.id as string,
      req.body,
    );
    sendSuccess(res, 200, department);
  } catch (error) {
    next(error);
  }
};

export const remove: RequestHandler = async (req, res, next) => {
  try {
    await departmentService.deleteDepartment(req.workspace!.id, req.params.id as string);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const listMembers: RequestHandler = async (req, res, next) => {
  try {
    const result = await departmentMembershipService.listDepartmentMembers(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      req.params.id as string,
      (req.validated?.query ?? req.query) as ListDepartmentMembersQuery,
    );
    sendList(res, result.items, result.meta);
  } catch (error) {
    next(error);
  }
};

export const addMembers: RequestHandler = async (req, res, next) => {
  try {
    const result = await departmentMembershipService.addDepartmentMembers(
      req.workspace!.id,
      req.params.id as string,
      req.body as AddDepartmentMembersInput,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const removeMember: RequestHandler = async (req, res, next) => {
  try {
    await departmentMembershipService.removeDepartmentMember(
      req.workspace!.id,
      req.params.id as string,
      req.params.uid as string,
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
