-- Phase 9: notifications contract alignment

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'COMMENT_REPLY';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PROJECT_MEMBER';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TEAM_MEMBER';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WORKSPACE_INVITE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ISSUE_DUE_SOON';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ISSUE_OVERDUE';

ALTER TABLE "Notification" RENAME COLUMN "userId" TO "recipientUserId";
ALTER TABLE "Notification" RENAME COLUMN "actorId" TO "actorUserId";
ALTER TABLE "Notification" RENAME COLUMN "description" TO "message";

ALTER TABLE "Notification"
  ADD COLUMN "category" TEXT,
  ADD COLUMN "title" TEXT,
  ADD COLUMN "targetType" TEXT,
  ADD COLUMN "targetId" TEXT,
  ADD COLUMN "targetPublicId" TEXT,
  ADD COLUMN "targetUrl" TEXT,
  ADD COLUMN "metadata" JSONB,
  ADD COLUMN "readAt" TIMESTAMP(3),
  ADD COLUMN "eventId" TEXT,
  ADD COLUMN "dedupeKey" TEXT;

UPDATE "Notification"
SET
  "category" = CASE "type"
    WHEN 'MENTION' THEN 'mention'
    WHEN 'ASSIGNMENT' THEN 'assignment'
    ELSE 'update'
  END,
  "title" = CASE "type"
    WHEN 'MENTION' THEN 'Mentioned in a comment'
    WHEN 'ASSIGNMENT' THEN 'Issue assigned'
    ELSE 'Issue updated'
  END,
  "targetType" = 'issue',
  "targetId" = COALESCE("issueId", "id"),
  "targetUrl" = CASE WHEN "issueId" IS NOT NULL THEN '/issues/' || "issueId" ELSE '/notifications' END,
  "readAt" = CASE WHEN "read" = true THEN "createdAt" ELSE NULL END;

ALTER TABLE "Notification"
  ALTER COLUMN "actorUserId" DROP NOT NULL,
  ALTER COLUMN "category" SET NOT NULL,
  ALTER COLUMN "title" SET NOT NULL,
  ALTER COLUMN "targetType" SET NOT NULL,
  ALTER COLUMN "targetId" SET NOT NULL,
  ALTER COLUMN "targetUrl" SET NOT NULL;

DROP INDEX IF EXISTS "Notification_userId_read_idx";
DROP INDEX IF EXISTS "Notification_workspaceId_idx";

CREATE INDEX "Notification_workspaceId_recipientUserId_createdAt_idx"
  ON "Notification"("workspaceId", "recipientUserId", "createdAt" DESC);

CREATE INDEX "Notification_workspaceId_recipientUserId_readAt_createdAt_idx"
  ON "Notification"("workspaceId", "recipientUserId", "readAt", "createdAt" DESC);

CREATE INDEX "Notification_workspaceId_recipientUserId_type_createdAt_idx"
  ON "Notification"("workspaceId", "recipientUserId", "type", "createdAt" DESC);

CREATE UNIQUE INDEX "Notification_workspaceId_recipientUserId_dedupeKey_key"
  ON "Notification"("workspaceId", "recipientUserId", "dedupeKey");

ALTER TABLE "Notification"
  DROP COLUMN "issueId",
  DROP COLUMN "read";
