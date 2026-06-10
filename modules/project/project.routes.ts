import type { RequestHandler } from "express";
import { Router } from "express";

import { authenticateDual as authenticate } from "../../shared/middleware/authenticate-dual.js";
import { requireOwnership } from "../../shared/middleware/require-ownership.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import * as controller from "./project.controller.js";
import * as projectService from "./project.service.js";
import {
  addProjectMembersSchema,
  createProjectSchema,
  listProjectMembersSchema,
  listProjectsSchema,
  projectIdParamsSchema,
  removeProjectMemberSchema,
  updateProjectSchema,
} from "./project.schemas.js";

const router = Router();

const requireAdminOrOwnerForInitialDocuments: RequestHandler = (req, _res, next) => {
  if ((req.body as { docs?: unknown[] } | undefined)?.docs?.length
    && req.workspace?.role !== "ADMIN"
    && req.workspace?.role !== "OWNER") {
    return next(
      new AppError(403, ERROR_CODES.DOCUMENT_UPLOAD_FORBIDDEN, "Only workspace admins and owners can attach project documents"),
    );
  }

  next();
};

router.post(
  "/",
  authenticate,
  validate(createProjectSchema),
  requireWorkspace,
  requireAdminOrOwnerForInitialDocuments,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  controller.create,
);

router.get(
  "/",
  authenticate,
  validate(listProjectsSchema),
  requireWorkspace,
  controller.list,
);

router.get(
  "/:id",
  authenticate,
  validate(projectIdParamsSchema),
  requireWorkspace,
  controller.getById,
);

router.patch(
  "/:id",
  authenticate,
  validate(updateProjectSchema),
  requireWorkspace,
  requireOwnership(
    (req) => projectService.getProjectOwnership(req.workspace!.id, req.params.id as string),
    {
      notFoundCode: "PROJECT_NOT_FOUND",
      notFoundMessage: "Project not found",
      forbiddenMessage: "You do not have permission to update this project",
    },
  ),
  controller.update,
);

router.delete(
  "/:id",
  authenticate,
  validate(projectIdParamsSchema),
  requireWorkspace,
  requireOwnership(
    (req) => projectService.getProjectOwnership(req.workspace!.id, req.params.id as string),
    {
      notFoundCode: "PROJECT_NOT_FOUND",
      notFoundMessage: "Project not found",
      forbiddenMessage: "You do not have permission to delete this project",
    },
  ),
  controller.remove,
);

router.get(
  "/:id/members",
  authenticate,
  validate(listProjectMembersSchema),
  requireWorkspace,
  controller.listMembers,
);

router.post(
  "/:id/members",
  authenticate,
  validate(addProjectMembersSchema),
  requireWorkspace,
  requireOwnership(
    (req) => projectService.getProjectOwnership(req.workspace!.id, req.params.id as string),
    {
      notFoundCode: "PROJECT_NOT_FOUND",
      notFoundMessage: "Project not found",
      forbiddenMessage: "You do not have permission to manage project members",
    },
  ),
  controller.addMembers,
);

router.delete(
  "/:id/members/:uid",
  authenticate,
  validate(removeProjectMemberSchema),
  requireWorkspace,
  requireOwnership(
    (req) => projectService.getProjectOwnership(req.workspace!.id, req.params.id as string),
    {
      notFoundCode: "PROJECT_NOT_FOUND",
      notFoundMessage: "Project not found",
      forbiddenMessage: "You do not have permission to manage project members",
    },
  ),
  controller.removeMember,
);

export default router;
