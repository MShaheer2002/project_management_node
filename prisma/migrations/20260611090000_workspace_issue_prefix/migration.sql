-- Phase 19a: Workspace issue prefix — each workspace gets its own issue ID prefix
-- e.g., "VAT-1", "FIS-1" instead of globally shared "LIN-1"

-- Step 1: Add issuePrefix column (nullable first for backfill)
ALTER TABLE "Workspace" ADD COLUMN "issuePrefix" TEXT;

-- Step 2: Backfill existing workspaces with prefix derived from name
-- Takes first 3 uppercase letters of the workspace name
UPDATE "Workspace"
SET "issuePrefix" = UPPER(SUBSTRING(REGEXP_REPLACE(name, '[^a-zA-Z]', '', 'g') FROM 1 FOR 3))
WHERE "issuePrefix" IS NULL;

-- Step 3: Handle any duplicates from backfill by appending row number
WITH dupes AS (
  SELECT id, "issuePrefix",
    ROW_NUMBER() OVER (PARTITION BY "issuePrefix" ORDER BY "createdAt") AS rn
  FROM "Workspace"
)
UPDATE "Workspace" w
SET "issuePrefix" = w."issuePrefix" || dupes.rn
FROM dupes
WHERE w.id = dupes.id AND dupes.rn > 1;

-- Step 4: Update existing issue IDs to use the workspace prefix
-- Change "LIN-N" to "{prefix}-N" for each workspace
UPDATE "Issue" i
SET id = w."issuePrefix" || '-' || i.number
FROM "Workspace" w
WHERE i."workspaceId" = w.id
  AND i.id LIKE 'LIN-%';

-- Step 5: Make issuePrefix NOT NULL and UNIQUE now that all rows are populated
ALTER TABLE "Workspace" ALTER COLUMN "issuePrefix" SET NOT NULL;
CREATE UNIQUE INDEX "Workspace_issuePrefix_key" ON "Workspace"("issuePrefix");
