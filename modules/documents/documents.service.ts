import type { WorkspaceRole } from "../../app/generated/prisma/client.js";

import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import { logActivity } from "../../shared/utils/activity.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import { prisma } from "../../shared/utils/prisma.js";
import type {
  DocumentDraftInput,
  ListDocumentsQuery,
  UpdateDocumentInput,
} from "./documents.schemas.js";
import { validateDocumentRef } from "./documents.storage.js";

const documentSelect = {
  id: true,
  workspaceId: true,
  scope: true,
  teamId: true,
  projectId: true,
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
  const where: any = {
    ...buildScopeWhere(workspaceId, context),
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

async function createDocument(workspaceId: string, userId: string, context: ScopeContext, input: DocumentDraftInput) {
  const created = await prisma.$transaction(async (tx) => {
    await assertScopeExists(workspaceId, context);
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

export async function createWorkspaceDocument(workspaceId: string, userId: string, input: DocumentDraftInput) {
  return createDocument(workspaceId, userId, { scope: "WORKSPACE" }, input);
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

export async function createTeamDocument(workspaceId: string, teamId: string, userId: string, input: DocumentDraftInput) {
  return createDocument(workspaceId, userId, { scope: "TEAM", teamId }, input);
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

export async function createProjectDocument(workspaceId: string, projectId: string, userId: string, input: DocumentDraftInput) {
  return createDocument(workspaceId, userId, { scope: "PROJECT", projectId }, input);
}

export async function updateProjectDocument(workspaceId: string, projectId: string, documentId: string, userId: string, input: UpdateDocumentInput) {
  return updateDocument(workspaceId, documentId, userId, { scope: "PROJECT", projectId }, input);
}

export async function deleteProjectDocument(workspaceId: string, projectId: string, documentId: string, userId: string) {
  return deleteDocument(workspaceId, documentId, userId, { scope: "PROJECT", projectId });
}
