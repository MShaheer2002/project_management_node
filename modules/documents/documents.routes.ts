import { Router } from "express";

import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import * as controller from "./documents.controller.js";
import {
  createProjectDocumentSchema,
  createProjectFolderSchema,
  createTeamDocumentSchema,
  createTeamFolderSchema,
  createWorkspaceDocumentSchema,
  createWorkspaceFolderSchema,
  deleteProjectDocumentSchema,
  deleteProjectFolderSchema,
  deleteTeamDocumentSchema,
  deleteTeamFolderSchema,
  deleteWorkspaceDocumentSchema,
  deleteWorkspaceFolderSchema,
  listProjectDocumentsSchema,
  listProjectFoldersSchema,
  listTeamDocumentsSchema,
  listTeamFoldersSchema,
  listWorkspaceDocumentsSchema,
  listWorkspaceFoldersSchema,
  moveProjectDocumentSchema,
  moveProjectFolderSchema,
  moveTeamDocumentSchema,
  moveTeamFolderSchema,
  moveWorkspaceDocumentSchema,
  moveWorkspaceFolderSchema,
  projectFolderBreadcrumbsSchema,
  renameProjectFolderSchema,
  renameTeamFolderSchema,
  renameWorkspaceFolderSchema,
  teamFolderBreadcrumbsSchema,
  updateProjectDocumentSchema,
  updateTeamDocumentSchema,
  updateWorkspaceDocumentSchema,
  workspaceFolderBreadcrumbsSchema,
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

// ─── Workspace folder routes ─────────────────────────────────────────────────

router.get(
  "/workspaces/:workspaceId/documents/folders",
  authenticate,
  validate(listWorkspaceFoldersSchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  controller.listWorkspaceFolders,
);

router.get(
  "/workspaces/:workspaceId/documents/folders/:folderId/breadcrumbs",
  authenticate,
  validate(workspaceFolderBreadcrumbsSchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  controller.getWorkspaceFolderBreadcrumbs,
);

router.post(
  "/workspaces/:workspaceId/documents/folders",
  authenticate,
  validate(createWorkspaceFolderSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.createWorkspaceFolder,
);

router.patch(
  "/workspaces/:workspaceId/documents/folders/:folderId",
  authenticate,
  validate(renameWorkspaceFolderSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.renameWorkspaceFolder,
);

router.delete(
  "/workspaces/:workspaceId/documents/folders/:folderId",
  authenticate,
  validate(deleteWorkspaceFolderSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.deleteWorkspaceFolder,
);

router.post(
  "/workspaces/:workspaceId/documents/folders/:folderId/move",
  authenticate,
  validate(moveWorkspaceFolderSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.moveWorkspaceFolder,
);

router.post(
  "/workspaces/:workspaceId/documents/:documentId/move",
  authenticate,
  validate(moveWorkspaceDocumentSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.moveWorkspaceDocument,
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

// ─── Team folder routes ──────────────────────────────────────────────────────

router.get(
  "/teams/:id/documents/folders",
  authenticate,
  validate(listTeamFoldersSchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  controller.listTeamFolders,
);

router.get(
  "/teams/:id/documents/folders/:folderId/breadcrumbs",
  authenticate,
  validate(teamFolderBreadcrumbsSchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  controller.getTeamFolderBreadcrumbs,
);

router.post(
  "/teams/:id/documents/folders",
  authenticate,
  validate(createTeamFolderSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.createTeamFolder,
);

router.patch(
  "/teams/:id/documents/folders/:folderId",
  authenticate,
  validate(renameTeamFolderSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.renameTeamFolder,
);

router.delete(
  "/teams/:id/documents/folders/:folderId",
  authenticate,
  validate(deleteTeamFolderSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.deleteTeamFolder,
);

router.post(
  "/teams/:id/documents/folders/:folderId/move",
  authenticate,
  validate(moveTeamFolderSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.moveTeamFolder,
);

router.post(
  "/teams/:id/documents/:documentId/move",
  authenticate,
  validate(moveTeamDocumentSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.moveTeamDocument,
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

// ─── Project folder routes ───────────────────────────────────────────────────

router.get(
  "/projects/:id/documents/folders",
  authenticate,
  validate(listProjectFoldersSchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  controller.listProjectFolders,
);

router.get(
  "/projects/:id/documents/folders/:folderId/breadcrumbs",
  authenticate,
  validate(projectFolderBreadcrumbsSchema),
  requireWorkspace,
  requireRole("MEMBER", "ADMIN", "OWNER"),
  controller.getProjectFolderBreadcrumbs,
);

router.post(
  "/projects/:id/documents/folders",
  authenticate,
  validate(createProjectFolderSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.createProjectFolder,
);

router.patch(
  "/projects/:id/documents/folders/:folderId",
  authenticate,
  validate(renameProjectFolderSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.renameProjectFolder,
);

router.delete(
  "/projects/:id/documents/folders/:folderId",
  authenticate,
  validate(deleteProjectFolderSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.deleteProjectFolder,
);

router.post(
  "/projects/:id/documents/folders/:folderId/move",
  authenticate,
  validate(moveProjectFolderSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.moveProjectFolder,
);

router.post(
  "/projects/:id/documents/:documentId/move",
  authenticate,
  validate(moveProjectDocumentSchema),
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  controller.moveProjectDocument,
);

export default router;
