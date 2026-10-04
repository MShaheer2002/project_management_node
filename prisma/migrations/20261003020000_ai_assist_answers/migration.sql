-- AI Assistance answer log for feedback and staff insights (90 days).
CREATE TABLE "AiAssistAnswer" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "articleIds" TEXT[],
    "route" TEXT,
    "model" TEXT,
    "latencyMs" INTEGER,
    "rating" TEXT,
    "ratingReason" TEXT,
    "ratingComment" TEXT,
    "ratedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAssistAnswer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiAssistAnswer_createdAt_idx" ON "AiAssistAnswer"("createdAt");
CREATE INDEX "AiAssistAnswer_kind_createdAt_idx" ON "AiAssistAnswer"("kind", "createdAt");
CREATE INDEX "AiAssistAnswer_rating_createdAt_idx" ON "AiAssistAnswer"("rating", "createdAt");

ALTER TABLE "AiAssistAnswer" ADD CONSTRAINT "AiAssistAnswer_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiAssistAnswer" ADD CONSTRAINT "AiAssistAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
