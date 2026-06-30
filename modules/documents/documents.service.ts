import type { WorkspaceRole } from "../../app/generated/prisma/client.js";

import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import { logActivity } from "../../shared/utils/activity.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import { prisma } from "../../shared/utils/prisma.js";
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
import { validateDocumentRef } from "./documents.storage.js";

const documentSelect = {
  id: true,
  workspaceId: true,
  scope: true,
  teamId: true,
  projectId: true,
  folderId: true,
  name: true,
  description: true,
  key: true,
  fileName: true,
  fileUrl: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
  updatedAt: true,
  uploadedBy: {
    select: {
      id: true,
      name: true,
      email: true,
      avatar: true,
    },
  },
} as const;

type DocumentRecord = any;
type DbClient = any;

type ScopeContext =
  | { scope: "WORKSPACE" }
  | { scope: "TEAM"; teamId: string }
  | { scope: "PROJECT"; projectId: string };

function normalizeNullableText(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value.length === 0) {
    return null;
  }

  return value;
}

function mapDocument(record: DocumentRecord) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    scope: record.scope,
    teamId: record.teamId,
    projectId: record.projectId,
    folderId: record.folderId ?? null,
    name: record.name,
    description: record.description,
    key: record.key,
    fileName: record.fileName,
    fileUrl: record.fileUrl,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    uploadedBy: record.uploadedBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function getDocumentOrderBy(sort: ListDocumentsQuery["sort"]) {
  switch (sort) {
    case "createdAt:asc":
      return [{ createdAt: "asc" }, { id: "asc" }];
    case "name:asc":
      return [{ name: "asc" }, { id: "asc" }];
    case "name:desc":
      return [{ name: "desc" }, { id: "desc" }];
    case "createdAt:desc":
    default:
      return [{ createdAt: "desc" }, { id: "desc" }];
  }
}

function buildScopeWhere(workspaceId: string, context: ScopeContext) {
  switch (context.scope) {
    case "WORKSPACE":
      return { workspaceId, scope: "WORKSPACE", teamId: null, projectId: null };
    case "TEAM":
      return { workspaceId, scope: "TEAM", teamId: context.teamId, projectId: null };
    case "PROJECT":
      return { workspaceId, scope: "PROJECT", projectId: context.projectId };
  }
}

async function incrementStorageUsageTx(tx: DbClient, workspaceId: string, bytes: number) {
  if (bytes <= 0) return;

  await tx.subscription.update({
    where: { workspaceId },
    data: { storageUsedBytes: { increment: bytes } },
  });
}

async function decrementStorageUsage(workspaceId: string, bytes: number) {
  if (bytes <= 0) return;

  await prisma.$executeRaw`
    UPDATE "Subscription"
    SET "storageUsedBytes" = GREATEST("storageUsedBytes" - ${BigInt(bytes)}, 0)
    WHERE "workspaceId" = ${workspaceId}
  `;
}

async function assertTeamExists(workspaceId: string, teamId: string) {
  const team = await prisma.team.findFirst({
    where: { id: teamId, workspaceId },
    select: { id: true, name: true },
  });

  if (!team) {
    throw new AppError(404, ERROR_CODES.TEAM_NOT_FOUND, "Team not found");
  }

  return team;
}

async function assertProjectVisible(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  userId: string,
  projectId: string,
) {
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      workspaceId,
      ...(workspaceRole === "OWNER" || workspaceRole === "ADMIN"
        ? {}
        : {
            OR: [
              { visibility: "PUBLIC" },
              { leadId: userId },
              { memberships: { some: { userId } } },
            ],
          }),
    },
    select: { id: true, name: true },
  });

  if (project) {
    return project;
  }

  const existing = await prisma.project.findFirst({
    where: { id: projectId, workspaceId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
  }

  throw new AppError(404, ERROR_CODES.PRIVATE_PROJECT_FORBIDDEN, "Project is not visible");
}

async function assertProjectExists(workspaceId: string, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId },
    select: { id: true, name: true },
  });

  if (!project) {
    throw new AppError(404, ERROR_CODES.PROJECT_NOT_FOUND, "Project not found");
  }

  return project;
}

async function assertScopeAccessible(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  userId: string,
  context: ScopeContext,
) {
  switch (context.scope) {
    case "WORKSPACE":
      return { id: workspaceId, name: "Workspace" };
    case "TEAM":
      return assertTeamExists(workspaceId, context.teamId);
    case "PROJECT":
      return assertProjectVisible(workspaceId, workspaceRole, userId, context.projectId);
  }
}

