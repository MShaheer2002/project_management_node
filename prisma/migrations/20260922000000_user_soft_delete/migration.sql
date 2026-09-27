-- Soft-delete for users (audit F-19).
--
-- Hard-deleting a User on Clerk's `user.deleted` webhook always failed: required
-- relations use ON DELETE RESTRICT (Activity_actorId_fkey, ApiKey_createdById_fkey,
-- Issue_creatorId_fkey, Comment_authorId_fkey, ...) and every member has at least
-- one Activity row. The webhook 500'd, Clerk's retries failed identically, and the
-- user's API keys and memberships stayed live.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Partial index: lookups filter on "not deleted", which is almost every row.
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt") WHERE "deletedAt" IS NOT NULL;
