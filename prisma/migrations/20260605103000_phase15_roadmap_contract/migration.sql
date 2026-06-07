-- CreateEnum
CREATE TYPE "MilestoneStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'MISSED');

-- CreateEnum
CREATE TYPE "ProjectDependencyStatus" AS ENUM ('ACTIVE', 'RESOLVED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ROADMAP_SCHEDULE_UPDATED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ROADMAP_MILESTONE_CREATED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ROADMAP_MILESTONE_UPDATED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ROADMAP_MILESTONE_COMPLETED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ROADMAP_MILESTONE_DELETED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ROADMAP_MILESTONES_REORDERED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ROADMAP_DEPENDENCY_CREATED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ROADMAP_DEPENDENCY_RESOLVED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ROADMAP_DEPENDENCY_CANCELLED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'ROADMAP_DEPENDENCY_DELETED';

-- CreateTable
CREATE TABLE "ProjectMilestone" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "ownerId" TEXT,
    "status" "MilestoneStatus" NOT NULL DEFAULT 'PLANNED',
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectDependency" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "blockingProjectId" TEXT NOT NULL,
    "blockedProjectId" TEXT NOT NULL,
    "status" "ProjectDependencyStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectDependency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectMilestone_workspaceId_projectId_dueDate_idx" ON "ProjectMilestone"("workspaceId", "projectId", "dueDate");

-- CreateIndex
CREATE INDEX "ProjectMilestone_workspaceId_status_dueDate_idx" ON "ProjectMilestone"("workspaceId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "ProjectMilestone_ownerId_idx" ON "ProjectMilestone"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectDependency_blockingProjectId_blockedProjectId_key" ON "ProjectDependency"("blockingProjectId", "blockedProjectId");

-- CreateIndex
CREATE INDEX "ProjectDependency_workspaceId_blockingProjectId_status_idx" ON "ProjectDependency"("workspaceId", "blockingProjectId", "status");

-- CreateIndex
CREATE INDEX "ProjectDependency_workspaceId_blockedProjectId_status_idx" ON "ProjectDependency"("workspaceId", "blockedProjectId", "status");

-- AddForeignKey
ALTER TABLE "ProjectMilestone" ADD CONSTRAINT "ProjectMilestone_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMilestone" ADD CONSTRAINT "ProjectMilestone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMilestone" ADD CONSTRAINT "ProjectMilestone_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMilestone" ADD CONSTRAINT "ProjectMilestone_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMilestone" ADD CONSTRAINT "ProjectMilestone_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDependency" ADD CONSTRAINT "ProjectDependency_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDependency" ADD CONSTRAINT "ProjectDependency_blockingProjectId_fkey" FOREIGN KEY ("blockingProjectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDependency" ADD CONSTRAINT "ProjectDependency_blockedProjectId_fkey" FOREIGN KEY ("blockedProjectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDependency" ADD CONSTRAINT "ProjectDependency_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDependency" ADD CONSTRAINT "ProjectDependency_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDependency" ADD CONSTRAINT "ProjectDependency_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