async function assertScopeExists(workspaceId: string, context: ScopeContext) {
  switch (context.scope) {
    case "WORKSPACE":
      return { id: workspaceId, name: "Workspace" };
    case "TEAM":
      return assertTeamExists(workspaceId, context.teamId);
    case "PROJECT":
      return assertProjectExists(workspaceId, context.projectId);
  }
}

async function listDocuments(workspaceId: string, context: ScopeContext, query: ListDocumentsQuery) {
  const limit = clampListLimit(query.limit);
  const folderFilter: any =
    query.folderId !== undefined
      ? { folderId: query.folderId }
      : { folderId: null };
  const where: any = {
    ...buildScopeWhere(workspaceId, context),
    ...folderFilter,
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: "insensitive" } },
            { description: { contains: query.q, mode: "insensitive" } },
            { fileName: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [total, records] = await Promise.all([
    prisma.entityDocument.count({ where }),
    prisma.entityDocument.findMany({
      where: where as any,
      orderBy: getDocumentOrderBy(query.sort) as any,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: limit + 1,
      select: documentSelect,
    }),
  ]);

  const page = slicePage(records, limit);

  return {
    items: page.items.map(mapDocument),
    meta: {
      total,
      cursor: page.hasMore ? page.items[page.items.length - 1]?.id ?? null : null,
      hasMore: page.hasMore,
    },
  };
}

async function createDocumentsForScope(
  tx: DbClient,
  workspaceId: string,
  uploadedById: string,
  context: ScopeContext,
  documents: DocumentDraftInput[],
) {
  if (documents.length === 0) {
    return [];
  }

  const keys = documents.map((document) => document.file.key);
  if (new Set(keys).size !== keys.length) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "Document keys must be unique within the request");
  }

  const existing = await tx.entityDocument.findMany({
    where: {
      workspaceId,
      key: { in: keys },
    },
    select: { key: true },
  });

  if (existing.length > 0) {
    throw new AppError(409, ERROR_CODES.CONFLICT, "One or more uploaded documents have already been attached");
  }

  const created: DocumentRecord[] = [];

  for (const document of documents) {
    const file = validateDocumentRef(workspaceId, document.file);
    const record = await tx.entityDocument.create({
      data: {
        workspaceId,
        scope: context.scope as any,
        teamId: context.scope === "TEAM" ? context.teamId : null,
        projectId: context.scope === "PROJECT" ? context.projectId : null,
        folderId: document.folderId ?? null,
        name: document.name,
        description: normalizeNullableText(document.description),
        key: file.key,
        fileName: file.fileName,
        fileUrl: file.fileUrl,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        uploadedById,
      },
      select: documentSelect,
    });

    created.push(record);
  }

  await incrementStorageUsageTx(
    tx,
    workspaceId,
    created.reduce((sum, document) => sum + document.sizeBytes, 0),
  );

  return created;
}

async function createDocument(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  userId: string,
  context: ScopeContext,
  input: DocumentDraftInput,
) {
  const created = await prisma.$transaction(async (tx) => {
    await assertScopeAccessible(workspaceId, workspaceRole, userId, context);
    const [document] = await createDocumentsForScope(tx, workspaceId, userId, context, [input]);
    return document;
  });

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "DOCUMENT_CREATED",
    targetType: "DOCUMENT",
    targetId: created.id,
    message: `Document ${created.name} added`,
    metadata: {
      scope: created.scope,
      teamId: created.teamId,
      projectId: created.projectId,
      key: created.key,
    },
  });

  return mapDocument(created);
}

async function updateDocument(workspaceId: string, documentId: string, userId: string, context: ScopeContext, input: UpdateDocumentInput) {
  await assertScopeExists(workspaceId, context);

  const current = await prisma.entityDocument.findFirst({
    where: {
      id: documentId,
      ...buildScopeWhere(workspaceId, context),
    } as any,
    select: { id: true, name: true },
  });

  if (!current) {
    throw new AppError(404, ERROR_CODES.DOCUMENT_NOT_FOUND, "Document not found");
  }

  const updated = await prisma.entityDocument.update({
    where: { id: current.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: normalizeNullableText(input.description) } : {}),
    } as any,
    select: documentSelect,
  });

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "DOCUMENT_UPDATED",
    targetType: "DOCUMENT",
    targetId: updated.id,
    message: `Document ${updated.name} updated`,
    metadata: {
      scope: updated.scope,
      teamId: updated.teamId,
      projectId: updated.projectId,
    },
  });

  return mapDocument(updated);
}

