ALTER TABLE "WorkspaceInvitation" DROP CONSTRAINT "WorkspaceInvitation_teamId_fkey";

ALTER TABLE "WorkspaceInvitation"
ADD CONSTRAINT "WorkspaceInvitation_teamId_fkey"
FOREIGN KEY ("teamId") REFERENCES "Team"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
