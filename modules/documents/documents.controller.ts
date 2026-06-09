import type { RequestHandler } from "express";

import { sendList, sendSuccess } from "../../shared/utils/api-response.js";
import type {
  DocumentDraftInput,
  ListDocumentsQuery,
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
