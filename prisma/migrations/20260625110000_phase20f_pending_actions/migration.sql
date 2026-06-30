-- Phase 20F: durable pending action state for deterministic AI clarifications
ALTER TABLE "AiConversation"
ADD COLUMN "pendingAction" JSONB,
ADD COLUMN "pendingActionUpdatedAt" TIMESTAMP(3);
