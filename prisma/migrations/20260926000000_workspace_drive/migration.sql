-- CreateEnum
CREATE TYPE "DriveTarget" AS ENUM ('PERSONAL', 'WORKSPACE');

-- AlterTable
ALTER TABLE "Workspace" ALTER COLUMN "allowPublicDriveLinks" SET DEFAULT true;

-- AlterTable
ALTER TABLE "WorkspaceMembership" ADD COLUMN     "driveUploadTarget" "DriveTarget" NOT NULL DEFAULT 'WORKSPACE';

-- AlterTable
ALTER TABLE "UserDriveConnection" ADD COLUMN     "defaultSharing" "DriveSharing" NOT NULL DEFAULT 'PUBLIC';

-- AlterTable
ALTER TABLE "DriveUpload" ADD COLUMN     "target" "DriveTarget" NOT NULL DEFAULT 'PERSONAL';

-- CreateTable
CREATE TABLE "WorkspaceDriveConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectedById" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "defaultSharing" "DriveSharing" NOT NULL DEFAULT 'PUBLIC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceDriveConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceDriveConnection_workspaceId_key" ON "WorkspaceDriveConnection"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceDriveConnection_connectedById_idx" ON "WorkspaceDriveConnection"("connectedById");

-- AddForeignKey
ALTER TABLE "WorkspaceDriveConnection" ADD CONSTRAINT "WorkspaceDriveConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceDriveConnection" ADD CONSTRAINT "WorkspaceDriveConnection_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Public links are now the default and the switch starts on. Nothing has been
-- released with it off, so existing workspaces follow the new default.
UPDATE "Workspace" SET "allowPublicDriveLinks" = true;
