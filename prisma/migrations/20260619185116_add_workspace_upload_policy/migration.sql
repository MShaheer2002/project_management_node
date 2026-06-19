-- CreateEnum
CREATE TYPE "UploadPolicy" AS ENUM ('BOTH', 'SYSTEM_ONLY', 'DRIVE_ONLY');

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "uploadPolicy" "UploadPolicy" NOT NULL DEFAULT 'BOTH';
