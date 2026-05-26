import { prisma } from "./prisma.js";

type ActivityTargetType =
  | "ISSUE"
  | "PROJECT"
  | "TEAM"
  | "DEPARTMENT"
  | "WORKSPACE"
  | "COMMENT"
  | "LABEL"
  | "MEMBER";

type ActivityType =
  | "ISSUE_CREATED"
  | "ISSUE_COMPLETED"
  | "COMMENT_ADDED"
  | "MEMBER_JOINED"
  | "STATUS_CHANGED"
  | "ASSIGNMENT_CHANGED"
  | "LABEL_CREATED"
  | "LABEL_UPDATED"
  | "LABEL_DELETED"
  | "ISSUE_LABEL_ADDED"
  | "ISSUE_LABEL_REMOVED"
  | "ISSUE_TYPE_CHANGED"
  | "ISSUE_STATUS_CHANGED"
  | "ISSUE_PRIORITY_CHANGED"
  | "ISSUE_ASSIGNEE_CHANGED"
  | "ISSUE_DUE_DATE_CHANGED"
  | "ISSUE_SCOPE_CHANGED"
  | "ISSUE_ARCHIVED"
  | "COMMENT_CREATED"
  | "COMMENT_EDITED"
  | "COMMENT_DELETED"
  | "COMMENT_MENTIONED"
  | "PROJECT_CREATED"
  | "PROJECT_UPDATED"
  | "PROJECT_MEMBER_ADDED"
  | "PROJECT_MEMBER_REMOVED"
  | "TEAM_MEMBER_JOINED"
  | "TEAM_MEMBER_REMOVED"
  | "TEAM_MEMBER_ROLE_CHANGED"
  | "WORKSPACE_MEMBER_JOINED"
  | "WORKSPACE_MEMBER_REMOVED";

interface LogActivityInput {
  workspaceId: string;
  actorId: string;
  type: ActivityType;
  targetType: ActivityTargetType;
  targetId: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export async function logActivity(input: LogActivityInput) {
  await prisma.activity.create({
    data: {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      type: input.type as any,
      targetType: input.targetType as any,
      targetId: input.targetId,
      description: input.message,
      metadata: input.metadata ?? null,
    } as any,
  });
}
