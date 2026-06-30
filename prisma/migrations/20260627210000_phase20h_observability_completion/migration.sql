CREATE TABLE "AiResolverSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "conversationId" TEXT,
    "triggeringIntent" TEXT,
    "requestedEntityType" TEXT NOT NULL,
    "expectedEntityTypes" TEXT[],
    "rawTextFragment" TEXT NOT NULL,
    "accessMode" TEXT NOT NULL,
    "actionRisk" TEXT NOT NULL,
    "chosenCandidateId" TEXT,
    "chosenCandidateName" TEXT,
    "confidence" DOUBLE PRECISION,
    "resolutionStatus" TEXT NOT NULL,
    "confirmationRequired" BOOLEAN NOT NULL DEFAULT false,
    "contextOnly" BOOLEAN NOT NULL DEFAULT false,
    "memoryAssisted" BOOLEAN NOT NULL DEFAULT false,
    "topCandidates" JSONB,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiResolverSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiMetricCounterDaily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "bucketDate" DATE NOT NULL,
    "dimensionsHash" TEXT NOT NULL,
    "dimensions" JSONB,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiMetricCounterDaily_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiResolverSnapshot_workspaceId_createdAt_idx" ON "AiResolverSnapshot"("workspaceId", "createdAt");
CREATE INDEX "AiResolverSnapshot_workspaceId_triggeringIntent_createdAt_idx" ON "AiResolverSnapshot"("workspaceId", "triggeringIntent", "createdAt");
CREATE INDEX "AiResolverSnapshot_workspaceId_requestedEntityType_resolutionStatus_createdAt_idx" ON "AiResolverSnapshot"("workspaceId", "requestedEntityType", "resolutionStatus", "createdAt");

CREATE UNIQUE INDEX "AiMetricCounterDaily_workspaceId_feature_metric_bucketDate_dimensionsHash_key" ON "AiMetricCounterDaily"("workspaceId", "feature", "metric", "bucketDate", "dimensionsHash");
CREATE INDEX "AiMetricCounterDaily_workspaceId_feature_metric_bucketDate_idx" ON "AiMetricCounterDaily"("workspaceId", "feature", "metric", "bucketDate");

ALTER TABLE "AiResolverSnapshot"
ADD CONSTRAINT "AiResolverSnapshot_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiResolverSnapshot"
ADD CONSTRAINT "AiResolverSnapshot_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AiMetricCounterDaily"
ADD CONSTRAINT "AiMetricCounterDaily_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
