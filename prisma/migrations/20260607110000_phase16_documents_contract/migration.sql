-- CreateEnum
CREATE TYPE "DocumentScope" AS ENUM ('WORKSPACE', 'TEAM', 'PROJECT');

-- AlterEnum
ALTER TYPE "ActivityType" ADD VALUE 'DOCUMENT_CREATED';
ALTER TYPE "ActivityType" ADD VALUE 'DOCUMENT_UPDATED';
ALTER TYPE "ActivityType" ADD VALUE 'DOCUMENT_DELETED';

-- AlterEnum
ALTER TYPE "ActivityTargetType" ADD VALUE 'DOCUMENT';

-- CreateTable
CREATE TABLE "EntityDocument" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scope" "DocumentScope" NOT NULL,
    "teamId" TEXT,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "key" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileUrl" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EntityDocument_workspaceId_scope_createdAt_idx" ON "EntityDocument"("workspaceId", "scope", "createdAt");

-- CreateIndex
CREATE INDEX "EntityDocument_teamId_createdAt_idx" ON "EntityDocument"("teamId", "createdAt");

-- CreateIndex
CREATE INDEX "EntityDocument_projectId_createdAt_idx" ON "EntityDocument"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EntityDocument_workspaceId_key_key" ON "EntityDocument"("workspaceId", "key");

-- AddForeignKey
ALTER TABLE "EntityDocument" ADD CONSTRAINT "EntityDocument_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityDocument" ADD CONSTRAINT "EntityDocument_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityDocument" ADD CONSTRAINT "EntityDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityDocument" ADD CONSTRAINT "EntityDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
