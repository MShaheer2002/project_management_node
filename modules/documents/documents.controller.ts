import type { RequestHandler } from "express";

import { sendList, sendSuccess } from "../../shared/utils/api-response.js";
import type {
  CreateFolderInput,
  DocumentDraftInput,
  ListDocumentsQuery,
  ListFoldersQuery,
  MoveDocumentInput,
  MoveFolderInput,
  RenameFolderInput,
  UpdateDocumentInput,
} from "./documents.schemas.js";
import * as documentsService from "./documents.service.js";

export const listWorkspaceDocuments: RequestHandler = async (req, res, next) => {
  try {
    const result = await documentsService.listWorkspaceDocuments(
      req.workspace!.id,
      (req.validated?.query ?? req.query) as ListDocumentsQuery,
    );
    sendList(res, result.items, result.meta);
  } catch (error) {
    next(error);
  }
};

export const createWorkspaceDocument: RequestHandler = async (req, res, next) => {
  try {
    const document = await documentsService.createWorkspaceDocument(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      req.body as DocumentDraftInput,
    );
    sendSuccess(res, 201, document);
  } catch (error) {
    next(error);
  }
};

export const updateWorkspaceDocument: RequestHandler = async (req, res, next) => {
  try {
    const document = await documentsService.updateWorkspaceDocument(
      req.workspace!.id,
      req.params.documentId as string,
      req.user!.id,
      req.body as UpdateDocumentInput,
    );
    sendSuccess(res, 200, document);
  } catch (error) {
    next(error);
  }
};

