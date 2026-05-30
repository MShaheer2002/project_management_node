-- Phase 12: Template contract upgrade

-- 1) Activity enums
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'TEMPLATE_CREATED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'TEMPLATE_UPDATED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'TEMPLATE_DELETED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'TEMPLATE_ACTIVATED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'TEMPLATE_DEACTIVATED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'TEMPLATE_APPLIED';
ALTER TYPE "ActivityTargetType" ADD VALUE IF NOT EXISTS 'TEMPLATE';

-- 2) Issue template linkage
ALTER TABLE "Issue"
  ADD COLUMN IF NOT EXISTS "templateId" TEXT,
  ADD COLUMN IF NOT EXISTS "templateVersion" INTEGER,
  ADD COLUMN IF NOT EXISTS "templateAppliedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Issue_templateId_idx" ON "Issue"("templateId");

-- 3) Template contract columns
ALTER TABLE "Template"
  ADD COLUMN IF NOT EXISTS "issueType" TEXT,
  ADD COLUMN IF NOT EXISTS "category" TEXT,
  ADD COLUMN IF NOT EXISTS "customCategory" TEXT,
  ADD COLUMN IF NOT EXISTS "titleTemplate" TEXT,
  ADD COLUMN IF NOT EXISTS "contentTemplate" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "customStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultAssigneeType" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultAssigneeId" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultEstimate" INTEGER,
  ADD COLUMN IF NOT EXISTS "defaultDueDateOffset" INTEGER,
  ADD COLUMN IF NOT EXISTS "defaultLabelIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "defaultSeverity" TEXT,
  ADD COLUMN IF NOT EXISTS "categoryOptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "priorityOptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "statusOptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "labelOptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "stepsToReproduceTemplate" TEXT,
  ADD COLUMN IF NOT EXISTS "expectedBehaviorTemplate" TEXT,
  ADD COLUMN IF NOT EXISTS "actualBehaviorTemplate" TEXT,
  ADD COLUMN IF NOT EXISTS "acceptanceCriteriaTemplate" TEXT,
  ADD COLUMN IF NOT EXISTS "relatedIssueKeysTemplate" TEXT,
  ADD COLUMN IF NOT EXISTS "notesTemplate" TEXT,
  ADD COLUMN IF NOT EXISTS "lifecycle" TEXT DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS "activeVersion" INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "usageCount" INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "timesApplied" INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastAppliedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "updatedById" TEXT;

-- Normalize legacy JSONB array columns to TEXT[] before backfill/coalesce.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Template' AND column_name = 'checklistItems' AND data_type = 'jsonb'
  ) THEN
    ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "_checklistItems_tmp" TEXT[] DEFAULT ARRAY[]::TEXT[];

    UPDATE "Template"
    SET "_checklistItems_tmp" = CASE
      WHEN "checklistItems" IS NULL THEN ARRAY[]::TEXT[]
      WHEN jsonb_typeof("checklistItems") = 'array'
        THEN COALESCE((SELECT array_agg(value) FROM jsonb_array_elements_text("checklistItems") AS value), ARRAY[]::TEXT[])
      ELSE ARRAY[]::TEXT[]
    END;

    ALTER TABLE "Template" DROP COLUMN "checklistItems";
    ALTER TABLE "Template" RENAME COLUMN "_checklistItems_tmp" TO "checklistItems";
    ALTER TABLE "Template" ALTER COLUMN "checklistItems" SET DEFAULT ARRAY[]::TEXT[];
  END IF;
END $$;

-- Backfill from legacy columns where possible
UPDATE "Template"
SET
  "contentTemplate" = COALESCE("contentTemplate", "content"),
  "titleTemplate" = COALESCE("titleTemplate", "name"),
  "description" = COALESCE("description", ''),
  "issueType" = COALESCE("issueType", 'task'),
  "category" = COALESCE("category", 'Task'),
  "defaultStatus" = COALESCE("defaultStatus", 'todo'),
  "defaultAssigneeType" = COALESCE("defaultAssigneeType", CASE WHEN "defaultAssignee" IS NULL THEN 'UNASSIGNED' ELSE 'SPECIFIC_USER' END),
  "defaultAssigneeId" = COALESCE("defaultAssigneeId", CASE WHEN "defaultAssignee" IN ('unassigned', 'creator') THEN NULL ELSE "defaultAssignee" END),
  "defaultLabelIds" = COALESCE("defaultLabelIds", ARRAY[]::TEXT[]),
  "categoryOptions" = COALESCE("categoryOptions", ARRAY['Bug','Feature','Task','QA','Research','Security','Release','Onboarding']),
  "priorityOptions" = COALESCE("priorityOptions", ARRAY['low','medium','high','urgent']),
  "statusOptions" = COALESCE("statusOptions", ARRAY['backlog','todo','in-progress','review','done']),
  "labelOptions" = COALESCE("labelOptions", ARRAY['bug','feature','task','qa','research','security','release','onboarding','review','product']),
  "checklistItems" = COALESCE("checklistItems", ARRAY[]::TEXT[]),
  "updatedById" = COALESCE("updatedById", "createdById")
