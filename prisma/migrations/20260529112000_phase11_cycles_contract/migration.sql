-- Phase 11: cycles contract alignment

ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'CYCLE_CREATED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'CYCLE_UPDATED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'CYCLE_COMPLETED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'CYCLE_REOPENED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'CYCLE_DELETED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ISSUE_CYCLE_ASSIGNED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ISSUE_CYCLE_REMOVED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'CYCLE_CARRY_OVER';

ALTER TYPE "ActivityTargetType" ADD VALUE IF NOT EXISTS 'CYCLE';

ALTER TABLE "Cycle" RENAME COLUMN "startDate" TO "startsAt";
ALTER TABLE "Cycle" RENAME COLUMN "endDate" TO "endsAt";

ALTER TABLE "Cycle"
  ADD COLUMN "number" INTEGER,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "goal" TEXT,
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "completedById" TEXT,
  ADD COLUMN "createdById" TEXT;

UPDATE "Cycle" c
SET "number" = seq.rn
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "teamId" ORDER BY "createdAt" ASC) AS rn
  FROM "Cycle"
) seq
WHERE c."id" = seq."id";

DELETE FROM "Cycle" WHERE "teamId" IS NULL;

UPDATE "Cycle" SET "createdById" = (
  SELECT "createdById" FROM "Workspace" w WHERE w."id" = "Cycle"."workspaceId"
);

ALTER TABLE "Cycle"
  ALTER COLUMN "teamId" SET NOT NULL,
  ALTER COLUMN "number" SET NOT NULL,
  ALTER COLUMN "createdById" SET NOT NULL;

DROP INDEX IF EXISTS "Cycle_workspaceId_idx";
DROP INDEX IF EXISTS "Cycle_teamId_idx";
DROP INDEX IF EXISTS "Cycle_status_idx";

CREATE UNIQUE INDEX "Cycle_teamId_number_key" ON "Cycle"("teamId", "number");
CREATE INDEX "Cycle_workspaceId_teamId_status_idx" ON "Cycle"("workspaceId", "teamId", "status");
CREATE INDEX "Cycle_workspaceId_startsAt_endsAt_idx" ON "Cycle"("workspaceId", "startsAt", "endsAt");
