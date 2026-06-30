ALTER TYPE "AiEmbeddingEntityType" ADD VALUE IF NOT EXISTS 'PROJECT';
ALTER TYPE "AiEmbeddingEntityType" ADD VALUE IF NOT EXISTS 'TEAM';
ALTER TYPE "AiEmbeddingEntityType" ADD VALUE IF NOT EXISTS 'DEPARTMENT';
ALTER TYPE "AiEmbeddingEntityType" ADD VALUE IF NOT EXISTS 'MEMBER';
ALTER TYPE "AiEmbeddingEntityType" ADD VALUE IF NOT EXISTS 'CYCLE';

CREATE TYPE "EntityAliasType" AS ENUM ('PROJECT', 'TEAM', 'DEPARTMENT', 'MEMBER', 'CYCLE');

CREATE TABLE "EntityAlias" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "entityType" "EntityAliasType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "locale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EntityAlias_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EntityAlias_workspaceId_entityType_idx" ON "EntityAlias"("workspaceId", "entityType");
CREATE INDEX "EntityAlias_workspaceId_entityType_normalized_idx" ON "EntityAlias"("workspaceId", "entityType", "normalized");
CREATE INDEX "EntityAlias_workspaceId_entityType_entityId_idx" ON "EntityAlias"("workspaceId", "entityType", "entityId");
CREATE UNIQUE INDEX "EntityAlias_workspaceId_entityType_entityId_normalized_key" ON "EntityAlias"("workspaceId", "entityType", "entityId", "normalized");

ALTER TABLE "EntityAlias"
ADD CONSTRAINT "EntityAlias_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
