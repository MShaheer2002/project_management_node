-- CreateEnum
CREATE TYPE "AiMutationKind" AS ENUM ('CREATE', 'UPDATE');

-- CreateEnum
CREATE TYPE "AiMutationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVERTED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "AiMutationRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "toolName" TEXT NOT NULL,
    "kind" "AiMutationKind" NOT NULL,
    "status" "AiMutationStatus" NOT NULL DEFAULT 'PENDING',
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetLabel" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "beforeState" JSONB,
    "afterState" JSONB,
    "revertable" BOOLEAN NOT NULL DEFAULT true,
    "revertError" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiMutationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiMutationRecord_workspaceId_status_createdAt_idx" ON "AiMutationRecord"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AiMutationRecord_conversationId_createdAt_idx" ON "AiMutationRecord"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AiMutationRecord_messageId_idx" ON "AiMutationRecord"("messageId");

-- CreateIndex
CREATE INDEX "AiMutationRecord_workspaceId_targetType_targetId_idx" ON "AiMutationRecord"("workspaceId", "targetType", "targetId");

-- AddForeignKey
ALTER TABLE "AiMutationRecord" ADD CONSTRAINT "AiMutationRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMutationRecord" ADD CONSTRAINT "AiMutationRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMutationRecord" ADD CONSTRAINT "AiMutationRecord_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
