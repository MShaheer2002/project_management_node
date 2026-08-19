import type { RequestHandler } from "express";
import { Router } from "express";

import { authenticateDual as authenticate } from "../../shared/middleware/authenticate-dual.js";
import { requireOwnership } from "../../shared/middleware/require-ownership.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireScope } from "../../shared/middleware/require-scope.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import * as controller from "./project.controller.js";
import * as projectService from "./project.service.js";
import {
  addProjectMembersSchema,
  clearProjectWorkflowOverrideSchema,
  createProjectSchema,
  getProjectWorkflowSchema,
  getProjectWorkflowStatusUsageSchema,
  mergeProjectWorkflowStatusSchema,
  listProjectMembersSchema,
  listProjectsSchema,
  projectIdParamsSchema,
  removeProjectMemberSchema,
  updateProjectSchema,
  updateProjectWorkflowAutomationSchema,
  updateProjectWorkflowStatusesSchema,
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
  requireScope("projects:write"),
  requireAdminOrOwnerForInitialDocuments,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  controller.create,
);

router.get(
  "/",
  authenticate,
  validate(listProjectsSchema),
  requireWorkspace,
  requireScope("projects:read"),
  controller.list,
);

router.get(
  "/:id",
  authenticate,
  validate(projectIdParamsSchema),
  requireWorkspace,
  requireScope("projects:read"),
  controller.getById,
);

router.patch(
  "/:id",
  authenticate,
  validate(updateProjectSchema),
  requireWorkspace,
  requireScope("projects:write"),
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
  requireScope("projects:write"),
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
  requireScope("projects:read"),
  controller.listMembers,
);

router.post(
  "/:id/members",
  authenticate,
  validate(addProjectMembersSchema),
  requireWorkspace,
  requireScope("projects:write"),
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
  requireScope("projects:write"),
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

// ─── Workflow Override ───────────────────────────────────────────────────────

// Get this project's effective workflow — any member can view
router.get(
  "/:id/workflow",
  authenticate,
  validate(getProjectWorkflowSchema),
  requireWorkspace,
  requireScope("projects:read"),
  controller.getWorkflow,
);

router.get(
  "/:id/workflow/statuses/:statusKey/usage",
  authenticate,
  validate(getProjectWorkflowStatusUsageSchema),
  requireWorkspace,
  requireScope("projects:read"),
  controller.getWorkflowStatusUsage,
);

router.post(
  "/:id/workflow/statuses/:statusKey/merge",
  authenticate,
  validate(mergeProjectWorkflowStatusSchema),
  requireWorkspace,
  requireScope("projects:write"),
  requireOwnership(
    (req) => projectService.getProjectOwnership(req.workspace!.id, req.params.id as string),
    {
      notFoundCode: "PROJECT_NOT_FOUND",
      notFoundMessage: "Project not found",
      forbiddenMessage: "You do not have permission to manage this project's workflow",
    },
  ),
  controller.mergeWorkflowStatus,
);

// Set/replace this project's workflow override — same ownership rule as other project settings
router.put(
  "/:id/workflow/statuses",
  authenticate,
  validate(updateProjectWorkflowStatusesSchema),
  requireWorkspace,
  requireScope("projects:write"),
  requireOwnership(
    (req) => projectService.getProjectOwnership(req.workspace!.id, req.params.id as string),
    {
      notFoundCode: "PROJECT_NOT_FOUND",
      notFoundMessage: "Project not found",
      forbiddenMessage: "You do not have permission to manage this project's workflow",
    },
  ),
  controller.updateWorkflowStatuses,
);

// Clear this project's workflow override, reverting to the workspace default
router.delete(
  "/:id/workflow",
  authenticate,
  validate(clearProjectWorkflowOverrideSchema),
  requireWorkspace,
  requireScope("projects:write"),
  requireOwnership(
    (req) => projectService.getProjectOwnership(req.workspace!.id, req.params.id as string),
    {
      notFoundCode: "PROJECT_NOT_FOUND",
      notFoundMessage: "Project not found",
      forbiddenMessage: "You do not have permission to manage this project's workflow",
    },
  ),
  controller.clearWorkflowOverride,
);

router.put(
  "/:id/workflow/automation",
  authenticate,
  validate(updateProjectWorkflowAutomationSchema),
  requireWorkspace,
  requireScope("projects:write"),
  requireOwnership(
    (req) => projectService.getProjectOwnership(req.workspace!.id, req.params.id as string),
    {
      notFoundCode: "PROJECT_NOT_FOUND",
      notFoundMessage: "Project not found",
      forbiddenMessage: "You do not have permission to manage this project's workflow",
    },
  ),
  controller.updateWorkflowAutomation,
);

export default router;
