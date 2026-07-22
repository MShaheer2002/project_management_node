-- Add workspace-level workflow automation configuration.
ALTER TABLE "Workspace"
ADD COLUMN "workflowAutomation" JSONB NOT NULL DEFAULT '{"subtaskCompletion":{"enabled":true,"mode":"suggest","targetStatusKey":"done"},"cycleStart":{"enabled":false,"fromStatusKey":"backlog","targetStatusKey":"todo"},"overdue":{"enabled":false,"action":"notify"},"githubPullRequest":{"opened":{"enabled":true,"targetStatusKey":"review"},"merged":{"enabled":true,"targetStatusKey":"done"}}}'::jsonb;
