-- Add project-level workflow override. NULL means the project inherits the workspace default workflow.
ALTER TABLE "Project"
ADD COLUMN "customStatuses" JSONB,
ADD COLUMN "workflowAutomation" JSONB;
