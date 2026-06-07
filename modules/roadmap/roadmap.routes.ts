import type { Request, RequestHandler } from "express";
import { Router } from "express";

import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import * as controller from "./roadmap.controller.js";
import * as roadmapService from "./roadmap.service.js";
import {
  cancelDependencySchema,
  createDependencySchema,
  createMilestoneSchema,
  listRoadmapSchema,
  reorderMilestonesSchema,
  resolveDependencySchema,
  roadmapDependencyParamsSchema,
  roadmapMilestoneParamsSchema,
  roadmapProjectParamsSchema,
  updateMilestoneSchema,
  updateRoadmapScheduleSchema,
} from "./roadmap.schemas.js";

const router = Router();

function requireRoadmapProjectManageAccess(projectIdResolver: (req: Request) => string): RequestHandler {
  return async (req, _res, next) => {
    try {
      const allowed = await roadmapService.hasRoadmapManageAccess(
        req.workspace!.id,
        req.user!.id,
        req.workspace!.role,
        projectIdResolver(req),
      );

      if (!allowed) {
        throw new AppError(403, ERROR_CODES.ROADMAP_FORBIDDEN, "You do not have permission to manage this roadmap");
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireRoadmapDependencyManageAccess(): RequestHandler {
  return async (req, _res, next) => {
    try {
      const allowed = await roadmapService.hasDependencyManageAccess(
        req.workspace!.id,
        req.user!.id,
        req.workspace!.role,
        req.params.dependencyId as string,
      );

      if (!allowed) {
        throw new AppError(403, ERROR_CODES.ROADMAP_FORBIDDEN, "You do not have permission to manage this roadmap dependency");
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireRoadmapCreateDependencyAccess(): RequestHandler {
  return async (req, _res, next) => {
    try {
      const body = req.body as { blockingProjectId: string; blockedProjectId: string };
      const allowed = await roadmapService.hasAnyRoadmapManageAccess(
        req.workspace!.id,
        req.user!.id,
        req.workspace!.role,
        [body.blockingProjectId, body.blockedProjectId],
      );

      if (!allowed) {
        throw new AppError(403, ERROR_CODES.ROADMAP_FORBIDDEN, "You do not have permission to manage roadmap dependencies for these projects");
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

router.get(
  "/roadmap",
  authenticate,
  validate(listRoadmapSchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  controller.list,
);

router.get(
  "/roadmap/projects/:projectId",
  authenticate,
  validate(roadmapProjectParamsSchema),
  requireWorkspace,
  requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"),
  controller.getProjectDetail,
);

router.patch(
  "/roadmap/projects/:projectId/schedule",
  authenticate,
  validate(updateRoadmapScheduleSchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  requireRoadmapProjectManageAccess((req) => req.params.projectId as string),
  controller.updateSchedule,
);

router.post(
  "/roadmap/projects/:projectId/milestones",
  authenticate,
  validate(createMilestoneSchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  requireRoadmapProjectManageAccess((req) => req.params.projectId as string),
  controller.createMilestone,
);

router.patch(
  "/roadmap/projects/:projectId/milestones/reorder",
  authenticate,
  validate(reorderMilestonesSchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  requireRoadmapProjectManageAccess((req) => req.params.projectId as string),
  controller.reorderMilestones,
);

router.patch(
  "/roadmap/projects/:projectId/milestones/:milestoneId",
  authenticate,
  validate(updateMilestoneSchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  requireRoadmapProjectManageAccess((req) => req.params.projectId as string),
  controller.updateMilestone,
);

router.delete(
  "/roadmap/projects/:projectId/milestones/:milestoneId",
  authenticate,
  validate(roadmapMilestoneParamsSchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  requireRoadmapProjectManageAccess((req) => req.params.projectId as string),
  controller.deleteMilestone,
);

router.post(
  "/roadmap/dependencies",
  authenticate,
  validate(createDependencySchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  requireRoadmapCreateDependencyAccess(),
  controller.createDependency,
);

router.patch(
  "/roadmap/dependencies/:dependencyId/resolve",
  authenticate,
  validate(resolveDependencySchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  requireRoadmapDependencyManageAccess(),
  controller.resolveDependency,
);

router.patch(
  "/roadmap/dependencies/:dependencyId/cancel",
  authenticate,
  validate(cancelDependencySchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  requireRoadmapDependencyManageAccess(),
  controller.cancelDependency,
);

router.delete(
  "/roadmap/dependencies/:dependencyId",
  authenticate,
  validate(roadmapDependencyParamsSchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  requireRoadmapDependencyManageAccess(),
  controller.deleteDependency,
);

export default router;