async function deleteDocument(workspaceId: string, documentId: string, userId: string, context: ScopeContext) {
  await assertScopeExists(workspaceId, context);

  const current = await prisma.entityDocument.findFirst({
    where: {
      id: documentId,
      ...buildScopeWhere(workspaceId, context),
    } as any,
    select: { id: true, name: true, sizeBytes: true, scope: true, teamId: true, projectId: true },
  });

  if (!current) {
    throw new AppError(404, ERROR_CODES.DOCUMENT_NOT_FOUND, "Document not found");
  }

  await prisma.entityDocument.delete({ where: { id: current.id } });
  await decrementStorageUsage(workspaceId, current.sizeBytes);

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "DOCUMENT_DELETED",
    targetType: "DOCUMENT",
    targetId: current.id,
    message: `Document ${current.name} deleted`,
    metadata: {
      scope: current.scope,
      teamId: current.teamId,
      projectId: current.projectId,
    },
  });
}

export async function attachInitialTeamDocuments(
  tx: any,
  workspaceId: string,
  teamId: string,
  uploadedById: string,
  documents: DocumentDraftInput[],
) {
  await createDocumentsForScope(tx, workspaceId, uploadedById, { scope: "TEAM", teamId }, documents);
}

export async function attachInitialProjectDocuments(
  tx: any,
  workspaceId: string,
  projectId: string,
  uploadedById: string,
  documents: DocumentDraftInput[],
) {
  await createDocumentsForScope(tx, workspaceId, uploadedById, { scope: "PROJECT", projectId }, documents);
}

export async function listWorkspaceDocuments(workspaceId: string, query: ListDocumentsQuery) {
  return listDocuments(workspaceId, { scope: "WORKSPACE" }, query);
}

export async function createWorkspaceDocument(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  userId: string,
  input: DocumentDraftInput,
) {
  return createDocument(workspaceId, workspaceRole, userId, { scope: "WORKSPACE" }, input);
}

export async function updateWorkspaceDocument(workspaceId: string, documentId: string, userId: string, input: UpdateDocumentInput) {
  return updateDocument(workspaceId, documentId, userId, { scope: "WORKSPACE" }, input);
}

export async function deleteWorkspaceDocument(workspaceId: string, documentId: string, userId: string) {
  return deleteDocument(workspaceId, documentId, userId, { scope: "WORKSPACE" });
}

export async function listTeamDocuments(workspaceId: string, workspaceRole: WorkspaceRole, userId: string, teamId: string, query: ListDocumentsQuery) {
  await assertScopeAccessible(workspaceId, workspaceRole, userId, { scope: "TEAM", teamId });
  return listDocuments(workspaceId, { scope: "TEAM", teamId }, query);
}

export async function createTeamDocument(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  teamId: string,
  userId: string,
  input: DocumentDraftInput,
) {
  return createDocument(workspaceId, workspaceRole, userId, { scope: "TEAM", teamId }, input);
}

export async function updateTeamDocument(workspaceId: string, teamId: string, documentId: string, userId: string, input: UpdateDocumentInput) {
  return updateDocument(workspaceId, documentId, userId, { scope: "TEAM", teamId }, input);
}

export async function deleteTeamDocument(workspaceId: string, teamId: string, documentId: string, userId: string) {
  return deleteDocument(workspaceId, documentId, userId, { scope: "TEAM", teamId });
}

export async function listProjectDocuments(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  userId: string,
  projectId: string,
  query: ListDocumentsQuery,
) {
  await assertScopeAccessible(workspaceId, workspaceRole, userId, { scope: "PROJECT", projectId });
  return listDocuments(workspaceId, { scope: "PROJECT", projectId }, query);
}

export async function createProjectDocument(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  projectId: string,
  userId: string,
  input: DocumentDraftInput,
) {
  return createDocument(workspaceId, workspaceRole, userId, { scope: "PROJECT", projectId }, input);
}

export async function updateProjectDocument(workspaceId: string, projectId: string, documentId: string, userId: string, input: UpdateDocumentInput) {
  return updateDocument(workspaceId, documentId, userId, { scope: "PROJECT", projectId }, input);
}

