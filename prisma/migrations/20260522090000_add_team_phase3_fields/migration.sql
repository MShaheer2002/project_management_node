ALTER TABLE "Department"
ADD COLUMN IF NOT EXISTS "description" TEXT;

CREATE INDEX IF NOT EXISTS "Department_headId_idx" ON "Department"("headId");
CREATE INDEX IF NOT EXISTS "Department_visibility_idx" ON "Department"("visibility");
CREATE INDEX IF NOT EXISTS "Department_isDefault_idx" ON "Department"("isDefault");

ALTER TABLE "Team"
ADD COLUMN IF NOT EXISTS "description" TEXT,
ADD COLUMN IF NOT EXISTS "visibility" "Visibility" NOT NULL DEFAULT 'PUBLIC';

CREATE INDEX IF NOT EXISTS "Team_leadId_idx" ON "Team"("leadId");
CREATE INDEX IF NOT EXISTS "Team_visibility_idx" ON "Team"("visibility");
