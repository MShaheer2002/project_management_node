-- CreateEnum
CREATE TYPE "ProjectMembershipRole" AS ENUM ('LEAD', 'MEMBER');

-- AlterTable
ALTER TABLE "Project"
ADD COLUMN "slug" TEXT,
ADD COLUMN "startDate" DATE,
ADD COLUMN "targetDate" DATE,
ADD COLUMN "featureRoadmap" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "featureCycles" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "featureIssueTracking" BOOLEAN NOT NULL DEFAULT true;

-- Backfill slug from name for existing rows (best-effort stable fallback)
UPDATE "Project"
SET "slug" = regexp_replace(lower(trim("name")), '[^a-z0-9]+', '-', 'g')
WHERE "slug" IS NULL;

ALTER TABLE "Project"
ALTER COLUMN "slug" SET NOT NULL;

-- CreateTable
CREATE TABLE "ProjectMembership" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "membershipRole" "ProjectMembershipRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMembership_pkey" PRIMARY KEY ("projectId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_workspaceId_slug_key" ON "Project"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "ProjectMembership_userId_idx" ON "ProjectMembership"("userId");

-- AddForeignKey
ALTER TABLE "ProjectMembership" ADD CONSTRAINT "ProjectMembership_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMembership" ADD CONSTRAINT "ProjectMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
