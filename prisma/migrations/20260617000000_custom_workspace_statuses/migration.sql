-- Add customStatuses JSON field to Workspace with default statuses
ALTER TABLE "Workspace" ADD COLUMN "customStatuses" JSONB NOT NULL DEFAULT '[{"key":"backlog","label":"Backlog","color":"#6b7280","order":0,"isFinal":false},{"key":"todo","label":"Todo","color":"#3b82f6","order":1,"isFinal":false},{"key":"in-progress","label":"In Progress","color":"#f59e0b","order":2,"isFinal":false},{"key":"review","label":"Review","color":"#8b5cf6","order":3,"isFinal":false},{"key":"done","label":"Done","color":"#22c55e","order":4,"isFinal":true}]';

-- Convert Issue.status from enum to text while preserving data
-- Step 1: Add temporary text column
ALTER TABLE "Issue" ADD COLUMN "status_new" TEXT;

-- Step 2: Map enum values to lowercase keys
UPDATE "Issue" SET "status_new" = CASE "status"
  WHEN 'BACKLOG' THEN 'backlog'
  WHEN 'TODO' THEN 'todo'
  WHEN 'IN_PROGRESS' THEN 'in-progress'
  WHEN 'REVIEW' THEN 'review'
  WHEN 'DONE' THEN 'done'
  ELSE 'backlog'
END;

-- Step 3: Drop old enum column and rename new one
ALTER TABLE "Issue" DROP COLUMN "status";
ALTER TABLE "Issue" RENAME COLUMN "status_new" TO "status";

-- Step 4: Set default and not null
ALTER TABLE "Issue" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "Issue" ALTER COLUMN "status" SET DEFAULT 'backlog';

-- Step 5: Recreate indexes that referenced status
CREATE INDEX IF NOT EXISTS "Issue_status_idx" ON "Issue"("status");
