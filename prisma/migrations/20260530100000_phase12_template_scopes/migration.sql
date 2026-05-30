-- Phase 12 template scope/default expansion

ALTER TABLE "Template"
  ADD COLUMN IF NOT EXISTS "scopeType" TEXT NOT NULL DEFAULT 'WORKSPACE',
  ADD COLUMN IF NOT EXISTS "scopeId" TEXT,
  ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Template"
SET
  "scopeType" = COALESCE("scopeType", 'WORKSPACE'),
  "scopeId" = NULL,
  "isDefault" = COALESCE("isDefault", false);

ALTER TABLE "Template"
  ALTER COLUMN "scopeType" SET DEFAULT 'WORKSPACE',
  ALTER COLUMN "isDefault" SET DEFAULT false;

CREATE INDEX IF NOT EXISTS "Template_workspaceId_scopeType_scopeId_idx"
  ON "Template"("workspaceId", "scopeType", "scopeId");

DROP INDEX IF EXISTS "Template_workspace_issueType_active_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "Template_workspace_issueType_default_unique"
  ON "Template"("workspaceId", "issueType")
  WHERE "scopeType" = 'WORKSPACE' AND "isDefault" = true AND "deletedAt" IS NULL;

