-- AiConnection OAuth support: adds the OAUTH auth type and the Clerk OAuth
-- client-id join key used to resolve a connection without an ApiKey row.
ALTER TYPE "AiConnectionAuthType" ADD VALUE IF NOT EXISTS 'OAUTH';

ALTER TABLE "AiConnection" ADD COLUMN "oauthClientId" TEXT;

-- Postgres treats each NULL as distinct in a unique index, so PAT rows
-- (oauthClientId IS NULL) never collide with each other or with OAuth rows.
CREATE UNIQUE INDEX "AiConnection_userId_oauthClientId_key" ON "AiConnection"("userId", "oauthClientId");
