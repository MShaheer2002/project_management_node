-- F-43: health summaries and the weekly digest stored the full analytics
-- payload, including per-person workload and performance tables, and were
-- served to members and guests. New ones keep only aggregate numbers; strip
-- the per-person data from the ones already stored. Nothing reads it (the
-- app shows the summary text and riskSignals).
UPDATE "AiSuggestion"
SET "payload" = "payload" - 'analytics'
WHERE "type" IN ('PROJECT_HEALTH', 'TEAM_HEALTH', 'CYCLE_HEALTH', 'WEEKLY_DIGEST')
  AND jsonb_typeof("payload") = 'object'
  AND "payload" ? 'analytics';
