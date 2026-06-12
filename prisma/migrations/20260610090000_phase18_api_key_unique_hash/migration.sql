-- Phase 18: API Key — switch from prefix index to unique hash index
-- This enables O(1) lookup by SHA-256 hash instead of scanning by prefix

-- Drop the old prefix-based index (no longer used for auth lookup)
DROP INDEX IF EXISTS "ApiKey_keyPrefix_idx";

-- Add unique constraint on keyHash for direct hash-based auth lookup
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- Add API_KEY activity types
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'API_KEY_CREATED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'API_KEY_REVOKED';
