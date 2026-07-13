CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "AiSuggestionType" AS ENUM ('ASSIGNEE', 'DUPLICATE', 'LABEL', 'PRIORITY', 'STALE_ISSUE', 'WEEKLY_DIGEST', 'SPRINT_PLANNING');

-- CreateEnum
CREATE TYPE "AiSuggestionStatus" AS ENUM ('OPEN', 'ACCEPTED', 'DISMISSED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "AiSuggestionSource" AS ENUM ('RULE', 'EMBEDDING', 'AI_MODEL', 'SQL', 'TEMPLATE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AiEmbeddingEntityType" AS ENUM ('ISSUE', 'COMMENT', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "AiJobRunStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "AiSuggestion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "AiSuggestionType" NOT NULL,
    "status" "AiSuggestionStatus" NOT NULL DEFAULT 'OPEN',
    "source" "AiSuggestionSource" NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "reason" TEXT,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "acceptedById" TEXT,
    "dismissedById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiEmbedding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "entityType" "AiEmbeddingEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiJobRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "jobName" TEXT NOT NULL,
    "jobId" TEXT,
    "status" "AiJobRunStatus" NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "metadata" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AiJobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiSuggestion_workspaceId_dedupeKey_key" ON "AiSuggestion"("workspaceId", "dedupeKey");
CREATE INDEX "AiSuggestion_workspaceId_status_type_idx" ON "AiSuggestion"("workspaceId", "status", "type");
CREATE INDEX "AiSuggestion_workspaceId_targetType_targetId_idx" ON "AiSuggestion"("workspaceId", "targetType", "targetId");
CREATE INDEX "AiSuggestion_workspaceId_createdAt_idx" ON "AiSuggestion"("workspaceId", "createdAt");

CREATE UNIQUE INDEX "AiEmbedding_workspaceId_entityType_entityId_key" ON "AiEmbedding"("workspaceId", "entityType", "entityId");
CREATE INDEX "AiEmbedding_workspaceId_entityType_idx" ON "AiEmbedding"("workspaceId", "entityType");
CREATE INDEX "AiEmbedding_workspaceId_entityId_idx" ON "AiEmbedding"("workspaceId", "entityId");
CREATE INDEX "AiEmbedding_embedding_idx" ON "AiEmbedding" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

CREATE INDEX "AiJobRun_workspaceId_jobName_startedAt_idx" ON "AiJobRun"("workspaceId", "jobName", "startedAt");
CREATE INDEX "AiJobRun_jobName_status_startedAt_idx" ON "AiJobRun"("jobName", "status", "startedAt");

-- AddForeignKey
ALTER TABLE "AiSuggestion" ADD CONSTRAINT "AiSuggestion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiSuggestion" ADD CONSTRAINT "AiSuggestion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiSuggestion" ADD CONSTRAINT "AiSuggestion_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiSuggestion" ADD CONSTRAINT "AiSuggestion_dismissedById_fkey" FOREIGN KEY ("dismissedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AiEmbedding" ADD CONSTRAINT "AiEmbedding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiJobRun" ADD CONSTRAINT "AiJobRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
