-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "storageUsedBytes" BIGINT NOT NULL DEFAULT 0;

-- Backfill: calculate current storage usage from existing attachments
UPDATE "Subscription" s
SET "storageUsedBytes" = COALESCE(
  (SELECT SUM(ia.size) FROM "IssueAttachment" ia WHERE ia."workspaceId" = s."workspaceId"), 0
) + COALESCE(
  (SELECT SUM(ca.size) FROM "CommentAttachment" ca WHERE ca."workspaceId" = s."workspaceId"), 0
);