export async function deleteProjectDocument(workspaceId: string, projectId: string, documentId: string, userId: string) {
  return deleteDocument(workspaceId, documentId, userId, { scope: "PROJECT", projectId });
}

// ─── Folder operations ────────────────────────────────────────────────────────

type FolderScopeContext =
  | { scope: "WORKSPACE"; teamId?: undefined; projectId?: undefined }
  | { scope: "TEAM"; teamId: string; projectId?: undefined }
  | { scope: "PROJECT"; projectId: string; teamId?: undefined };

function buildFolderScopeWhere(workspaceId: string, context: FolderScopeContext) {
  switch (context.scope) {
    case "WORKSPACE":
      return { workspaceId, scope: "WORKSPACE" as const, teamId: null, projectId: null };
    case "TEAM":
      return { workspaceId, scope: "TEAM" as const, teamId: context.teamId };
    case "PROJECT":
      return { workspaceId, scope: "PROJECT" as const, projectId: context.projectId };
  }
}

export async function listFolders(
  workspaceId: string,
  context: FolderScopeContext,
  query: ListFoldersQuery,
) {
  const parentId = query.parentId !== undefined ? query.parentId : null;
  const where: any = {
    ...buildFolderScopeWhere(workspaceId, context),
    parentId,
  };

  const folders = await (prisma as any).documentFolder.findMany({
    where,
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      parentId: true,
      createdById: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          children: true,
          documents: true,
        },
      },
    },
  });

  return folders.map((f: any) => ({
    id: f.id,
    name: f.name,
    parentId: f.parentId,
    createdById: f.createdById,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    childCount: f._count.children,
    documentCount: f._count.documents,
  }));
}

