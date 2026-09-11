-- CreateEnum
CREATE TYPE "InviteDomainPolicy" AS ENUM ('ANY', 'COMPANY_ONLY', 'CUSTOM');

-- DropIndex
DROP INDEX "AiEmbedding_embedding_idx";

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "allowedEmailDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "inviteDomainPolicy" "InviteDomainPolicy" NOT NULL DEFAULT 'ANY';
