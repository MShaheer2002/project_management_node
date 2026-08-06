/**
 * Embedding content builders — Phase 20L
 *
 * One place that answers "what text represents this entity for semantic search".
 *
 * This exists as its own module because three separate callers need the same
 * answer: the queue worker (on create/update), the backfill job (for existing
 * rows), and any future re-index. When that logic lived inline in the worker,
 * nothing stopped a backfill from embedding subtly different text than the
 * worker would — which silently poisons similarity, because two vectors built
 * from differently-shaped text are not comparable even for the same entity.
 *
 * Content design notes:
 *   - Context matters more than completeness. A bare comment ("agreed, let's
 *     ship it") is useless in isolation; prefixed with its issue title it
 *     becomes findable.
 *   - Structural labels ("PROJECT: Ridely") help the model distinguish entity
 *     kinds when results from several types are merged.
 *   - Everything is whitespace-normalized and length-capped so one enormous
 *     description cannot dominate a workspace's embedding spend.
 */

import { createHash } from "node:crypto";

import { prisma } from "../../shared/utils/prisma.js";

/** Every entity type the platform can embed. Mirrors AiEmbeddingEntityType. */
export const INDEXABLE_ENTITY_TYPES = [
  "ISSUE",
  "COMMENT",
  "DOCUMENT",
  "PROJECT",
  "TEAM",
  "DEPARTMENT",
  "MEMBER",
  "CYCLE",
] as const;

export type IndexableEntityType = (typeof INDEXABLE_ENTITY_TYPES)[number];

export function isIndexableEntityType(value: string): value is IndexableEntityType {
  return (INDEXABLE_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * Upper bound on embedded text. `text-embedding-3-small` accepts ~8k tokens;
 * this sits comfortably under that while keeping cost predictable for outlier
 * descriptions.
 */
const MAX_CONTENT_LENGTH = 12_000;

export interface EmbeddingContent {
  /** Text to embed. */
  content: string;
  /** Human-readable label, stored alongside so search results are renderable without a second query. */
  label: string;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function hashEmbeddingContent(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compose(parts: Array<string | null | undefined>): string {
  return normalizeWhitespace(
    parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join("\n\n"),
  ).slice(0, MAX_CONTENT_LENGTH);
}

/**
 * Loads an entity and renders its embedding text.
 *
 * Returns null when the entity no longer exists or has nothing worth embedding.
 * Callers treat null as "skip", never as an error — entities are routinely
 * deleted between a job being enqueued and processed.
 */
export async function buildEmbeddingContent(
  entityType: IndexableEntityType,
  entityId: string,
  workspaceId: string,
): Promise<EmbeddingContent | null> {
  switch (entityType) {
    case "ISSUE":
      return buildIssueContent(entityId, workspaceId);
    case "COMMENT":
      return buildCommentContent(entityId, workspaceId);
    case "DOCUMENT":
      return buildDocumentContent(entityId, workspaceId);
    case "PROJECT":
      return buildProjectContent(entityId, workspaceId);
    case "TEAM":
      return buildTeamContent(entityId, workspaceId);
    case "DEPARTMENT":
      return buildDepartmentContent(entityId, workspaceId);
    case "MEMBER":
      return buildMemberContent(entityId, workspaceId);
    case "CYCLE":
      return buildCycleContent(entityId, workspaceId);
    default:
      return null;
  }
}

// ─── Per-entity builders ────────────────────────────────────────────────────

async function buildIssueContent(issueId: string, workspaceId: string): Promise<EmbeddingContent | null> {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: {
      id: true,
      title: true,
      description: true,
      type: true,
      project: { select: { name: true } },
      labels: { select: { label: { select: { name: true } } }, take: 10 },
    },
  });
  if (!issue) return null;

  const labels = issue.labels.map((entry) => entry.label.name).filter(Boolean);

  return {
    // Project and labels are included because they carry real search signal:
    // "the auth bug in Ridely" should match on both the topic and the project.
    content: compose([
      `${issue.type} ${issue.id}: ${issue.title}`,
      issue.description,
      issue.project?.name ? `Project: ${issue.project.name}` : null,
      labels.length > 0 ? `Labels: ${labels.join(", ")}` : null,
    ]),
    label: `${issue.id} — ${issue.title}`,
  };
}

async function buildCommentContent(commentId: string, workspaceId: string): Promise<EmbeddingContent | null> {
  // Comment has no workspaceId of its own; scope is enforced through its issue.
  const comment = await prisma.comment.findFirst({
    where: { id: commentId, issue: { workspaceId } },
    select: {
      id: true,
      body: true,
      author: { select: { name: true } },
      issue: { select: { id: true, title: true } },
    },
  });
  if (!comment?.body?.trim()) return null;

  return {
    // Without the issue title a short comment is unsearchable — "yes, agreed"
    // carries no topic of its own.
    content: compose([
      `Comment on ${comment.issue.id}: ${comment.issue.title}`,
      comment.author?.name ? `By ${comment.author.name}` : null,
      comment.body,
    ]),
    label: `Comment on ${comment.issue.id}`,
  };
}

async function buildDocumentContent(documentId: string, workspaceId: string): Promise<EmbeddingContent | null> {
  const document = await prisma.entityDocument.findFirst({
    where: { id: documentId, workspaceId },
    select: {
      id: true,
      name: true,
      description: true,
      fileName: true,
      mimeType: true,
      project: { select: { name: true } },
      team: { select: { name: true } },
    },
  });
  if (!document) return null;

  // EntityDocument is a file reference, not rich text — the bytes live in
  // object storage. Only its metadata is embeddable here. Extracting text from
  // the file itself would need a parsing pipeline per mime type and belongs in
  // a separate piece of work.
  return {
    content: compose([
      `Document: ${document.name}`,
      document.description,
      document.fileName !== document.name ? `File: ${document.fileName}` : null,
      document.project?.name ? `Project: ${document.project.name}` : null,
      document.team?.name ? `Team: ${document.team.name}` : null,
    ]),
    label: document.name,
  };
}

async function buildProjectContent(projectId: string, workspaceId: string): Promise<EmbeddingContent | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId },
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      team: { select: { name: true } },
    },
  });
  if (!project) return null;

  return {
    content: compose([
      `Project: ${project.name}`,
      project.description,
      project.team?.name ? `Owned by team ${project.team.name}` : null,
      `Status: ${project.status}`,
    ]),
    label: project.name,
  };
}

