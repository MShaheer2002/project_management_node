-- CreateIndex
CREATE INDEX "Notification_workspaceId_actorUserId_type_createdAt_idx" ON "Notification"("workspaceId", "actorUserId", "type", "createdAt");

