ALTER TABLE "AiToolExecution"
ADD COLUMN "windowKey" TEXT,
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'STARTED',
ADD COLUMN "errorMessage" TEXT,
ADD COLUMN "completedAt" TIMESTAMP(3);

UPDATE "AiToolExecution"
SET "windowKey" = CONCAT('legacy:', FLOOR(EXTRACT(EPOCH FROM "createdAt") / 600)::TEXT)
WHERE "windowKey" IS NULL;

DELETE FROM "AiToolExecution" stale
USING (
  SELECT "id"
  FROM (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        PARTITION BY "workspaceId", "fingerprint", "windowKey"
        ORDER BY "createdAt" ASC, "id" ASC
      ) AS row_num
    FROM "AiToolExecution"
  ) ranked
  WHERE ranked.row_num > 1
) duplicates
WHERE stale."id" = duplicates."id";

ALTER TABLE "AiToolExecution"
ALTER COLUMN "windowKey" SET NOT NULL,
ALTER COLUMN "result" DROP NOT NULL;

CREATE UNIQUE INDEX "AiToolExecution_workspaceId_fingerprint_windowKey_key"
ON "AiToolExecution"("workspaceId", "fingerprint", "windowKey");
