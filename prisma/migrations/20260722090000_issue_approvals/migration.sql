-- Activity log entries for approval actions.
ALTER TYPE "ActivityType" ADD VALUE 'ISSUE_APPROVED';
ALTER TYPE "ActivityType" ADD VALUE 'ISSUE_APPROVAL_REVOKED';

-- Approval records for approval-gated workflow statuses.
CREATE TABLE "IssueApproval" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "statusKey" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IssueApproval_issueId_statusKey_approverId_key" ON "IssueApproval"("issueId", "statusKey", "approverId");
CREATE INDEX "IssueApproval_workspaceId_issueId_statusKey_idx" ON "IssueApproval"("workspaceId", "issueId", "statusKey");

ALTER TABLE "IssueApproval" ADD CONSTRAINT "IssueApproval_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueApproval" ADD CONSTRAINT "IssueApproval_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueApproval" ADD CONSTRAINT "IssueApproval_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
