import { Router } from "express";

import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import * as controller from "./documents.controller.js";
import {
  createProjectDocumentSchema,
  createTeamDocumentSchema,
  createWorkspaceDocumentSchema,
  deleteProjectDocumentSchema,
  deleteTeamDocumentSchema,
  deleteWorkspaceDocumentSchema,
  listProjectDocumentsSchema,
  listTeamDocumentsSchema,
  listWorkspaceDocumentsSchema,
  updateProjectDocumentSchema,
  updateTeamDocumentSchema,
  updateWorkspaceDocumentSchema,
} from "./documents.schemas.js";

const router = Router();

router.get(
  "/workspaces/:workspaceId/documents",
  authenticate,
  validate(listWorkspaceDocumentsSchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  controller.listWorkspaceDocuments,
);

router.post(
  "/workspaces/:workspaceId/documents",
  authenticate,
  validate(createWorkspaceDocumentSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.createWorkspaceDocument,
);

router.patch(
  "/workspaces/:workspaceId/documents/:documentId",
  authenticate,
  validate(updateWorkspaceDocumentSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.updateWorkspaceDocument,
);

router.delete(
  "/workspaces/:workspaceId/documents/:documentId",
  authenticate,
  validate(deleteWorkspaceDocumentSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.deleteWorkspaceDocument,
);

router.get(
  "/teams/:id/documents",
  authenticate,
  validate(listTeamDocumentsSchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  controller.listTeamDocuments,
);

router.post(
  "/teams/:id/documents",
  authenticate,
  validate(createTeamDocumentSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.createTeamDocument,
);

router.patch(
  "/teams/:id/documents/:documentId",
  authenticate,
  validate(updateTeamDocumentSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.updateTeamDocument,
);

router.delete(
  "/teams/:id/documents/:documentId",
  authenticate,
  validate(deleteTeamDocumentSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.deleteTeamDocument,
);

router.get(
  "/projects/:id/documents",
  authenticate,
  validate(listProjectDocumentsSchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  controller.listProjectDocuments,
);

router.post(
  "/projects/:id/documents",
  authenticate,
  validate(createProjectDocumentSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.createProjectDocument,
);

router.patch(
  "/projects/:id/documents/:documentId",
  authenticate,
  validate(updateProjectDocumentSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.updateProjectDocument,
);

router.delete(
  "/projects/:id/documents/:documentId",
  authenticate,
  validate(deleteProjectDocumentSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.deleteProjectDocument,
);

export default router;
