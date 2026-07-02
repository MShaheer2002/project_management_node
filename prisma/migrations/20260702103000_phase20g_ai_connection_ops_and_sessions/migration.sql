-- CreateEnum
CREATE TYPE "AiConnectionVerificationStatus" AS ENUM ('READY', 'WARNING', 'ERROR');

-- CreateEnum
CREATE TYPE "AiConnectionSessionStatus" AS ENUM ('ACTIVE', 'SUCCEEDED', 'FAILED', 'REJECTED');

-- AlterTable
ALTER TABLE "AiConnection"
ADD COLUMN "lastUsedAt" TIMESTAMP(3),
ADD COLUMN "lastVerifiedAt" TIMESTAMP(3),
ADD COLUMN "lastVerificationStatus" "AiConnectionVerificationStatus",
ADD COLUMN "lastVerificationMessage" TEXT,
ADD COLUMN "lastVerificationChecks" JSONB,
ADD COLUMN "rotatedAt" TIMESTAMP(3),
ADD COLUMN "requestCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "toolCallCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "AiConnectionSession" (
    "id" TEXT NOT NULL,
    "aiConnectionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "client" "AiConnectionClient" NOT NULL,
    "authType" "AiConnectionAuthType" NOT NULL DEFAULT 'PAT',
    "transport" TEXT NOT NULL,
    "status" "AiConnectionSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "scopeSnapshot" JSONB,
    "requestCount" INTEGER NOT NULL DEFAULT 1,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiConnectionSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiConnectionSessionStep" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiConnectionSessionStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiConnectionSession_workspaceId_startedAt_idx" ON "AiConnectionSession"("workspaceId", "startedAt");
CREATE INDEX "AiConnectionSession_aiConnectionId_startedAt_idx" ON "AiConnectionSession"("aiConnectionId", "startedAt");
CREATE INDEX "AiConnectionSession_userId_startedAt_idx" ON "AiConnectionSession"("userId", "startedAt");
CREATE INDEX "AiConnectionSession_status_startedAt_idx" ON "AiConnectionSession"("status", "startedAt");
CREATE INDEX "AiConnectionSessionStep_sessionId_startedAt_idx" ON "AiConnectionSessionStep"("sessionId", "startedAt");

-- AddForeignKey
ALTER TABLE "AiConnectionSession" ADD CONSTRAINT "AiConnectionSession_aiConnectionId_fkey" FOREIGN KEY ("aiConnectionId") REFERENCES "AiConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiConnectionSession" ADD CONSTRAINT "AiConnectionSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiConnectionSession" ADD CONSTRAINT "AiConnectionSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiConnectionSession" ADD CONSTRAINT "AiConnectionSession_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiConnectionSessionStep" ADD CONSTRAINT "AiConnectionSessionStep_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AiConnectionSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
