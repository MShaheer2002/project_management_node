-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "deactivatedById" TEXT,
ADD COLUMN     "lastDeletionReminderDaysLeft" INTEGER,
ADD COLUMN     "purgeAt" TIMESTAMP(3),
ADD COLUMN     "purgeStartedAt" TIMESTAMP(3),
ADD COLUMN     "resumeBillingOnRestore" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Workspace_purgeAt_idx" ON "Workspace"("purgeAt");

