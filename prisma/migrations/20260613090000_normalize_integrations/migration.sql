-- Phase 19: Normalize Integration tables
-- Splits the single config JSON blob into proper tables

-- Step 1: Add new columns to Integration
ALTER TABLE "Integration" ADD COLUMN "accessToken" TEXT;
ALTER TABLE "Integration" ADD COLUMN "providerMeta" JSONB;

-- Step 2: Create IntegrationSetting table
CREATE TABLE "IntegrationSetting" (
  "id" TEXT NOT NULL,
  "integrationId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "IntegrationSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IntegrationSetting_integrationId_key_key" ON "IntegrationSetting"("integrationId", "key");
CREATE INDEX "IntegrationSetting_integrationId_idx" ON "IntegrationSetting"("integrationId");

ALTER TABLE "IntegrationSetting"
  ADD CONSTRAINT "IntegrationSetting_integrationId_fkey"
  FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 3: Create IntegrationChannel table (Slack channels)
CREATE TABLE "IntegrationChannel" (
  "id" TEXT NOT NULL,
  "integrationId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "channelName" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "scopeId" TEXT,
  CONSTRAINT "IntegrationChannel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IntegrationChannel_integrationId_channelId_scope_scopeId_key"
  ON "IntegrationChannel"("integrationId", "channelId", "scope", "scopeId");
CREATE INDEX "IntegrationChannel_integrationId_scope_idx"
  ON "IntegrationChannel"("integrationId", "scope");

ALTER TABLE "IntegrationChannel"
  ADD CONSTRAINT "IntegrationChannel_integrationId_fkey"
  FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 4: Create IntegrationWebhook table (Discord webhooks)
CREATE TABLE "IntegrationWebhook" (
  "id" TEXT NOT NULL,
  "integrationId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "scopeId" TEXT,
  CONSTRAINT "IntegrationWebhook_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IntegrationWebhook_integrationId_scope_scopeId_url_key"
  ON "IntegrationWebhook"("integrationId", "scope", "scopeId", "url");
CREATE INDEX "IntegrationWebhook_integrationId_scope_idx"
  ON "IntegrationWebhook"("integrationId", "scope");

ALTER TABLE "IntegrationWebhook"
  ADD CONSTRAINT "IntegrationWebhook_integrationId_fkey"
  FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 5: Migrate existing data from config JSON → new columns + tables

-- 5a: Extract accessToken from config JSON
UPDATE "Integration"
SET "accessToken" = config->>'accessToken'
WHERE config IS NOT NULL AND config->>'accessToken' IS NOT NULL;

-- 5b: Build providerMeta from config (everything except accessToken, settings, routing)
UPDATE "Integration"
SET "providerMeta" = CASE
  WHEN provider = 'GITHUB' THEN jsonb_build_object(
    'githubUser', config->'githubUser',
    'repos', config->'repos',
    'scope', config->>'scope'
  )
  WHEN provider = 'SLACK' THEN jsonb_build_object(
    'botUserId', config->>'botUserId',
    'team', config->'team'
  )
  WHEN provider = 'DISCORD' THEN NULL
  ELSE NULL
END
WHERE config IS NOT NULL;

-- 5c: Migrate settings from config->'settings' → IntegrationSetting rows
INSERT INTO "IntegrationSetting" ("id", "integrationId", "key", "enabled")
SELECT
  gen_random_uuid()::text,
  i.id,
  s.key,
  (s.value)::boolean
FROM "Integration" i,
  jsonb_each_text(i.config->'settings') AS s(key, value)
WHERE i.config IS NOT NULL
  AND i.config->'settings' IS NOT NULL;

-- 5d: Migrate Slack default channel → IntegrationChannel
INSERT INTO "IntegrationChannel" ("id", "integrationId", "channelId", "channelName", "scope", "scopeId")
SELECT
  gen_random_uuid()::text,
  i.id,
  i.config->>'defaultChannel',
  COALESCE(i.config->>'defaultChannelName', '#unknown'),
  'default',
  NULL
FROM "Integration" i
WHERE i.provider = 'SLACK'
  AND i.config IS NOT NULL
  AND i.config->>'defaultChannel' IS NOT NULL
  AND i.config->>'defaultChannel' != '';

-- 5e: Migrate Slack channelRouting projects → IntegrationChannel
INSERT INTO "IntegrationChannel" ("id", "integrationId", "channelId", "channelName", "scope", "scopeId")
SELECT
  gen_random_uuid()::text,
  i.id,
  ch->>'channelId',
  COALESCE(ch->>'channelName', '#unknown'),
  'project',
  proj.key
FROM "Integration" i,
  jsonb_each(i.config->'channelRouting'->'projects') AS proj(key, value),
  jsonb_array_elements(proj.value) AS ch
WHERE i.provider = 'SLACK'
  AND i.config IS NOT NULL
  AND i.config->'channelRouting'->'projects' IS NOT NULL
  AND ch->>'channelId' IS NOT NULL
ON CONFLICT DO NOTHING;

-- 5f: Migrate Slack channelRouting teams → IntegrationChannel
INSERT INTO "IntegrationChannel" ("id", "integrationId", "channelId", "channelName", "scope", "scopeId")
SELECT
  gen_random_uuid()::text,
  i.id,
  ch->>'channelId',
  COALESCE(ch->>'channelName', '#unknown'),
  'team',
  team.key
FROM "Integration" i,
  jsonb_each(i.config->'channelRouting'->'teams') AS team(key, value),
  jsonb_array_elements(team.value) AS ch
WHERE i.provider = 'SLACK'
  AND i.config IS NOT NULL
  AND i.config->'channelRouting'->'teams' IS NOT NULL
  AND ch->>'channelId' IS NOT NULL
ON CONFLICT DO NOTHING;

-- 5g: Migrate Slack urgent channel → IntegrationChannel
INSERT INTO "IntegrationChannel" ("id", "integrationId", "channelId", "channelName", "scope", "scopeId")
SELECT
  gen_random_uuid()::text,
  i.id,
  i.config->'channelRouting'->'urgent'->>'channelId',
  COALESCE(i.config->'channelRouting'->'urgent'->>'channelName', '#urgent'),
  'urgent',
  NULL
FROM "Integration" i
WHERE i.provider = 'SLACK'
  AND i.config IS NOT NULL
  AND i.config->'channelRouting'->'urgent'->>'channelId' IS NOT NULL
ON CONFLICT DO NOTHING;

-- 5h: Migrate Discord default webhook → IntegrationWebhook
INSERT INTO "IntegrationWebhook" ("id", "integrationId", "url", "label", "scope", "scopeId")
SELECT
  gen_random_uuid()::text,
  i.id,
  i.config->'defaultWebhook'->>'url',
  COALESCE(i.config->'defaultWebhook'->>'label', 'Default'),
  'default',
  NULL
FROM "Integration" i
WHERE i.provider = 'DISCORD'
  AND i.config IS NOT NULL
  AND i.config->'defaultWebhook'->>'url' IS NOT NULL
ON CONFLICT DO NOTHING;

-- 5i: Migrate Discord webhookRouting projects → IntegrationWebhook
INSERT INTO "IntegrationWebhook" ("id", "integrationId", "url", "label", "scope", "scopeId")
SELECT
  gen_random_uuid()::text,
  i.id,
  wh->>'url',
  COALESCE(wh->>'label', 'Webhook'),
  'project',
  proj.key
FROM "Integration" i,
  jsonb_each(i.config->'webhookRouting'->'projects') AS proj(key, value),
  jsonb_array_elements(proj.value) AS wh
WHERE i.provider = 'DISCORD'
  AND i.config IS NOT NULL
  AND i.config->'webhookRouting'->'projects' IS NOT NULL
  AND wh->>'url' IS NOT NULL
ON CONFLICT DO NOTHING;

-- 5j: Migrate Discord webhookRouting teams → IntegrationWebhook
INSERT INTO "IntegrationWebhook" ("id", "integrationId", "url", "label", "scope", "scopeId")
SELECT
  gen_random_uuid()::text,
  i.id,
  wh->>'url',
  COALESCE(wh->>'label', 'Webhook'),
  'team',
  team.key
FROM "Integration" i,
  jsonb_each(i.config->'webhookRouting'->'teams') AS team(key, value),
  jsonb_array_elements(team.value) AS wh
WHERE i.provider = 'DISCORD'
  AND i.config IS NOT NULL
  AND i.config->'webhookRouting'->'teams' IS NOT NULL
  AND wh->>'url' IS NOT NULL
ON CONFLICT DO NOTHING;

-- 5k: Migrate Discord urgent webhook → IntegrationWebhook
INSERT INTO "IntegrationWebhook" ("id", "integrationId", "url", "label", "scope", "scopeId")
SELECT
  gen_random_uuid()::text,
  i.id,
  i.config->'webhookRouting'->'urgent'->>'url',
  COALESCE(i.config->'webhookRouting'->'urgent'->>'label', 'Urgent'),
  'urgent',
  NULL
FROM "Integration" i
WHERE i.provider = 'DISCORD'
  AND i.config IS NOT NULL
  AND i.config->'webhookRouting'->'urgent'->>'url' IS NOT NULL
ON CONFLICT DO NOTHING;

-- Step 6: Drop the config column (data is now in proper tables)
ALTER TABLE "Integration" DROP COLUMN "config";
