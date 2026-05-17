-- CreateEnum
CREATE TYPE "TeamSize" AS ENUM ('SMALL', 'MEDIUM', 'LARGE', 'ENTERPRISE');

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "teamSize" "TeamSize";
