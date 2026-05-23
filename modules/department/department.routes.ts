import { Router } from "express";

import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireOwnership } from "../../shared/middleware/require-ownership.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import * as controller from "./department.controller.js";
import * as departmentService from "./department.service.js";
import {
  addDepartmentMembersSchema,
  createDepartmentSchema,
  departmentIdParamSchema,
  listDepartmentMembersSchema,
  listDepartmentsSchema,
  removeDepartmentMemberSchema,
  updateDepartmentSchema,
} from "./department.schemas.js";

const router = Router();

router.post(
  "/",
  authenticate,
  validate(createDepartmentSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.create,
);

router.get(
  "/",
  authenticate,
  validate(listDepartmentsSchema),
  requireWorkspace,
  controller.list,
);

router.get(
  "/:id",
  authenticate,
  validate(departmentIdParamSchema),
  requireWorkspace,
  controller.getById,
);

router.patch(
  "/:id",
  authenticate,
  validate(updateDepartmentSchema),
  requireWorkspace,
  requireOwnership(
    (req) => departmentService.getDepartmentOwnership(req.workspace!.id, req.params.id as string),
    {
      notFoundCode: "DEPARTMENT_NOT_FOUND",
      notFoundMessage: "Department not found",
      forbiddenMessage: "You do not have permission to update this department",
    },
  ),
  controller.update,
);

router.delete(
  "/:id",
  authenticate,
  validate(departmentIdParamSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.remove,
);

router.get(
  "/:id/members",
  authenticate,
  validate(listDepartmentMembersSchema),
  requireWorkspace,
  controller.listMembers,
);

router.post(
  "/:id/members",
  authenticate,
  validate(addDepartmentMembersSchema),
  requireWorkspace,
  requireOwnership(
    (req) => departmentService.getDepartmentOwnership(req.workspace!.id, req.params.id as string),
    {
      notFoundCode: "DEPARTMENT_NOT_FOUND",
      notFoundMessage: "Department not found",
      forbiddenMessage: "You do not have permission to manage department members",
    },
  ),
  controller.addMembers,
);

router.delete(
  "/:id/members/:uid",
  authenticate,
  validate(removeDepartmentMemberSchema),
  requireWorkspace,
  requireOwnership(
    (req) => departmentService.getDepartmentOwnership(req.workspace!.id, req.params.id as string),
    {
      notFoundCode: "DEPARTMENT_NOT_FOUND",
      notFoundMessage: "Department not found",
      forbiddenMessage: "You do not have permission to manage department members",
    },
  ),
  controller.removeMember,
);

export default router;
