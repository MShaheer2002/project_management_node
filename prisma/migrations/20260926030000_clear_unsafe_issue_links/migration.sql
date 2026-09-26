-- F-46: issue links used to accept any URL, including javascript: links.
-- Clear the URL of any saved link that isn't http or https. The link itself stays.

UPDATE "Issue"
SET "integrationRef" = (
  SELECT jsonb_agg(
    CASE WHEN jsonb_typeof(ref->'url') = 'string' AND ref->>'url' !~* '^\s*https?://'
      THEN jsonb_set(ref, '{url}', 'null'::jsonb)
      ELSE ref
    END
    ORDER BY position
  )
  FROM jsonb_array_elements("integrationRef") WITH ORDINALITY AS refs(ref, position)
)
WHERE jsonb_typeof("integrationRef") = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements("integrationRef") AS ref
    WHERE jsonb_typeof(ref->'url') = 'string' AND ref->>'url' !~* '^\s*https?://'
  );

-- Old rows store a single link as an object instead of a list.
UPDATE "Issue"
SET "integrationRef" = jsonb_set("integrationRef", '{url}', 'null'::jsonb)
WHERE jsonb_typeof("integrationRef") = 'object'
  AND jsonb_typeof("integrationRef"->'url') = 'string'
  AND "integrationRef"->>'url' !~* '^\s*https?://';
