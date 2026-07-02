-- AlterTable
ALTER TABLE "AiConnectionSession"
ADD COLUMN "sessionKey" TEXT,
ADD COLUMN "providerSessionId" TEXT,
ADD COLUMN "clientName" TEXT,
ADD COLUMN "clientVersion" TEXT;

-- CreateIndex
CREATE INDEX "AiConnectionSession_aiConnectionId_sessionKey_status_lastActivityAt_idx"
ON "AiConnectionSession"("aiConnectionId", "sessionKey", "status", "lastActivityAt");

CREATE INDEX "AiConnectionSession_aiConnectionId_transport_client_lastActivityAt_idx"
ON "AiConnectionSession"("aiConnectionId", "transport", "client", "lastActivityAt");
