-- Add showOnBoard to the default workspace custom statuses payload for new workspaces.
ALTER TABLE "Workspace"
ALTER COLUMN "customStatuses"
SET DEFAULT '[{"key":"backlog","label":"Backlog","color":"#6b7280","order":0,"isFinal":false,"showOnBoard":true},{"key":"todo","label":"Todo","color":"#3b82f6","order":1,"isFinal":false,"showOnBoard":true},{"key":"in-progress","label":"In Progress","color":"#f59e0b","order":2,"isFinal":false,"showOnBoard":true},{"key":"review","label":"Review","color":"#8b5cf6","order":3,"isFinal":false,"showOnBoard":true},{"key":"done","label":"Done","color":"#22c55e","order":4,"isFinal":true,"showOnBoard":true}]'::jsonb;
