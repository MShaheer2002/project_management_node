-- AI Assistance chat memory (24 hours), modules/ai/ai.assist-memory.ts.
CREATE TABLE "AiAssistMessage" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAssistMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiAssistMessage_workspaceId_userId_seq_idx" ON "AiAssistMessage"("workspaceId", "userId", "seq");
CREATE INDEX "AiAssistMessage_createdAt_idx" ON "AiAssistMessage"("createdAt");

ALTER TABLE "AiAssistMessage" ADD CONSTRAINT "AiAssistMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiAssistMessage" ADD CONSTRAINT "AiAssistMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