export async function createFolder(
  workspaceId: string,
  context: FolderScopeContext,
  input: CreateFolderInput,
  actorId: string,
) {
  const parentId = input.parentId ?? null;

  if (parentId) {
    const parent = await (prisma as any).documentFolder.findFirst({
      where: { id: parentId, workspaceId },
      select: { id: true },
    });
    if (!parent) {
      throw new AppError(404, ERROR_CODES.FOLDER_NOT_FOUND, "Parent folder not found");
    }
  }

  const existing = await (prisma as any).documentFolder.findFirst({
    where: {
      ...buildFolderScopeWhere(workspaceId, context),
      parentId,
      name: input.name,
    },
    select: { id: true },
  });

  if (existing) {
    throw new AppError(409, ERROR_CODES.FOLDER_NAME_CONFLICT, "A folder with this name already exists in the same location");
  }

  const folder = await (prisma as any).documentFolder.create({
    data: {
      workspaceId,
      scope: context.scope as any,
      teamId: context.teamId ?? null,
      projectId: context.projectId ?? null,
      parentId,
      name: input.name,
      createdById: actorId,
    },
    select: {
      id: true,
      name: true,
      parentId: true,
      createdById: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return folder;
}

export async function renameFolder(
  workspaceId: string,
  folderId: string,
  input: RenameFolderInput,
  _actorId: string,
) {
  const folder = await (prisma as any).documentFolder.findFirst({
    where: { id: folderId, workspaceId },
    select: { id: true, parentId: true, scope: true, teamId: true, projectId: true },
  });

  if (!folder) {
    throw new AppError(404, ERROR_CODES.FOLDER_NOT_FOUND, "Folder not found");
  }

  const conflict = await (prisma as any).documentFolder.findFirst({
    where: {
      workspaceId,
      scope: folder.scope,
      parentId: folder.parentId,
      name: input.name,
      id: { not: folderId },
    },
    select: { id: true },
  });

  if (conflict) {
    throw new AppError(409, ERROR_CODES.FOLDER_NAME_CONFLICT, "A folder with this name already exists in the same location");
  }

  const updated = await (prisma as any).documentFolder.update({
    where: { id: folderId },
    data: { name: input.name },
    select: {
      id: true,
      name: true,
      parentId: true,
      createdById: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return updated;
}

export async function deleteFolder(
  workspaceId: string,
  folderId: string,
  _actorId: string,
) {
  const folder = await (prisma as any).documentFolder.findFirst({
    where: { id: folderId, workspaceId },
    select: { id: true },
  });

  if (!folder) {
    throw new AppError(404, ERROR_CODES.FOLDER_NOT_FOUND, "Folder not found");
  }

  await (prisma as any).documentFolder.delete({ where: { id: folderId } });
}

export async function moveFolder(
  workspaceId: string,
  folderId: string,
  input: MoveFolderInput,
  _actorId: string,
) {
  const newParentId = input.parentId;

  const folder = await (prisma as any).documentFolder.findFirst({
    where: { id: folderId, workspaceId },
    select: { id: true, scope: true, parentId: true, name: true, teamId: true, projectId: true },
  });

  if (!folder) {
    throw new AppError(404, ERROR_CODES.FOLDER_NOT_FOUND, "Folder not found");
  }

  if (newParentId === folder.parentId) {
    return folder;
  }

  // Prevent moving a folder into itself
  if (newParentId === folderId) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "Cannot move a folder into itself");
  }

  // Validate new parent exists and check for circular reference
  if (newParentId) {
    const newParent = await (prisma as any).documentFolder.findFirst({
      where: { id: newParentId, workspaceId },
      select: { id: true },
    });

    if (!newParent) {
      throw new AppError(404, ERROR_CODES.FOLDER_NOT_FOUND, "Target parent folder not found");
    }

    // Walk up the ancestor chain to check for cycles
    let currentId: string | null = newParentId;
    while (currentId) {
      if (currentId === folderId) {
        throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "Cannot move a folder into one of its descendants");
      }
      const ancestor: { parentId: string | null } | null = await (prisma as any).documentFolder.findFirst({
        where: { id: currentId, workspaceId },
        select: { parentId: true },
      });
      currentId = ancestor?.parentId ?? null;
    }
  }

  // Check name uniqueness in target
  const conflict = await (prisma as any).documentFolder.findFirst({
    where: {
      workspaceId,
      scope: folder.scope,
      parentId: newParentId,
      name: folder.name,
      id: { not: folderId },
    },
    select: { id: true },
  });

  if (conflict) {
    throw new AppError(409, ERROR_CODES.FOLDER_NAME_CONFLICT, "A folder with this name already exists in the target location");
  }

  const updated = await (prisma as any).documentFolder.update({
    where: { id: folderId },
    data: { parentId: newParentId },
    select: {
      id: true,
      name: true,
      parentId: true,
      createdById: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return updated;
}

export async function moveDocument(
  workspaceId: string,
  documentId: string,
  input: MoveDocumentInput,
  _actorId: string,
) {
  const document = await prisma.entityDocument.findFirst({
    where: { id: documentId, workspaceId },
    select: { id: true, folderId: true },
  });

  if (!document) {
    throw new AppError(404, ERROR_CODES.DOCUMENT_NOT_FOUND, "Document not found");
  }

  if (input.folderId) {
    const folder = await (prisma as any).documentFolder.findFirst({
      where: { id: input.folderId, workspaceId },
      select: { id: true },
    });

    if (!folder) {
      throw new AppError(404, ERROR_CODES.FOLDER_NOT_FOUND, "Target folder not found");
    }
  }

  const updated = await (prisma as any).entityDocument.update({
    where: { id: documentId },
    data: { folderId: input.folderId },
    select: documentSelect,
  });

  return mapDocument(updated);
}

export async function getFolderBreadcrumbs(
  workspaceId: string,
  folderId: string,
) {
  const breadcrumbs: { id: string; name: string }[] = [];
  let currentId: string | null = folderId;

  while (currentId) {
    const folder: { id: string; name: string; parentId: string | null } | null = await (prisma as any).documentFolder.findFirst({
      where: { id: currentId, workspaceId },
      select: { id: true, name: true, parentId: true },
    });

    if (!folder) {
      throw new AppError(404, ERROR_CODES.FOLDER_NOT_FOUND, "Folder not found");
    }

    breadcrumbs.unshift({ id: folder.id, name: folder.name });
    currentId = folder.parentId;
  }

  return breadcrumbs;
}

// ─── Scoped folder exports ────────────────────────────────────────────────────

export async function listWorkspaceFolders(workspaceId: string, query: ListFoldersQuery) {
  return listFolders(workspaceId, { scope: "WORKSPACE" }, query);
}

export async function createWorkspaceFolder(workspaceId: string, input: CreateFolderInput, actorId: string) {
  return createFolder(workspaceId, { scope: "WORKSPACE" }, input, actorId);
}

export async function renameWorkspaceFolder(workspaceId: string, folderId: string, input: RenameFolderInput, actorId: string) {
  return renameFolder(workspaceId, folderId, input, actorId);
}

export async function deleteWorkspaceFolder(workspaceId: string, folderId: string, actorId: string) {
  return deleteFolder(workspaceId, folderId, actorId);
}

export async function moveWorkspaceFolder(workspaceId: string, folderId: string, input: MoveFolderInput, actorId: string) {
  return moveFolder(workspaceId, folderId, input, actorId);
}

export async function moveWorkspaceDocument(workspaceId: string, documentId: string, input: MoveDocumentInput, actorId: string) {
  return moveDocument(workspaceId, documentId, input, actorId);
}

export async function getWorkspaceFolderBreadcrumbs(workspaceId: string, folderId: string) {
  return getFolderBreadcrumbs(workspaceId, folderId);
}

export async function listTeamFolders(workspaceId: string, workspaceRole: WorkspaceRole, userId: string, teamId: string, query: ListFoldersQuery) {
  await assertScopeAccessible(workspaceId, workspaceRole, userId, { scope: "TEAM", teamId });
  return listFolders(workspaceId, { scope: "TEAM", teamId }, query);
}

export async function createTeamFolder(workspaceId: string, teamId: string, input: CreateFolderInput, actorId: string) {
  await assertScopeExists(workspaceId, { scope: "TEAM", teamId });
  return createFolder(workspaceId, { scope: "TEAM", teamId }, input, actorId);
}

export async function renameTeamFolder(workspaceId: string, _teamId: string, folderId: string, input: RenameFolderInput, actorId: string) {
  return renameFolder(workspaceId, folderId, input, actorId);
}

export async function deleteTeamFolder(workspaceId: string, _teamId: string, folderId: string, actorId: string) {
  return deleteFolder(workspaceId, folderId, actorId);
}

export async function moveTeamFolder(workspaceId: string, _teamId: string, folderId: string, input: MoveFolderInput, actorId: string) {
  return moveFolder(workspaceId, folderId, input, actorId);
}

export async function moveTeamDocument(workspaceId: string, _teamId: string, documentId: string, input: MoveDocumentInput, actorId: string) {
  return moveDocument(workspaceId, documentId, input, actorId);
}

export async function getTeamFolderBreadcrumbs(workspaceId: string, workspaceRole: WorkspaceRole, userId: string, teamId: string, folderId: string) {
  await assertScopeAccessible(workspaceId, workspaceRole, userId, { scope: "TEAM", teamId });
  return getFolderBreadcrumbs(workspaceId, folderId);
}

export async function listProjectFolders(workspaceId: string, workspaceRole: WorkspaceRole, userId: string, projectId: string, query: ListFoldersQuery) {
  await assertScopeAccessible(workspaceId, workspaceRole, userId, { scope: "PROJECT", projectId });
  return listFolders(workspaceId, { scope: "PROJECT", projectId }, query);
}

export async function createProjectFolder(workspaceId: string, projectId: string, input: CreateFolderInput, actorId: string) {
  await assertScopeExists(workspaceId, { scope: "PROJECT", projectId });
  return createFolder(workspaceId, { scope: "PROJECT", projectId }, input, actorId);
}

export async function renameProjectFolder(workspaceId: string, _projectId: string, folderId: string, input: RenameFolderInput, actorId: string) {
  return renameFolder(workspaceId, folderId, input, actorId);
}

export async function deleteProjectFolder(workspaceId: string, _projectId: string, folderId: string, actorId: string) {
  return deleteFolder(workspaceId, folderId, actorId);
}

export async function moveProjectFolder(workspaceId: string, _projectId: string, folderId: string, input: MoveFolderInput, actorId: string) {
  return moveFolder(workspaceId, folderId, input, actorId);
}

export async function moveProjectDocument(workspaceId: string, _projectId: string, documentId: string, input: MoveDocumentInput, actorId: string) {
  return moveDocument(workspaceId, documentId, input, actorId);
}

export async function getProjectFolderBreadcrumbs(workspaceId: string, workspaceRole: WorkspaceRole, userId: string, projectId: string, folderId: string) {
  await assertScopeAccessible(workspaceId, workspaceRole, userId, { scope: "PROJECT", projectId });
  return getFolderBreadcrumbs(workspaceId, folderId);
}
