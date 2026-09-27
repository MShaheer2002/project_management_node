-- N-06: attachment and document links used to accept any URL, including
-- javascript: links. Clear any that isn't http or https. The file itself stays.

UPDATE "IssueAttachment" SET "assetUrl" = NULL WHERE "assetUrl" !~* '^\s*https?://';
UPDATE "CommentAttachment" SET "assetUrl" = NULL WHERE "assetUrl" !~* '^\s*https?://';
UPDATE "EntityDocument" SET "fileUrl" = NULL WHERE "fileUrl" !~* '^\s*https?://';
