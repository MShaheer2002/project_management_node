import type { WorkspaceRole } from "../../app/generated/prisma/client.js";

import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import { prisma } from "../../shared/utils/prisma.js";
import { resolveIssueRouteId } from "../issue/issue.service.js";
import type { ListActivityQuery } from "./activity.schemas.js";

const targetTypeFromDb: Record<string, string> = {
  WORKSPACE: "workspace",
  PROJECT: "project",
  TEAM: "team",
  ISSUE: "issue",
  COMMENT: "comment",
  LABEL: "label",
  MEMBER: "member",
  DEPARTMENT: "team",
  CYCLE: "cycle",
  TEMPLATE: "template",
};

function mapActivity(item: any) {
  const metadata = (item.metadata ?? {}) as Record<string, unknown>;
  const issueId =
    typeof metadata.issuePublicId === "string"
      ? metadata.issuePublicId
      : typeof metadata.issueId === "string"
        ? metadata.issueId
        : item.targetType === "ISSUE"
          ? item.targetId
          : undefined;

  return {
    id: item.id,
    type: item.type,
    message: item.description,
    createdAt: item.createdAt,
    actor: item.actor
      ? {
          id: item.actor.id,
          name: item.actor.name,
          email: item.actor.email,
          avatar: item.actor.avatar,
        }
      : undefined,
    target: {
      type: targetTypeFromDb[item.targetType] ?? "issue",
      id: item.targetId,
      entityId: typeof metadata.entityId === "string" ? metadata.entityId : undefined,
      publicId: typeof metadata.issuePublicId === "string" ? metadata.issuePublicId : issueId,
      name: typeof metadata.entityTitle === "string" ? metadata.entityTitle : undefined,
      url: typeof metadata.url === "string" ? metadata.url : undefined,
    },
    issueId,
    commentId: typeof metadata.commentId === "string" ? metadata.commentId : undefined,
    metadata,
  };
}

async function assertScopeInWorkspace(workspaceId: string, scope: string, scopeId: string) {
  if (scope === "project") {
    const project = await prisma.project.findFirst({ where: { id: scopeId, workspaceId }, select: { id: true } });
    if (!project) throw new AppError(404, ERROR_CODES.NOT_FOUND, "Project not found");
    return;
  }
  if (scope === "team") {
    const team = await prisma.team.findFirst({ where: { id: scopeId, workspaceId }, select: { id: true } });
    if (!team) throw new AppError(404, ERROR_CODES.NOT_FOUND, "Team not found");
    return;
  }
  if (scope === "issue") {
    const issue = await prisma.issue.findFirst({ where: { id: scopeId, workspaceId }, select: { id: true } });
    if (!issue) throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
    return;
  }
  if (scope === "cycle") {
    const cycle = await (prisma as any).cycle.findFirst({ where: { id: scopeId, workspaceId }, select: { id: true } });
    if (!cycle) throw new AppError(404, ERROR_CODES.CYCLE_NOT_FOUND, "Cycle not found");
  }
}

function parseCsv(input: string | undefined): string[] | undefined {
  if (!input) return undefined;
  const values = input.split(",").map((v) => v.trim()).filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

export async function listActivity(workspaceId: string, _workspaceRole: WorkspaceRole, query: ListActivityQuery) {
  const limit = clampListLimit(query.limit, 50);
  const scope = query.scope ?? "workspace";

  if ((scope === "project" || scope === "team" || scope === "issue" || scope === "cycle") && !query.scopeId) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "scopeId is required for project, team, issue, and cycle scopes");
  }

  if (query.scopeId && scope !== "workspace") {
    await assertScopeInWorkspace(workspaceId, scope, query.scopeId);
  }

  const types = parseCsv(query.types);
  const entityTypes = parseCsv(query.entityTypes)?.map((v) => v.toUpperCase());
  const where: any = {
    workspaceId,
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(types ? { type: { in: types as any } } : {}),
    ...(entityTypes ? { targetType: { in: entityTypes as any } } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        }
      : {}),
  };

  if (scope === "issue" && query.scopeId) {
    where.OR = [
      { targetType: "ISSUE", targetId: query.scopeId },
      { metadata: { path: ["entityId"], equals: query.scopeId } },
      { metadata: { path: ["issueId"], equals: query.scopeId } },
    ];
  } else if (scope === "cycle" && query.scopeId) {
    where.OR = [
      { targetType: "CYCLE", targetId: query.scopeId },
      { metadata: { path: ["cycleId"], equals: query.scopeId } },
    ];
  } else if (scope === "project" && query.scopeId) {
    where.OR = [
      { targetType: "PROJECT", targetId: query.scopeId },
      { metadata: { path: ["projectId"], equals: query.scopeId } },
    ];
  } else if (scope === "team" && query.scopeId) {
    where.OR = [
      { targetType: "TEAM", targetId: query.scopeId },
      { metadata: { path: ["teamId"], equals: query.scopeId } },
    ];
  }

  const records = await prisma.activity.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    take: limit + 1,
    include: {
      actor: { select: { id: true, name: true, email: true, avatar: true } },
    },
  });

  const page = slicePage(records, limit);
  return {
    items: page.items.map(mapActivity),
    meta: {
      nextCursor: page.hasMore ? page.items[page.items.length - 1]?.id ?? null : null,
      hasMore: page.hasMore,
    },
  };
}

export async function listIssueActivity(
  workspaceId: string,
  workspaceRole: WorkspaceRole,
  issueIdentifier: string,
  query: { cursor?: string | undefined; limit?: number | undefined },
) {
  const issueId = await resolveIssueRouteId(workspaceId, issueIdentifier);
  return listActivity(workspaceId, workspaceRole, {
    scope: "issue",
    scopeId: issueId,
    cursor: query.cursor,
    limit: query.limit,
  });
}
