-- DropIndex
DROP INDEX "AiEmbedding_embedding_idx";

-- AlterTable
ALTER TABLE "AiConnectionSession" ALTER COLUMN "authType" DROP DEFAULT;

-- CreateTable
CREATE TABLE "WorkspaceStatusCount" (
    "workspaceId" TEXT NOT NULL,
    "statusKey" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceStatusCount_pkey" PRIMARY KEY ("workspaceId","statusKey")
);

-- CreateIndex
CREATE INDEX "WorkspaceStatusCount_workspaceId_idx" ON "WorkspaceStatusCount"("workspaceId");

-- AddForeignKey
ALTER TABLE "WorkspaceStatusCount" ADD CONSTRAINT "WorkspaceStatusCount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "AiConnectionSession_aiConnectionId_sessionKey_status_lastActivi" RENAME TO "AiConnectionSession_aiConnectionId_sessionKey_status_lastAc_idx";

-- RenameIndex
ALTER INDEX "AiConnectionSession_aiConnectionId_transport_client_lastActivit" RENAME TO "AiConnectionSession_aiConnectionId_transport_client_lastAct_idx";

-- RenameIndex
ALTER INDEX "AiMetricCounterDaily_workspaceId_feature_metric_bucketDate_dime" RENAME TO "AiMetricCounterDaily_workspaceId_feature_metric_bucketDate__key";

-- RenameIndex
ALTER INDEX "AiResolverSnapshot_workspaceId_requestedEntityType_resolutionSt" RENAME TO "AiResolverSnapshot_workspaceId_requestedEntityType_resoluti_idx";

-- Backfill: seed WorkspaceStatusCount from every issue that already exists, so counts
-- are correct from the moment the trigger below goes live (not just for future writes).
INSERT INTO "WorkspaceStatusCount" ("workspaceId", "statusKey", "count", "updatedAt")
SELECT "workspaceId", "status", COUNT(*), NOW()
FROM "Issue"
GROUP BY "workspaceId", "status"
ON CONFLICT ("workspaceId", "statusKey")
DO UPDATE SET "count" = EXCLUDED."count", "updatedAt" = NOW();

-- Trigger function: keep WorkspaceStatusCount in sync with every Issue write, at the
-- database level, regardless of which application code path (controller, automation,
-- bulk workflow-status merge, cycle completion, AI tool call, etc.) performed it.
-- This is intentionally the single source of truth for status counts — the API layer
-- only ever reads this table, it never runs a runtime COUNT(*) over Issue.
CREATE OR REPLACE FUNCTION sync_workspace_status_count() RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    INSERT INTO "WorkspaceStatusCount" ("workspaceId", "statusKey", "count", "updatedAt")
    VALUES (NEW."workspaceId", NEW."status", 1, NOW())
    ON CONFLICT ("workspaceId", "statusKey")
    DO UPDATE SET "count" = "WorkspaceStatusCount"."count" + 1, "updatedAt" = NOW();
    RETURN NEW;

  ELSIF (TG_OP = 'UPDATE') THEN
    IF (OLD."status" IS DISTINCT FROM NEW."status") OR (OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId") THEN
      UPDATE "WorkspaceStatusCount"
        SET "count" = GREATEST("count" - 1, 0), "updatedAt" = NOW()
        WHERE "workspaceId" = OLD."workspaceId" AND "statusKey" = OLD."status";

      INSERT INTO "WorkspaceStatusCount" ("workspaceId", "statusKey", "count", "updatedAt")
      VALUES (NEW."workspaceId", NEW."status", 1, NOW())
      ON CONFLICT ("workspaceId", "statusKey")
      DO UPDATE SET "count" = "WorkspaceStatusCount"."count" + 1, "updatedAt" = NOW();
    END IF;
    RETURN NEW;

  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE "WorkspaceStatusCount"
      SET "count" = GREATEST("count" - 1, 0), "updatedAt" = NOW()
      WHERE "workspaceId" = OLD."workspaceId" AND "statusKey" = OLD."status";
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS issue_status_count_sync ON "Issue";

CREATE TRIGGER issue_status_count_sync
AFTER INSERT OR UPDATE OR DELETE ON "Issue"
FOR EACH ROW
EXECUTE FUNCTION sync_workspace_status_count();
