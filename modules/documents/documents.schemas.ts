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
  folderId: z.string().uuid("Invalid folder ID").nullable().optional(),
});

const listDocumentsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  cursor: z.string().uuid("Invalid document cursor").optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sort: documentSortSchema.optional(),
  folderId: z.string().uuid("Invalid folder ID").nullable().optional(),
}).catchall(z.unknown());

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

// ─── Folder schemas ──────────────────────────────────────────────────────────

const folderIdParamsSchema = z.object({
  folderId: z.string().uuid("Invalid folder ID"),
});

const createFolderBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().uuid("Invalid parent folder ID").nullable().optional(),
});

const renameFolderBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
});

const moveFolderBodySchema = z.object({
  parentId: z.string().uuid("Invalid parent folder ID").nullable(),
});

const moveDocumentBodySchema = z.object({
  folderId: z.string().uuid("Invalid folder ID").nullable(),
});

const listFoldersQuerySchema = z.object({
  parentId: z.string().uuid("Invalid parent folder ID").nullable().optional(),
}).catchall(z.unknown());

// Workspace folder schemas
export const listWorkspaceFoldersSchema = {
  params: workspaceParamsSchema,
  query: listFoldersQuerySchema,
};

export const createWorkspaceFolderSchema = {
  params: workspaceParamsSchema,
  body: createFolderBodySchema,
};

export const renameWorkspaceFolderSchema = {
  params: workspaceParamsSchema.extend(folderIdParamsSchema.shape),
  body: renameFolderBodySchema,
};

export const deleteWorkspaceFolderSchema = {
  params: workspaceParamsSchema.extend(folderIdParamsSchema.shape),
};

export const moveWorkspaceFolderSchema = {
  params: workspaceParamsSchema.extend(folderIdParamsSchema.shape),
  body: moveFolderBodySchema,
};

export const moveWorkspaceDocumentSchema = {
  params: workspaceParamsSchema.extend(documentParamsSchema.shape),
  body: moveDocumentBodySchema,
};

export const workspaceFolderBreadcrumbsSchema = {
  params: workspaceParamsSchema.extend(folderIdParamsSchema.shape),
};

// Team folder schemas
export const listTeamFoldersSchema = {
  params: teamParamsSchema,
  query: listFoldersQuerySchema,
};

export const createTeamFolderSchema = {
  params: teamParamsSchema,
  body: createFolderBodySchema,
};

export const renameTeamFolderSchema = {
  params: teamParamsSchema.extend(folderIdParamsSchema.shape),
  body: renameFolderBodySchema,
};

export const deleteTeamFolderSchema = {
  params: teamParamsSchema.extend(folderIdParamsSchema.shape),
};

export const moveTeamFolderSchema = {
  params: teamParamsSchema.extend(folderIdParamsSchema.shape),
  body: moveFolderBodySchema,
};

export const moveTeamDocumentSchema = {
  params: teamParamsSchema.extend(documentParamsSchema.shape),
  body: moveDocumentBodySchema,
};

export const teamFolderBreadcrumbsSchema = {
  params: teamParamsSchema.extend(folderIdParamsSchema.shape),
};

// Project folder schemas
export const listProjectFoldersSchema = {
  params: projectParamsSchema,
  query: listFoldersQuerySchema,
};

export const createProjectFolderSchema = {
  params: projectParamsSchema,
  body: createFolderBodySchema,
};

export const renameProjectFolderSchema = {
  params: projectParamsSchema.extend(folderIdParamsSchema.shape),
  body: renameFolderBodySchema,
};

export const deleteProjectFolderSchema = {
  params: projectParamsSchema.extend(folderIdParamsSchema.shape),
};

export const moveProjectFolderSchema = {
  params: projectParamsSchema.extend(folderIdParamsSchema.shape),
  body: moveFolderBodySchema,
};

export const moveProjectDocumentSchema = {
  params: projectParamsSchema.extend(documentParamsSchema.shape),
  body: moveDocumentBodySchema,
};

export const projectFolderBreadcrumbsSchema = {
  params: projectParamsSchema.extend(folderIdParamsSchema.shape),
};

export type DocumentDraftInput = z.infer<typeof documentDraftSchema>;
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentBodySchema>;
export type CreateFolderInput = z.infer<typeof createFolderBodySchema>;
export type RenameFolderInput = z.infer<typeof renameFolderBodySchema>;
export type MoveFolderInput = z.infer<typeof moveFolderBodySchema>;
export type MoveDocumentInput = z.infer<typeof moveDocumentBodySchema>;
export type ListFoldersQuery = z.infer<typeof listFoldersQuerySchema>;
