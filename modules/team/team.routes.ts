import type { RequestHandler } from "express";
import { Router } from "express";

import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireOwnership } from "../../shared/middleware/require-ownership.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import * as controller from "./team.controller.js";
import * as teamService from "./team.service.js";
import {
  addTeamMembersSchema,
  createTeamSchema,
  listTeamMembersSchema,
  listTeamsSchema,
  removeTeamMemberSchema,
  teamIdParamSchema,
  updateTeamSchema,
} from "./team.schemas.js";

const router = Router();

const requireAdminOrOwnerForInitialDocuments: RequestHandler = (req, _res, next) => {
  if ((req.body as { docs?: unknown[] } | undefined)?.docs?.length
    && req.workspace?.role !== "ADMIN"
    && req.workspace?.role !== "OWNER") {
    return next(
      new AppError(403, ERROR_CODES.DOCUMENT_UPLOAD_FORBIDDEN, "Only workspace admins and owners can attach team documents"),
    );
  }

  next();
};

router.post(
  "/",
  authenticate,
  validate(createTeamSchema),
  requireWorkspace,
  requireAdminOrOwnerForInitialDocuments,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  controller.create,
);

router.get(
  "/",
  authenticate,
  validate(listTeamsSchema),
  requireWorkspace,
  controller.list,
);

router.get(
  "/:id",
  authenticate,
  validate(teamIdParamSchema),
  requireWorkspace,
  controller.getById,
);

router.patch(
  "/:id",
  authenticate,
  validate(updateTeamSchema),
  requireWorkspace,
  requireOwnership(
    (req) => teamService.getTeamOwnership(req.workspace!.id, req.params.id as string),
    {
      notFoundCode: "TEAM_NOT_FOUND",
      notFoundMessage: "Team not found",
      forbiddenMessage: "You do not have permission to update this team",
    },
  ),
  controller.update,
);

router.delete(
  "/:id",
  authenticate,
  validate(teamIdParamSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.remove,
);

router.get(
  "/:id/members",
  authenticate,
  validate(listTeamMembersSchema),
  requireWorkspace,
  controller.listMembers,
);

router.post(
  "/:id/members",
  authenticate,
  validate(addTeamMembersSchema),
  requireWorkspace,
  requireOwnership(
    (req) => teamService.getTeamOwnership(req.workspace!.id, req.params.id as string),
    {
      notFoundCode: "TEAM_NOT_FOUND",
      notFoundMessage: "Team not found",
      forbiddenMessage: "You do not have permission to manage team members",
    },
  ),
  controller.addMembers,
);

router.delete(
  "/:id/members/:uid",
  authenticate,
  validate(removeTeamMemberSchema),
  requireWorkspace,
  requireOwnership(
    (req) => teamService.getTeamOwnership(req.workspace!.id, req.params.id as string),
    {
      notFoundCode: "TEAM_NOT_FOUND",
      notFoundMessage: "Team not found",
      forbiddenMessage: "You do not have permission to manage team members",
    },
  ),
  controller.removeMember,
);

export default router;
