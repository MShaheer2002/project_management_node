-- F-45: API keys created through the AI chat were handed to the model, which
-- repeated them; the raw secret ended up in chat history and tool result logs.
-- The chat can no longer create keys. Remove any raw key already stored.
-- A full key is lin_live_/lin_test_ + 48 hex characters; the 16-character
-- prefix shown in key lists (7 hex after the underscore) is left alone.
-- Keys found here should be revoked: they may also be in the provider's logs.

UPDATE "AiMessage"
SET "content" = regexp_replace("content", 'lin_(live|test)_[0-9a-f]{20,}', '[API key removed]', 'g')
WHERE "content" ~ 'lin_(live|test)_[0-9a-f]{20,}';

UPDATE "AiMessage"
SET "toolResults" = regexp_replace("toolResults"::text, 'lin_(live|test)_[0-9a-f]{20,}', '[API key removed]', 'g')::jsonb
WHERE "toolResults"::text ~ 'lin_(live|test)_[0-9a-f]{20,}';

UPDATE "AiToolExecution"
SET "result" = regexp_replace("result"::text, 'lin_(live|test)_[0-9a-f]{20,}', '[API key removed]', 'g')::jsonb
WHERE "result"::text ~ 'lin_(live|test)_[0-9a-f]{20,}';

UPDATE "AiConversation"
SET "summary" = regexp_replace("summary", 'lin_(live|test)_[0-9a-f]{20,}', '[API key removed]', 'g')
WHERE "summary" ~ 'lin_(live|test)_[0-9a-f]{20,}';

UPDATE "AiConversation"
SET "memory" = regexp_replace("memory"::text, 'lin_(live|test)_[0-9a-f]{20,}', '[API key removed]', 'g')::jsonb
WHERE "memory"::text ~ 'lin_(live|test)_[0-9a-f]{20,}';
