-- AlterTable
ALTER TABLE "Issue"
ADD COLUMN "parentIssueId" TEXT,
ADD COLUMN "integrationRef" JSONB;

-- CreateTable
CREATE TABLE "IssueWatcher" (
    "issueId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueWatcher_pkey" PRIMARY KEY ("issueId","userId")
);

-- CreateTable
CREATE TABLE "IssueAttachment" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "assetUrl" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Issue_parentIssueId_idx" ON "Issue"("parentIssueId");

-- CreateIndex
CREATE INDEX "IssueWatcher_userId_idx" ON "IssueWatcher"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "IssueAttachment_issueId_key_key" ON "IssueAttachment"("issueId", "key");

-- CreateIndex
CREATE INDEX "IssueAttachment_issueId_idx" ON "IssueAttachment"("issueId");

-- CreateIndex
CREATE INDEX "IssueAttachment_workspaceId_idx" ON "IssueAttachment"("workspaceId");

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_parentIssueId_fkey" FOREIGN KEY ("parentIssueId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueWatcher" ADD CONSTRAINT "IssueWatcher_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueWatcher" ADD CONSTRAINT "IssueWatcher_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueAttachment" ADD CONSTRAINT "IssueAttachment_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueAttachment" ADD CONSTRAINT "IssueAttachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueAttachment" ADD CONSTRAINT "IssueAttachment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
