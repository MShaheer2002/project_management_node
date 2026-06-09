import { z } from "zod/v4";

const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

const documentSortSchema = z.enum([
  "createdAt:desc",
  "createdAt:asc",
  "name:asc",
  "name:desc",
]);

export const documentFileRefSchema = z.object({
  key: z.string().trim().min(1).max(1024),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(100),
  size: z.number().int().positive().max(DOCUMENT_MAX_BYTES),
  kind: z.literal("document"),
  assetUrl: z.string().url().nullable().optional(),
});

export const documentDraftSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(5000).nullable().optional(),
  file: documentFileRefSchema,
});

const listDocumentsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  cursor: z.string().uuid("Invalid document cursor").optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sort: documentSortSchema.optional(),
});

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
});

const teamParamsSchema = z.object({
  id: z.string().uuid("Invalid team ID"),
});

const projectParamsSchema = z.object({
  id: z.string().uuid("Invalid project ID"),
});

const documentParamsSchema = z.object({
  documentId: z.string().uuid("Invalid document ID"),
});

const updateDocumentBodySchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
});

export const listWorkspaceDocumentsSchema = {
  params: workspaceParamsSchema,
  query: listDocumentsQuerySchema,
};

export const createWorkspaceDocumentSchema = {
  params: workspaceParamsSchema,
  body: documentDraftSchema,
};

export const updateWorkspaceDocumentSchema = {
  params: workspaceParamsSchema.extend(documentParamsSchema.shape),
  body: updateDocumentBodySchema,
};

export const deleteWorkspaceDocumentSchema = {
  params: workspaceParamsSchema.extend(documentParamsSchema.shape),
};

export const listTeamDocumentsSchema = {
  params: teamParamsSchema,
  query: listDocumentsQuerySchema,
};

export const createTeamDocumentSchema = {
  params: teamParamsSchema,
  body: documentDraftSchema,
};

export const updateTeamDocumentSchema = {
  params: teamParamsSchema.extend(documentParamsSchema.shape),
  body: updateDocumentBodySchema,
};

export const deleteTeamDocumentSchema = {
  params: teamParamsSchema.extend(documentParamsSchema.shape),
};

export const listProjectDocumentsSchema = {
  params: projectParamsSchema,
  query: listDocumentsQuerySchema,
};

export const createProjectDocumentSchema = {
  params: projectParamsSchema,
  body: documentDraftSchema,
};

export const updateProjectDocumentSchema = {
  params: projectParamsSchema.extend(documentParamsSchema.shape),
  body: updateDocumentBodySchema,
};

export const deleteProjectDocumentSchema = {
  params: projectParamsSchema.extend(documentParamsSchema.shape),
};

export type DocumentDraftInput = z.infer<typeof documentDraftSchema>;
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentBodySchema>;
