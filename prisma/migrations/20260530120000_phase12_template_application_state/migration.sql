CREATE TABLE "TemplateApplication" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateApplication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TemplateApplication_workspaceId_templateId_userId_key" ON "TemplateApplication"("workspaceId", "templateId", "userId");
CREATE INDEX "TemplateApplication_workspaceId_userId_idx" ON "TemplateApplication"("workspaceId", "userId");
CREATE INDEX "TemplateApplication_templateId_idx" ON "TemplateApplication"("templateId");

ALTER TABLE "TemplateApplication" ADD CONSTRAINT "TemplateApplication_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TemplateApplication" ADD CONSTRAINT "TemplateApplication_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TemplateApplication" ADD CONSTRAINT "TemplateApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
