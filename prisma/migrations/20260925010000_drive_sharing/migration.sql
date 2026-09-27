-- CreateEnum
CREATE TYPE "DriveSharing" AS ENUM ('PRIVATE', 'COMPANY', 'PUBLIC');

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "allowPublicDriveLinks" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "DriveUpload" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "driveFileId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "webViewLink" TEXT NOT NULL,
    "sharing" "DriveSharing" NOT NULL DEFAULT 'PRIVATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriveUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DriveUpload_driveFileId_key" ON "DriveUpload"("driveFileId");

-- CreateIndex
CREATE INDEX "DriveUpload_workspaceId_sharing_idx" ON "DriveUpload"("workspaceId", "sharing");

-- CreateIndex
CREATE INDEX "DriveUpload_uploaderId_idx" ON "DriveUpload"("uploaderId");

-- AddForeignKey
ALTER TABLE "DriveUpload" ADD CONSTRAINT "DriveUpload_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriveUpload" ADD CONSTRAINT "DriveUpload_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: Drive files attached before this change. The old upload always
-- tried to make them "anyone with the link", so record them as PUBLIC; their
-- uploaders can now tighten them from Settings.
INSERT INTO "DriveUpload" ("id", "workspaceId", "uploaderId", "driveFileId", "fileName", "mimeType", "sizeBytes", "webViewLink", "sharing", "updatedAt")
SELECT DISTINCT ON (a."key")
  gen_random_uuid()::text, a."workspaceId", a."createdById", a."key", a."fileName", a."contentType", a."size", a."assetUrl", 'PUBLIC', CURRENT_TIMESTAMP
FROM (
  SELECT "workspaceId", "createdById", "key", "fileName", "contentType", "size", "assetUrl", "createdAt" FROM "IssueAttachment"
  UNION ALL
  SELECT "workspaceId", "createdById", "key", "fileName", "contentType", "size", "assetUrl", "createdAt" FROM "CommentAttachment"
) a
WHERE a."assetUrl" LIKE 'https://drive.google.com/%' AND a."key" ~ '^[A-Za-z0-9_-]+$'
ORDER BY a."key", a."createdAt"
ON CONFLICT ("driveFileId") DO NOTHING;
