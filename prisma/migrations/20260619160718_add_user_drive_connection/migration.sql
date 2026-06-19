-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityType" ADD VALUE 'DRIVE_CONNECTED';
ALTER TYPE "ActivityType" ADD VALUE 'DRIVE_DISCONNECTED';

-- CreateTable
CREATE TABLE "UserDriveConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'google_drive',
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "email" TEXT NOT NULL,
    "connected" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserDriveConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserDriveConnection_userId_key" ON "UserDriveConnection"("userId");

-- CreateIndex
CREATE INDEX "UserDriveConnection_userId_idx" ON "UserDriveConnection"("userId");

-- CreateIndex
CREATE INDEX "Issue_workspaceId_status_idx" ON "Issue"("workspaceId", "status");

-- AddForeignKey
ALTER TABLE "UserDriveConnection" ADD CONSTRAINT "UserDriveConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
