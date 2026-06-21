-- AlterEnum
ALTER TYPE "ActivityType" ADD VALUE 'AI_ACTION_EXECUTED';

-- AlterTable
ALTER TABLE "AiConversation"
ADD COLUMN     "summary" TEXT,
ADD COLUMN     "summaryMessageCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "summaryUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "requestCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalInputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalOutputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastModelUsed" TEXT;

-- CreateTable
CREATE TABLE "AiWorkspaceUsageDaily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "issueGenerationCount" INTEGER NOT NULL DEFAULT 0,
    "chatTurnCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiWorkspaceUsageDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUserUsageDaily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "issueGenerationCount" INTEGER NOT NULL DEFAULT 0,
    "chatTurnCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUserUsageDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiToolExecution" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "toolName" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiToolExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiWorkspaceUsageDaily_workspaceId_date_key" ON "AiWorkspaceUsageDaily"("workspaceId", "date");

-- CreateIndex
CREATE INDEX "AiWorkspaceUsageDaily_workspaceId_date_idx" ON "AiWorkspaceUsageDaily"("workspaceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AiUserUsageDaily_workspaceId_userId_date_key" ON "AiUserUsageDaily"("workspaceId", "userId", "date");

-- CreateIndex
CREATE INDEX "AiUserUsageDaily_workspaceId_date_idx" ON "AiUserUsageDaily"("workspaceId", "date");

-- CreateIndex
CREATE INDEX "AiUserUsageDaily_workspaceId_userId_idx" ON "AiUserUsageDaily"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "AiUserUsageDaily_userId_date_idx" ON "AiUserUsageDaily"("userId", "date");

-- CreateIndex
CREATE INDEX "AiToolExecution_workspaceId_createdAt_idx" ON "AiToolExecution"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AiToolExecution_workspaceId_userId_createdAt_idx" ON "AiToolExecution"("workspaceId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiToolExecution_conversationId_createdAt_idx" ON "AiToolExecution"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AiToolExecution_fingerprint_createdAt_idx" ON "AiToolExecution"("fingerprint", "createdAt");

-- AddForeignKey
ALTER TABLE "AiWorkspaceUsageDaily" ADD CONSTRAINT "AiWorkspaceUsageDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUserUsageDaily" ADD CONSTRAINT "AiUserUsageDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUserUsageDaily" ADD CONSTRAINT "AiUserUsageDaily_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiToolExecution" ADD CONSTRAINT "AiToolExecution_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiToolExecution" ADD CONSTRAINT "AiToolExecution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiToolExecution" ADD CONSTRAINT "AiToolExecution_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