export const deleteWorkspaceDocument: RequestHandler = async (req, res, next) => {
  try {
    await documentsService.deleteWorkspaceDocument(
      req.workspace!.id,
      req.params.documentId as string,
      req.user!.id,
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const listTeamDocuments: RequestHandler = async (req, res, next) => {
  try {
    const result = await documentsService.listTeamDocuments(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      req.params.id as string,
      (req.validated?.query ?? req.query) as ListDocumentsQuery,
    );
    sendList(res, result.items, result.meta);
  } catch (error) {
    next(error);
  }
};

export const createTeamDocument: RequestHandler = async (req, res, next) => {
  try {
    const document = await documentsService.createTeamDocument(
      req.workspace!.id,
      req.workspace!.role,
      req.params.id as string,
      req.user!.id,
      req.body as DocumentDraftInput,
    );
    sendSuccess(res, 201, document);
  } catch (error) {
    next(error);
  }
};

export const updateTeamDocument: RequestHandler = async (req, res, next) => {
  try {
    const document = await documentsService.updateTeamDocument(
      req.workspace!.id,
      req.params.id as string,
      req.params.documentId as string,
      req.user!.id,
      req.body as UpdateDocumentInput,
    );
    sendSuccess(res, 200, document);
  } catch (error) {
    next(error);
  }
};

export const deleteTeamDocument: RequestHandler = async (req, res, next) => {
  try {
    await documentsService.deleteTeamDocument(
      req.workspace!.id,
      req.params.id as string,
      req.params.documentId as string,
      req.user!.id,
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const listProjectDocuments: RequestHandler = async (req, res, next) => {
  try {
    const result = await documentsService.listProjectDocuments(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      req.params.id as string,
      (req.validated?.query ?? req.query) as ListDocumentsQuery,
    );
    sendList(res, result.items, result.meta);
  } catch (error) {
    next(error);
  }
};

export const createProjectDocument: RequestHandler = async (req, res, next) => {
  try {
    const document = await documentsService.createProjectDocument(
      req.workspace!.id,
      req.workspace!.role,
      req.params.id as string,
      req.user!.id,
      req.body as DocumentDraftInput,
    );
    sendSuccess(res, 201, document);
  } catch (error) {
    next(error);
  }
};

export const updateProjectDocument: RequestHandler = async (req, res, next) => {
  try {
    const document = await documentsService.updateProjectDocument(
      req.workspace!.id,
      req.params.id as string,
      req.params.documentId as string,
      req.user!.id,
      req.body as UpdateDocumentInput,
    );
    sendSuccess(res, 200, document);
  } catch (error) {
    next(error);
  }
};

export const deleteProjectDocument: RequestHandler = async (req, res, next) => {
  try {
    await documentsService.deleteProjectDocument(
      req.workspace!.id,
      req.params.id as string,
      req.params.documentId as string,
      req.user!.id,
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// ─── Workspace folder handlers ───────────────────────────────────────────────

export const listWorkspaceFolders: RequestHandler = async (req, res, next) => {
  try {
    const folders = await documentsService.listWorkspaceFolders(
      req.workspace!.id,
      (req.validated?.query ?? req.query) as ListFoldersQuery,
    );
    sendSuccess(res, 200, folders);
  } catch (error) {
    next(error);
  }
};

export const createWorkspaceFolder: RequestHandler = async (req, res, next) => {
  try {
    const folder = await documentsService.createWorkspaceFolder(
      req.workspace!.id,
      req.body as CreateFolderInput,
      req.user!.id,
    );
    sendSuccess(res, 201, folder);
  } catch (error) {
    next(error);
  }
};

export const renameWorkspaceFolder: RequestHandler = async (req, res, next) => {
  try {
    const folder = await documentsService.renameWorkspaceFolder(
      req.workspace!.id,
      req.params.folderId as string,
      req.body as RenameFolderInput,
      req.user!.id,
    );
    sendSuccess(res, 200, folder);
  } catch (error) {
    next(error);
  }
};

export const deleteWorkspaceFolder: RequestHandler = async (req, res, next) => {
  try {
    await documentsService.deleteWorkspaceFolder(
      req.workspace!.id,
      req.params.folderId as string,
      req.user!.id,
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const moveWorkspaceFolder: RequestHandler = async (req, res, next) => {
  try {
    const folder = await documentsService.moveWorkspaceFolder(
      req.workspace!.id,
      req.params.folderId as string,
      req.body as MoveFolderInput,
      req.user!.id,
    );
    sendSuccess(res, 200, folder);
  } catch (error) {
    next(error);
  }
};

export const moveWorkspaceDocument: RequestHandler = async (req, res, next) => {
  try {
    const document = await documentsService.moveWorkspaceDocument(
      req.workspace!.id,
      req.params.documentId as string,
      req.body as MoveDocumentInput,
      req.user!.id,
    );
    sendSuccess(res, 200, document);
  } catch (error) {
    next(error);
  }
};

export const getWorkspaceFolderBreadcrumbs: RequestHandler = async (req, res, next) => {
  try {
    const breadcrumbs = await documentsService.getWorkspaceFolderBreadcrumbs(
      req.workspace!.id,
      req.params.folderId as string,
    );
    sendSuccess(res, 200, breadcrumbs);
  } catch (error) {
    next(error);
  }
};

// ─── Team folder handlers ────────────────────────────────────────────────────

export const listTeamFolders: RequestHandler = async (req, res, next) => {
  try {
    const folders = await documentsService.listTeamFolders(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      req.params.id as string,
      (req.validated?.query ?? req.query) as ListFoldersQuery,
    );
    sendSuccess(res, 200, folders);
  } catch (error) {
    next(error);
  }
};

export const createTeamFolder: RequestHandler = async (req, res, next) => {
  try {
    const folder = await documentsService.createTeamFolder(
      req.workspace!.id,
      req.params.id as string,
      req.body as CreateFolderInput,
      req.user!.id,
    );
    sendSuccess(res, 201, folder);
  } catch (error) {
    next(error);
  }
};

export const renameTeamFolder: RequestHandler = async (req, res, next) => {
  try {
    const folder = await documentsService.renameTeamFolder(
      req.workspace!.id,
      req.params.id as string,
      req.params.folderId as string,
      req.body as RenameFolderInput,
      req.user!.id,
    );
    sendSuccess(res, 200, folder);
  } catch (error) {
    next(error);
  }
};

export const deleteTeamFolder: RequestHandler = async (req, res, next) => {
  try {
    await documentsService.deleteTeamFolder(
      req.workspace!.id,
      req.params.id as string,
      req.params.folderId as string,
      req.user!.id,
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const moveTeamFolder: RequestHandler = async (req, res, next) => {
  try {
    const folder = await documentsService.moveTeamFolder(
      req.workspace!.id,
      req.params.id as string,
      req.params.folderId as string,
      req.body as MoveFolderInput,
      req.user!.id,
    );
    sendSuccess(res, 200, folder);
  } catch (error) {
    next(error);
  }
};

export const moveTeamDocument: RequestHandler = async (req, res, next) => {
  try {
    const document = await documentsService.moveTeamDocument(
      req.workspace!.id,
      req.params.id as string,
      req.params.documentId as string,
      req.body as MoveDocumentInput,
      req.user!.id,
    );
    sendSuccess(res, 200, document);
  } catch (error) {
    next(error);
  }
};

export const getTeamFolderBreadcrumbs: RequestHandler = async (req, res, next) => {
  try {
    const breadcrumbs = await documentsService.getTeamFolderBreadcrumbs(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      req.params.id as string,
      req.params.folderId as string,
    );
    sendSuccess(res, 200, breadcrumbs);
  } catch (error) {
    next(error);
  }
};

// ─── Project folder handlers ─────────────────────────────────────────────────

export const listProjectFolders: RequestHandler = async (req, res, next) => {
  try {
    const folders = await documentsService.listProjectFolders(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      req.params.id as string,
      (req.validated?.query ?? req.query) as ListFoldersQuery,
    );
    sendSuccess(res, 200, folders);
  } catch (error) {
    next(error);
  }
};

export const createProjectFolder: RequestHandler = async (req, res, next) => {
  try {
    const folder = await documentsService.createProjectFolder(
      req.workspace!.id,
      req.params.id as string,
      req.body as CreateFolderInput,
      req.user!.id,
    );
    sendSuccess(res, 201, folder);
  } catch (error) {
    next(error);
  }
};

export const renameProjectFolder: RequestHandler = async (req, res, next) => {
  try {
    const folder = await documentsService.renameProjectFolder(
      req.workspace!.id,
      req.params.id as string,
      req.params.folderId as string,
      req.body as RenameFolderInput,
      req.user!.id,
    );
    sendSuccess(res, 200, folder);
  } catch (error) {
    next(error);
  }
};

export const deleteProjectFolder: RequestHandler = async (req, res, next) => {
  try {
    await documentsService.deleteProjectFolder(
      req.workspace!.id,
      req.params.id as string,
      req.params.folderId as string,
      req.user!.id,
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const moveProjectFolder: RequestHandler = async (req, res, next) => {
  try {
    const folder = await documentsService.moveProjectFolder(
      req.workspace!.id,
      req.params.id as string,
      req.params.folderId as string,
      req.body as MoveFolderInput,
      req.user!.id,
    );
    sendSuccess(res, 200, folder);
  } catch (error) {
    next(error);
  }
};

export const moveProjectDocument: RequestHandler = async (req, res, next) => {
  try {
    const document = await documentsService.moveProjectDocument(
      req.workspace!.id,
      req.params.id as string,
      req.params.documentId as string,
      req.body as MoveDocumentInput,
      req.user!.id,
    );
    sendSuccess(res, 200, document);
  } catch (error) {
    next(error);
  }
};

export const getProjectFolderBreadcrumbs: RequestHandler = async (req, res, next) => {
  try {
    const breadcrumbs = await documentsService.getProjectFolderBreadcrumbs(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      req.params.id as string,
      req.params.folderId as string,
    );
    sendSuccess(res, 200, breadcrumbs);
  } catch (error) {
    next(error);
  }
};
