-- ProjectStatusCount: the same trigger-maintained counter pattern as
-- WorkspaceStatusCount (see migration 20260723184235_workspace_status_counts),
-- scoped to a single project. Lets a project's issue list show accurate
-- per-status counts without ever loading issues or running a runtime
-- COUNT(*) at request time.
CREATE TABLE "ProjectStatusCount" (
    "projectId" TEXT NOT NULL,
    "statusKey" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectStatusCount_pkey" PRIMARY KEY ("projectId","statusKey")
);

CREATE INDEX "ProjectStatusCount_projectId_idx" ON "ProjectStatusCount"("projectId");

ALTER TABLE "ProjectStatusCount" ADD CONSTRAINT "ProjectStatusCount_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: seed ProjectStatusCount from every issue that already exists, so
-- counts are correct from the moment the trigger below goes live.
INSERT INTO "ProjectStatusCount" ("projectId", "statusKey", "count", "updatedAt")
SELECT "projectId", "status", COUNT(*), NOW()
FROM "Issue"
GROUP BY "projectId", "status"
ON CONFLICT ("projectId", "statusKey")
DO UPDATE SET "count" = EXCLUDED."count", "updatedAt" = NOW();

-- Replace the existing trigger function to also maintain ProjectStatusCount,
-- keyed off whichever project the issue belongs to. Decrementing the OLD
-- (project, status) pair and incrementing the NEW one on every write covers
-- a plain status change, an issue moving to a different project, or both at
-- once, uniformly — if one side didn't actually change, the same value gets
-- decremented and re-incremented, which is a no-op.
CREATE OR REPLACE FUNCTION sync_workspace_status_count() RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    INSERT INTO "WorkspaceStatusCount" ("workspaceId", "statusKey", "count", "updatedAt")
    VALUES (NEW."workspaceId", NEW."status", 1, NOW())
    ON CONFLICT ("workspaceId", "statusKey")
    DO UPDATE SET "count" = "WorkspaceStatusCount"."count" + 1, "updatedAt" = NOW();

    INSERT INTO "ProjectStatusCount" ("projectId", "statusKey", "count", "updatedAt")
    VALUES (NEW."projectId", NEW."status", 1, NOW())
    ON CONFLICT ("projectId", "statusKey")
    DO UPDATE SET "count" = "ProjectStatusCount"."count" + 1, "updatedAt" = NOW();
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

    IF (OLD."status" IS DISTINCT FROM NEW."status") OR (OLD."projectId" IS DISTINCT FROM NEW."projectId") THEN
      UPDATE "ProjectStatusCount"
        SET "count" = GREATEST("count" - 1, 0), "updatedAt" = NOW()
        WHERE "projectId" = OLD."projectId" AND "statusKey" = OLD."status";

      INSERT INTO "ProjectStatusCount" ("projectId", "statusKey", "count", "updatedAt")
      VALUES (NEW."projectId", NEW."status", 1, NOW())
      ON CONFLICT ("projectId", "statusKey")
      DO UPDATE SET "count" = "ProjectStatusCount"."count" + 1, "updatedAt" = NOW();
    END IF;
    RETURN NEW;

  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE "WorkspaceStatusCount"
      SET "count" = GREATEST("count" - 1, 0), "updatedAt" = NOW()
      WHERE "workspaceId" = OLD."workspaceId" AND "statusKey" = OLD."status";

    UPDATE "ProjectStatusCount"
      SET "count" = GREATEST("count" - 1, 0), "updatedAt" = NOW()
      WHERE "projectId" = OLD."projectId" AND "statusKey" = OLD."status";
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