WHERE true;

-- Convert legacy enum priority column to text first, then apply lowercase defaults.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Template' AND column_name = 'defaultPriority' AND data_type = 'USER-DEFINED'
  ) THEN
    ALTER TABLE "Template" ALTER COLUMN "defaultPriority" TYPE TEXT USING lower("defaultPriority"::text);
  END IF;
END $$;

UPDATE "Template"
SET "defaultPriority" = COALESCE(NULLIF(lower("defaultPriority"), ''), 'medium')
WHERE true;

-- Backfill defaultLabelIds from legacy defaultLabels if that column is JSONB array.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Template' AND column_name = 'defaultLabels' AND data_type = 'jsonb'
  ) THEN
    UPDATE "Template"
    SET "defaultLabelIds" = CASE
      WHEN "defaultLabelIds" IS NOT NULL AND array_length("defaultLabelIds", 1) > 0 THEN "defaultLabelIds"
      WHEN "defaultLabels" IS NULL THEN ARRAY[]::TEXT[]
      WHEN jsonb_typeof("defaultLabels") = 'array' THEN ARRAY(SELECT jsonb_array_elements_text("defaultLabels"))
      ELSE ARRAY[]::TEXT[]
    END;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Template' AND column_name = 'defaultLabels'
  ) THEN
    UPDATE "Template"
    SET "defaultLabelIds" = COALESCE("defaultLabelIds", "defaultLabels", ARRAY[]::TEXT[]);
  END IF;
END $$;

-- Ensure required defaults
ALTER TABLE "Template"
  ALTER COLUMN "description" SET NOT NULL,
  ALTER COLUMN "issueType" SET NOT NULL,
  ALTER COLUMN "category" SET NOT NULL,
  ALTER COLUMN "titleTemplate" SET NOT NULL,
  ALTER COLUMN "contentTemplate" SET NOT NULL,
  ALTER COLUMN "defaultPriority" SET NOT NULL,
  ALTER COLUMN "defaultStatus" SET NOT NULL,
  ALTER COLUMN "defaultAssigneeType" SET NOT NULL,
  ALTER COLUMN "defaultLabelIds" SET NOT NULL,
  ALTER COLUMN "categoryOptions" SET NOT NULL,
  ALTER COLUMN "priorityOptions" SET NOT NULL,
  ALTER COLUMN "statusOptions" SET NOT NULL,
  ALTER COLUMN "labelOptions" SET NOT NULL,
  ALTER COLUMN "checklistItems" SET NOT NULL,
  ALTER COLUMN "lifecycle" SET NOT NULL,
  ALTER COLUMN "isActive" SET NOT NULL,
  ALTER COLUMN "activeVersion" SET NOT NULL,
  ALTER COLUMN "usageCount" SET NOT NULL,
  ALTER COLUMN "timesApplied" SET NOT NULL;

-- Keep a scalar priority string; legacy enum column already exists. If enum still present it remains valid.

-- Drop legacy columns no longer used by app layer
ALTER TABLE "Template"
  DROP COLUMN IF EXISTS "content",
  DROP COLUMN IF EXISTS "defaultAssignee",
  DROP COLUMN IF EXISTS "defaultLabels";

-- Optional link to updater
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Template_updatedById_fkey'
  ) THEN
    ALTER TABLE "Template"
      ADD CONSTRAINT "Template_updatedById_fkey"
      FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Template_workspaceId_issueType_idx" ON "Template"("workspaceId", "issueType");
CREATE INDEX IF NOT EXISTS "Template_workspaceId_isActive_idx" ON "Template"("workspaceId", "isActive");
CREATE INDEX IF NOT EXISTS "Template_workspaceId_lifecycle_idx" ON "Template"("workspaceId", "lifecycle");

CREATE UNIQUE INDEX IF NOT EXISTS "Template_workspace_issueType_active_unique"
ON "Template"("workspaceId", "issueType")
WHERE "isActive" = true AND "deletedAt" IS NULL;