async function buildTeamContent(teamId: string, workspaceId: string): Promise<EmbeddingContent | null> {
  const team = await prisma.team.findFirst({
    where: { id: teamId, workspaceId },
    select: {
      id: true,
      name: true,
      description: true,
      department: { select: { name: true } },
      lead: { select: { name: true } },
    },
  });
  if (!team) return null;

  return {
    content: compose([
      `Team: ${team.name}`,
      team.description,
      team.lead?.name ? `Led by ${team.lead.name}` : null,
      team.department?.name ? `Department: ${team.department.name}` : null,
    ]),
    label: team.name,
  };
}

async function buildDepartmentContent(
  departmentId: string,
  workspaceId: string,
): Promise<EmbeddingContent | null> {
  const department = await prisma.department.findFirst({
    where: { id: departmentId, workspaceId },
    select: {
      id: true,
      name: true,
      description: true,
      head: { select: { name: true } },
      teams: { select: { name: true }, take: 20 },
    },
  });
  if (!department) return null;

  const teams = department.teams.map((team) => team.name).filter(Boolean);

  return {
    content: compose([
      `Department: ${department.name}`,
      department.description,
      department.head?.name ? `Headed by ${department.head.name}` : null,
      teams.length > 0 ? `Teams: ${teams.join(", ")}` : null,
    ]),
    label: department.name,
  };
}

async function buildMemberContent(userId: string, workspaceId: string): Promise<EmbeddingContent | null> {
  const membership = await prisma.workspaceMembership.findFirst({
    where: { userId, workspaceId },
    select: {
      role: true,
      designation: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });
  if (!membership?.user) return null;

  const [teams, departments] = await Promise.all([
    prisma.teamMembership.findMany({
      where: { userId, team: { workspaceId } },
      select: { team: { select: { name: true } } },
      orderBy: { teamId: "asc" },
      take: 20,
    }),
    prisma.departmentMembership.findMany({
      where: { userId, department: { workspaceId } },
      select: { department: { select: { name: true } } },
      orderBy: { departmentId: "asc" },
      take: 20,
    }),
  ]);

  const teamNames = teams.map((entry) => entry.team?.name).filter(Boolean);
  const departmentNames = departments.map((entry) => entry.department?.name).filter(Boolean);

  return {
    // Designation and team membership are what make "who works on frontend"
    // resolvable without an exact name match.
    content: compose([
      `Person: ${membership.user.name}`,
      membership.designation,
      `Role: ${membership.role}`,
      teamNames.length > 0 ? `Teams: ${teamNames.join(", ")}` : null,
      departmentNames.length > 0 ? `Departments: ${departmentNames.join(", ")}` : null,
    ]),
    label: membership.user.name,
  };
}

async function buildCycleContent(cycleId: string, workspaceId: string): Promise<EmbeddingContent | null> {
  const cycle = await prisma.cycle.findFirst({
    where: { id: cycleId, workspaceId },
    select: {
      id: true,
      name: true,
      description: true,
      goal: true,
      team: { select: { name: true } },
    },
  });
  if (!cycle) return null;

  return {
    content: compose([
      `Cycle: ${cycle.name}`,
      cycle.goal ? `Goal: ${cycle.goal}` : null,
      cycle.description,
      cycle.team?.name ? `Team: ${cycle.team.name}` : null,
    ]),
    label: cycle.name,
  };
}
