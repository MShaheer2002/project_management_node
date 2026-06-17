-- DropIndex
DROP INDEX "EntityDocument_projectId_createdAt_idx";

-- DropIndex
DROP INDEX "EntityDocument_teamId_createdAt_idx";

-- DropIndex
DROP INDEX "EntityDocument_workspaceId_scope_createdAt_idx";

-- AlterTable
ALTER TABLE "EntityDocument" ADD COLUMN     "folderId" TEXT;

-- CreateTable
CREATE TABLE "DocumentFolder" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scope" "DocumentScope" NOT NULL,
    "teamId" TEXT,
    "projectId" TEXT,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentFolder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentFolder_workspaceId_scope_parentId_idx" ON "DocumentFolder"("workspaceId", "scope", "parentId");

-- CreateIndex
CREATE INDEX "DocumentFolder_teamId_parentId_idx" ON "DocumentFolder"("teamId", "parentId");

-- CreateIndex
CREATE INDEX "DocumentFolder_projectId_parentId_idx" ON "DocumentFolder"("projectId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentFolder_workspaceId_scope_parentId_name_key" ON "DocumentFolder"("workspaceId", "scope", "parentId", "name");

-- CreateIndex
CREATE INDEX "EntityDocument_workspaceId_scope_folderId_createdAt_idx" ON "EntityDocument"("workspaceId", "scope", "folderId", "createdAt");

-- CreateIndex
CREATE INDEX "EntityDocument_teamId_folderId_createdAt_idx" ON "EntityDocument"("teamId", "folderId", "createdAt");

-- CreateIndex
CREATE INDEX "EntityDocument_projectId_folderId_createdAt_idx" ON "EntityDocument"("projectId", "folderId", "createdAt");

-- AddForeignKey
ALTER TABLE "DocumentFolder" ADD CONSTRAINT "DocumentFolder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentFolder" ADD CONSTRAINT "DocumentFolder_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentFolder" ADD CONSTRAINT "DocumentFolder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentFolder" ADD CONSTRAINT "DocumentFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DocumentFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentFolder" ADD CONSTRAINT "DocumentFolder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityDocument" ADD CONSTRAINT "EntityDocument_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "DocumentFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
