-- AlterEnum
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'LABEL_CREATED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'LABEL_UPDATED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'LABEL_DELETED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ISSUE_LABEL_ADDED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ISSUE_LABEL_REMOVED';

-- AlterTable
ALTER TABLE "Label"
  ADD COLUMN "normalizedName" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill normalizedName from current name values
UPDATE "Label"
SET "normalizedName" = lower(trim(regexp_replace("name", '\\s+', ' ', 'g')))
WHERE "normalizedName" IS NULL;

-- Make normalizedName required after backfill
ALTER TABLE "Label"
  ALTER COLUMN "normalizedName" SET NOT NULL;

-- Replace old uniqueness with normalized uniqueness
DROP INDEX IF EXISTS "Label_workspaceId_name_key";
CREATE UNIQUE INDEX "Label_workspaceId_normalizedName_key" ON "Label"("workspaceId", "normalizedName");

-- Performance index for label admin/picker lists
CREATE INDEX "Label_workspaceId_createdAt_idx" ON "Label"("workspaceId", "createdAt");
