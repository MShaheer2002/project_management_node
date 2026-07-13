-- Add optional designation/job title fields for workspace invites and memberships
ALTER TABLE "WorkspaceInvitation"
ADD COLUMN "designation" TEXT;

ALTER TABLE "WorkspaceMembership"
ADD COLUMN "designation" TEXT;
