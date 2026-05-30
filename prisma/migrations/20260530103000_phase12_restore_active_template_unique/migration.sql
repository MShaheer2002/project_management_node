-- Restore the active-template unique guard after scope/default expansion

CREATE UNIQUE INDEX IF NOT EXISTS "Template_workspace_issueType_active_unique"
  ON "Template"("workspaceId", "issueType")
  WHERE "isActive" = true AND "deletedAt" IS NULL;

