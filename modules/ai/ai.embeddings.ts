import { createHash } from "node:crypto";

import { prisma } from "../../shared/utils/prisma.js";
import { createEmbedding } from "./ai.provider.js";
import { recordAiDailyUsage } from "./ai.usage.js";

const EMBEDDING_SIMILARITY_THRESHOLD = 0.85;
type SupportedEmbeddingEntityType =
  | "ISSUE"
  | "COMMENT"
  | "DOCUMENT"
  | "PROJECT"
  | "TEAM"
  | "DEPARTMENT"
  | "MEMBER"
  | "CYCLE";

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function buildIssueEmbeddingContent(input: { title: string; description?: string | null | undefined }) {
  return normalizeWhitespace(
    [
      input.title,
      input.description ?? "",
    ].filter(Boolean).join("\n\n"),
  ).slice(0, 12_000);
}

export function hashEmbeddingContent(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function vectorLiteral(embedding: number[]) {
  return `[${embedding.map((value) => Number.isFinite(value) ? value : 0).join(",")}]`;
}


async function generateAndStoreEmbedding(input: {
  workspaceId: string;
  entityType: SupportedEmbeddingEntityType;
  entityId: string;
  content: string;
  triggeredByUserId?: string | undefined;
}) {
  if (!input.content) {
    return null;
  }

  const contentHash = hashEmbeddingContent(input.content);

  const existing = await prisma.$queryRawUnsafe<Array<{ "contentHash": string }>>(
    `SELECT "contentHash" FROM "AiEmbedding"
     WHERE "workspaceId" = $1 AND "entityType" = $2::"AiEmbeddingEntityType" AND "entityId" = $3
     LIMIT 1`,
    input.workspaceId,
    input.entityType,
    input.entityId,
  ).catch(() => []);

  if (existing[0]?.contentHash === contentHash) {
    return { model: null, contentHash, usage: null };
  }

  const result = await createEmbedding(input.content);

  await prisma.$executeRawUnsafe(
    `INSERT INTO "AiEmbedding" ("id", "workspaceId", "entityType", "entityId", "contentHash", "content", "embedding", "model", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2::"AiEmbeddingEntityType", $3, $4, $5, $6::vector, $7, NOW(), NOW())
     ON CONFLICT ("workspaceId", "entityType", "entityId")
     DO UPDATE SET
       "contentHash" = EXCLUDED."contentHash",
       "content" = EXCLUDED."content",
       "embedding" = EXCLUDED."embedding",
       "model" = EXCLUDED."model",
       "updatedAt" = NOW()`,
    input.workspaceId,
    input.entityType,
    input.entityId,
    contentHash,
    input.content,
    vectorLiteral(result.embedding),
    result.model,
  );

  if (result.usage.totalTokens > 0) {
    await recordAiDailyUsage(prisma, {
      workspaceId: input.workspaceId,
      userId: input.triggeredByUserId,
      feature: "chat",
      inputTokens: result.usage.inputTokens,
      outputTokens: 0,
      requestCountIncrement: 0,
      chatTurnCountIncrement: 0,
    });
  }

  return { model: result.model, contentHash, usage: result.usage, embedding: result.embedding };
}

/**
 * Stores an embedding for content the caller has already rendered.
 *
 * Exists so the queue worker and the backfill job can both go through
 * ai.embedding-content.ts rather than each deciding for themselves what text
 * represents an entity — two vectors built from differently-shaped text are not
 * comparable, which corrupts similarity in ways that are very hard to notice.
 *
 * Returns null when there is nothing to embed. When the content hash is
 * unchanged the stored vector is left alone and no provider call is made.
 */
export async function storeEntityEmbedding(input: {
  workspaceId: string;
  entityType: SupportedEmbeddingEntityType;
  entityId: string;
  content: string;
  triggeredByUserId?: string | undefined;
}) {
  return generateAndStoreEmbedding(input);
}

export async function generateAndStoreIssueEmbedding(input: {
  workspaceId: string;
  issueId: string;
  title: string;
  description?: string | null | undefined;
  triggeredByUserId?: string | undefined;
}) {
  const content = buildIssueEmbeddingContent({ title: input.title, description: input.description });
  return generateAndStoreEmbedding({
    workspaceId: input.workspaceId,
    entityType: "ISSUE",
    entityId: input.issueId,
    content,
    triggeredByUserId: input.triggeredByUserId,
  });
}

export async function findSimilarIssueEmbeddings(input: {
  workspaceId: string;
  issueId: string;
  embedding: number[];
  limit?: number;
}) {
  const rows = await prisma.$queryRawUnsafe<Array<{
    entityId: string;
    similarity: number;
  }>>(
    `SELECT "entityId", 1 - ("embedding" <=> $1::vector) AS similarity
     FROM "AiEmbedding"
     WHERE "workspaceId" = $2
       AND "entityType" = 'ISSUE'
       AND "entityId" <> $3
     ORDER BY "embedding" <=> $1::vector
     LIMIT $4`,
    vectorLiteral(input.embedding),
    input.workspaceId,
    input.issueId,
    input.limit ?? 5,
  ).catch(() => []);

  return rows.filter((row) => row.similarity >= EMBEDDING_SIMILARITY_THRESHOLD);
}

function tokenize(value: string) {
  return [...new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  )];
}

function jaccardSimilarity(a: string[], b: string[]) {
  if (a.length === 0 || b.length === 0) return 0;
  const aSet = new Set(a);
  const bSet = new Set(b);
  const intersection = [...aSet].filter((item) => bSet.has(item)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

export async function findSimilarIssuesByText(input: {
  workspaceId: string;
  issueId: string;
  title: string;
  description?: string | null | undefined;
  limit?: number | undefined;
}) {
  const baselineTokens = tokenize(`${input.title} ${input.description ?? ""}`);
  if (baselineTokens.length === 0) return [];

  const candidates = await prisma.issue.findMany({
    where: {
      workspaceId: input.workspaceId,
      id: { not: input.issueId },
    },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
    take: 75,
  });

  return candidates
    .map((candidate) => {
      const score = jaccardSimilarity(
        baselineTokens,
        tokenize(`${candidate.title} ${candidate.description ?? ""}`),
      );

      return {
        issueId: candidate.id,
        title: candidate.title,
        status: candidate.status,
        priority: candidate.priority,
        similarity: Number(score.toFixed(4)),
      };
    })
    .filter((candidate) => candidate.similarity >= 0.35)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, input.limit ?? 3);
}
