-- CreateEnum
CREATE TYPE "AiConnectionClient" AS ENUM ('CODEX', 'CLAUDE_DESKTOP', 'CURSOR', 'GENERIC_MCP');

-- CreateEnum
CREATE TYPE "AiConnectionAuthType" AS ENUM ('PAT');

-- CreateEnum
CREATE TYPE "AiConnectionStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "AiConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "label" TEXT NOT NULL,
    "client" "AiConnectionClient" NOT NULL,
    "authType" "AiConnectionAuthType" NOT NULL DEFAULT 'PAT',
    "status" "AiConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "scopes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiConnection_apiKeyId_key" ON "AiConnection"("apiKeyId");
CREATE INDEX "AiConnection_workspaceId_userId_createdAt_idx" ON "AiConnection"("workspaceId", "userId", "createdAt");
CREATE INDEX "AiConnection_workspaceId_client_status_idx" ON "AiConnection"("workspaceId", "client", "status");

-- AddForeignKey
ALTER TABLE "AiConnection" ADD CONSTRAINT "AiConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiConnection" ADD CONSTRAINT "AiConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiConnection" ADD CONSTRAINT "AiConnection_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
