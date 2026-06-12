ALTER TABLE "Issue" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

UPDATE "Issue"
SET "completedAt" = "updatedAt"
WHERE "status" = 'DONE'
  AND "completedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Issue_workspaceId_completedAt_idx"
ON "Issue"("workspaceId", "completedAt");
