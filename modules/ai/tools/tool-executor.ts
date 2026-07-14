/**
 * Trussen AI Tool Executor — Complete Implementation
 *
 * SECURITY LAYERS:
 *   1. Workspace isolation — every query includes workspaceId
 *   2. Role-based access — GUEST=read, MEMBER=create+update own, ADMIN/OWNER=all
 *   3. Visibility check — private projects/teams filtered by membership
 *   4. Ownership check — members can only update issues assigned to them
 *   5. NO DELETE — deleting anything is forbidden from AI
 *   6. Invite — ADMIN/OWNER only
 *   7. Project/team creation — ADMIN/OWNER only
 */

import { prisma } from "../../../shared/utils/prisma.js";
import { AppError } from "../../../shared/utils/api-error.js";
import { randomBytes, createHash } from "node:crypto";
import { logActivity } from "../../../shared/utils/activity.js";
import { invalidateContextCache } from "../ai.context.js";
import { triggerIssueBackgroundJobs } from "../ai.background.js";
import { upsertEntityAliases } from "../ai.entity-aliases.js";
import { enqueueEmbedding } from "../ai.jobs.js";
import { logAiError, logAiInfo, logAiWarn } from "../ai.observability.js";
import type { ExecutorResult } from "../ai.planner.js";
import { Prisma, type WorkspaceRole } from "../../../app/generated/prisma/client.js";
import type { IssuePriority } from "../../../app/generated/prisma/enums.js";
import {
  exportAnalytics,
  formatAnalyticsReport,
  getCycleAnalytics,
  getMemberAnalytics,
  getProjectAnalytics,
  getTeamAnalytics,
  getWorkspaceAnalytics,
} from "../../analytics/analytics.service.js";
import type { AnalyticsQuery } from "../../analytics/analytics.schemas.js";
import {
  addDependency,
  addWatchers,
  listWatchers,
  updateIntegrationRefs,
} from "../../issue/issue.service.js";
import {
  createSubtask,
  reorderSubtasks,
  updateSubtask,
} from "../../issue/subtask.service.js";
import {
  createTeam,
  getTeamById,
  getTeamOwnership,
  listTeams as listTeamsService,
  updateTeam,
} from "../../team/team.service.js";
import {
  addTeamMembers,
  listTeamMembers as listTeamMembersService,
  removeTeamMember,
} from "../../team/team-membership.service.js";
import {
  createDepartment,
  getDepartmentById,
  getDepartmentOwnership,
  listDepartments,
  updateDepartment,
} from "../../department/department.service.js";
import {
  addDepartmentMembers,
  listDepartmentMembers,
  removeDepartmentMember,
} from "../../department/department-membership.service.js";
import {
  carryOverCycle,
  completeCycle,
  createCycle,
  getCurrentCycle,
  getCycleById,
  listCycles as listCyclesService,
  reopenCycle,
  updateCycle,
} from "../../cycle/cycle.service.js";
import {
  addProjectMembers,
  listProjectMembers,
  removeProjectMember,
} from "../../project/project-membership.service.js";
import { getProjectOwnership } from "../../project/project.service.js";
import {
  changeMemberRole,
  listMembers as listWorkspaceMembers,
  removeMember as removeWorkspaceMember,
} from "../../workspace/membership.service.js";
import {
  acceptInvitationById,
  listInvitations,
  listPendingInvitationsForUser,
} from "../../workspace/invitation.service.js";
import {
  getWorkspaceById,
  listWorkspaces,
  updateWorkspace,
  getWorkspaceStatuses,
  updateWorkspaceStatuses,
} from "../../workspace/workspace.service.js";
import {
  activateTemplate,
  createTemplate,
  deactivateTemplate,
  duplicateTemplate,
  getTemplateById,
  listActiveTemplates,
  listTemplates,
  updateTemplate,
} from "../../template/template.service.js";
import {
  listNotifications,
  markAllRead,
  markRead,
} from "../../notification/notification.service.js";
import {
  createProjectDocument,
  createTeamDocument,
  createWorkspaceDocument,
  createProjectFolder,
  createTeamFolder,
  createWorkspaceFolder,
  getProjectFolderBreadcrumbs,
  getTeamFolderBreadcrumbs,
  getWorkspaceFolderBreadcrumbs,
  listProjectDocuments,
  listProjectFolders,
  listTeamDocuments,
  listTeamFolders,
  listWorkspaceDocuments,
  listWorkspaceFolders,
  moveProjectDocument,
  moveProjectFolder,
  moveTeamDocument,
  moveTeamFolder,
  moveWorkspaceDocument,
  moveWorkspaceFolder,
  renameProjectFolder,
  renameTeamFolder,
  renameWorkspaceFolder,
  updateProjectDocument,
  updateTeamDocument,
  updateWorkspaceDocument,
} from "../../documents/documents.service.js";
import {
  createDependency as createRoadmapDependency,
  createMilestone,
  cancelDependency,
  getProjectRoadmapDetail,
  hasAnyRoadmapManageAccess,
  hasRoadmapManageAccess,
  listRoadmap,
  reorderMilestones,
  resolveDependency,
  updateMilestone,
  updateProjectSchedule,
} from "../../roadmap/roadmap.service.js";
import {
  createApiKey,
  getApiKeyById,
  listApiKeys,
} from "../../api-key/api-key.service.js";
import {
  findConnectedIntegration,
  getSettings as getIntegrationSettings,
  listIntegrations,
} from "../../integration/integration.service.js";

interface ToolContext {
  workspaceId: string;
  userId: string;
  userRole: string;
  conversationId?: string;
  confirmedHighImpact?: boolean;
  approvedHighImpactToolName?: string;
  approvedHighImpactArgsHash?: string;
}

type LegacyToolResult = {
  success: boolean;
  data: unknown;
  error?: string;
  meta?: Record<string, unknown>;
  warnings?: string[];
  nextSuggestions?: string[];
};

export type ToolExecutorResult = ExecutorResult;

type MutationGuardOptions = {
  persistResult?: (result: LegacyToolResult) => LegacyToolResult;
};

type MutationToolName =
  | "create_issue"
  | "update_issue"
  | "assign_issue"
  | "add_comment"
  | "add_label_to_issue"
  | "create_subtask"
  | "update_subtask"
  | "reorder_subtasks"
  | "add_issue_watchers"
  | "add_issue_dependency"
  | "update_issue_integration_ref"
  | "create_project"
  | "update_project"
  | "invite_member"
  | "create_team"
  | "update_team"
  | "add_team_members"
  | "remove_team_member"
  | "create_department"
  | "update_department"
  | "add_department_members"
  | "remove_department_member"
  | "create_cycle"
  | "update_cycle"
  | "complete_cycle"
  | "reopen_cycle"
  | "carry_over_cycle"
  | "add_project_members"
  | "remove_project_member"
  | "update_workspace"
  | "change_workspace_member_role"
  | "remove_workspace_member"
  | "update_workspace_statuses"
  | "accept_workspace_invite"
  | "create_api_key"
  | "create_template"
  | "update_template"
  | "duplicate_template"
  | "activate_template"
  | "deactivate_template"
  | "reorder_milestones"
  | "resolve_roadmap_dependency"
  | "cancel_roadmap_dependency"
  | "mark_notification_read"
  | "mark_all_notifications_read"
  | "create_document"
  | "create_document_folder"
  | "rename_document_folder"
  | "move_document_folder"
  | "move_document"
  | "update_document"
  | "update_project_schedule"
  | "create_milestone"
  | "update_milestone"
  | "create_roadmap_dependency";

const MUTATION_REPLAY_WINDOW_MS = 10 * 60 * 1000;
const MUTATION_IN_PROGRESS_TTL_MS = 2 * 60 * 1000;
const MAX_AI_EXPORT_ARTIFACT_BYTES = 2 * 1024 * 1024;

// ─── Helpers ────────────────────────────────────────────────────────────────

const resolveUserId = (id: unknown, ctx: ToolContext): string | undefined => {
  if (id === "me") return ctx.userId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};

const isAdmin = (ctx: ToolContext): boolean => ctx.userRole === "OWNER" || ctx.userRole === "ADMIN";

const canWrite = (ctx: ToolContext): boolean => ctx.userRole !== "GUEST";

const str = (v: unknown, fallback = ""): string => {
  const s = typeof v === "string" ? v : fallback;
  // Sanitize: strip control chars, limit length
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").slice(0, 10000);
};

const num = (v: unknown, fallback: number): number => {
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? fallback : n;
};

const analyticsQueryFromArgs = (args: Record<string, unknown>): AnalyticsQuery => {
  const period = str(args.period, "30d");
  const query: AnalyticsQuery = {
    period: period === "7d" || period === "30d" || period === "90d" || period === "custom" ? period : "30d",
  };

  if (typeof args.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.from)) {
    query.from = args.from;
  }
  if (typeof args.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.to)) {
    query.to = args.to;
  }

  return query;
};

const workspaceRole = (ctx: ToolContext): WorkspaceRole => ctx.userRole as WorkspaceRole;

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const toSlug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

/** Resolve due date from various formats: YYYY-MM-DD, "tomorrow", "3 days", "next week" */
const resolveDueDate = (input: string): Date | null => {
  // ISO date format
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const d = new Date(input + "T00:00:00");
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const lower = input.toLowerCase().trim();
  const now = new Date();

  if (lower === "today") return now;
  if (lower === "tomorrow") { now.setDate(now.getDate() + 1); return now; }
  if (lower === "next week") { now.setDate(now.getDate() + 7); return now; }

  const daysMatch = lower.match(/^(\d+)\s*days?(?:\s+(?:later|from now))?$/);
  if (daysMatch) { now.setDate(now.getDate() + parseInt(daysMatch[1]!, 10)); return now; }

  const weeksMatch = lower.match(/^(\d+)\s*weeks?(?:\s+(?:later|from now))?$/);
  if (weeksMatch) { now.setDate(now.getDate() + parseInt(weeksMatch[1]!, 10) * 7); return now; }

  // Try parsing as a date string
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const issueVisibilityWhere = (ctx: ToolContext): Record<string, unknown> =>
  isAdmin(ctx)
    ? {}
    : {
        OR: [
          { project: { visibility: "PUBLIC" } },
          { project: { leadId: ctx.userId } },
          { project: { memberships: { some: { userId: ctx.userId } } } },
        ],
      };

async function assertProjectVisible(projectId: string, ctx: ToolContext): Promise<void> {
  if (isAdmin(ctx)) return;

  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId: ctx.workspaceId },
    select: { visibility: true, leadId: true, memberships: { where: { userId: ctx.userId }, select: { userId: true } } },
  });

  if (!project) {
    throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
  }

  if (
    project.visibility === "PRIVATE" &&
    project.leadId !== ctx.userId &&
    project.memberships.length === 0
  ) {
    throw new AppError(403, "FORBIDDEN", "You don't have access to this project");
  }
}

async function assertTeamVisible(teamId: string, ctx: ToolContext): Promise<void> {
  if (isAdmin(ctx)) return;

  const team = await prisma.team.findFirst({
    where: { id: teamId, workspaceId: ctx.workspaceId },
    select: { visibility: true, leadId: true, memberships: { where: { userId: ctx.userId }, select: { userId: true } } },
  });

  if (!team) {
    throw new AppError(404, "TEAM_NOT_FOUND", "Team not found");
  }

  if (
    team.visibility === "PRIVATE" &&
    team.leadId !== ctx.userId &&
    team.memberships.length === 0
  ) {
    throw new AppError(403, "FORBIDDEN", "You don't have access to this team");
  }
}

async function assertIssueVisible(issueId: string, ctx: ToolContext): Promise<void> {
  const issue = await prisma.issue.findFirst({
    where: {
      id: issueId,
      workspaceId: ctx.workspaceId,
      ...issueVisibilityWhere(ctx),
    },
    select: { id: true },
  });

  if (!issue) {
    throw new AppError(404, "ISSUE_NOT_FOUND", "Issue not found");
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }

  return value;
}

export function buildHighImpactApprovalHash(args: Record<string, unknown>) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(args)))
    .digest("hex");
}

function buildMutationFingerprint(toolName: MutationToolName, args: Record<string, unknown>, ctx: ToolContext) {
  return createHash("sha256")
    .update(JSON.stringify({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      conversationId: ctx.conversationId ?? null,
      toolName,
      args: stableValue(args),
    }))
    .digest("hex");
}

function requireConfirmedHighImpact(
  ctx: ToolContext,
  toolName: MutationToolName,
  args: Record<string, unknown>,
  errorMessage: string,
): LegacyToolResult | null {
  if (!ctx.confirmedHighImpact) {
    return {
      success: false,
      data: null,
      error: errorMessage,
      meta: { confirmationRequired: true },
    };
  }

  if (!ctx.approvedHighImpactToolName || !ctx.approvedHighImpactArgsHash) {
    return {
      success: false,
      data: null,
      error: "This confirmation is no longer valid. Please confirm the exact action again.",
    };
  }

  if (ctx.approvedHighImpactToolName !== toolName || ctx.approvedHighImpactArgsHash !== buildHighImpactApprovalHash(args)) {
    return {
      success: false,
      data: null,
      error: "This confirmation only applies to the exact action you approved. Please confirm this action separately.",
    };
  }

  return null;
}

function sanitizeApiKeyReplayResult(result: LegacyToolResult): LegacyToolResult {
  if (!result.success || !result.data || typeof result.data !== "object") {
    return result;
  }

  const { key: _omittedKey, ...rest } = result.data as Record<string, unknown>;
  return {
    ...result,
    data: {
      ...rest,
      replayNotice: "The API key secret was shown only on the original successful call and is not stored for replay.",
    },
  };
}

function buildMutationWindowKey(now = Date.now()) {
  return String(Math.floor(now / MUTATION_REPLAY_WINDOW_MS));
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function classifyExecutionStatus(result: LegacyToolResult) {
  if (result.success) return "SUCCEEDED";
  if (result.meta?.confirmationRequired) return "CONFIRMATION_REQUIRED";
  return "FAILED";
}

function normalizeExecutorResult(result: LegacyToolResult): ToolExecutorResult {
  return {
    success: result.success,
    payload: result.data,
    warnings: result.warnings ?? [],
    nextSuggestions: result.nextSuggestions ?? [],
    ...(result.error ? { error: result.error } : {}),
    ...(result.meta ? { meta: result.meta } : {}),
  };
}

async function recordAiMutationActivity(input: {
  ctx: ToolContext;
  toolName: MutationToolName;
  targetType: "ISSUE" | "PROJECT" | "WORKSPACE" | "COMMENT" | "LABEL" | "TEAM" | "DEPARTMENT" | "CYCLE" | "DOCUMENT";
  targetId: string;
  message: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await logActivity({
      workspaceId: input.ctx.workspaceId,
      actorId: input.ctx.userId,
      type: "AI_ACTION_EXECUTED",
      targetType: input.targetType,
      targetId: input.targetId,
      message: input.message,
      metadata: {
        source: "AI",
        toolName: input.toolName,
        conversationId: input.ctx.conversationId ?? null,
        ...input.metadata,
      },
    });
  } catch (error) {
    logAiWarn("tool_activity_log_failed", {
      workspaceId: input.ctx.workspaceId,
      userId: input.ctx.userId,
      conversationId: input.ctx.conversationId,
      feature: "chat",
      toolName: input.toolName,
      success: false,
      errorMessage: error instanceof Error ? error.message : "Failed to record AI mutation activity",
    });
  }
}

async function withMutationGuard(
  toolName: MutationToolName,
  args: Record<string, unknown>,
  ctx: ToolContext,
  handler: () => Promise<LegacyToolResult>,
  options?: MutationGuardOptions,
): Promise<LegacyToolResult> {
  const fingerprint = buildMutationFingerprint(toolName, args, ctx);
  const windowKey = buildMutationWindowKey();

  const resolveExistingExecution = async () => {
    const row = await (prisma as any).aiToolExecution.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        fingerprint,
        windowKey,
      },
      select: {
        id: true,
        status: true,
        result: true,
        errorMessage: true,
        createdAt: true,
      },
    });
    if (!row) return null;

    if (row.status === "FAILED") {
      await (prisma as any).aiToolExecution.delete({ where: { id: row.id } }).catch(() => {});
      return null;
    }

    if (row.status === "STARTED") {
      if (row.createdAt.getTime() >= Date.now() - MUTATION_IN_PROGRESS_TTL_MS) {
        return {
          success: false,
          data: null,
          error: "This action is already in progress. Please wait a moment before retrying.",
          meta: {
            replayed: true,
            inProgress: true,
            executionId: row.id,
          },
        } satisfies LegacyToolResult;
      }

      await (prisma as any).aiToolExecution.delete({ where: { id: row.id } }).catch(() => {});
      return null;
    }

    const stored = row.result as LegacyToolResult | null;
    if (stored) {
      logAiInfo("tool_mutation_replayed", {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        feature: "chat",
        toolName,
        success: true,
      });
      return {
        ...stored,
        meta: {
          ...(stored.meta ?? {}),
          replayed: true,
          executionId: row.id,
        },
      } satisfies LegacyToolResult;
    }

    return {
      success: false,
      data: null,
      error: row.errorMessage ?? "This action was already processed recently.",
      meta: {
        replayed: true,
        executionId: row.id,
      },
    } satisfies LegacyToolResult;
  };

  const replayed = await resolveExistingExecution();
  if (replayed) {
    return replayed;
  }

  let executionId: string | null = null;
  try {
    const execution = await (prisma as any).aiToolExecution.create({
      data: {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        conversationId: ctx.conversationId ?? null,
        toolName,
        fingerprint,
        windowKey,
        status: "STARTED",
        result: null,
      },
      select: { id: true },
    });
    executionId = execution.id;
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const fallback = await resolveExistingExecution();
      if (fallback) {
        return fallback;
      }
    }
    throw error;
  }

  try {
    const result = await handler();
    const status = classifyExecutionStatus(result);
    const persistedResult = options?.persistResult ? options.persistResult(result) : result;

    await (prisma as any).aiToolExecution.update({
      where: { id: executionId! },
      data: {
        status,
        result: JSON.parse(JSON.stringify(persistedResult)),
        errorMessage: persistedResult.error ?? null,
        completedAt: new Date(),
      },
    });

    if (status === "FAILED") {
      await (prisma as any).aiToolExecution.delete({ where: { id: executionId! } }).catch(() => {});
    }

    return {
      ...result,
      meta: {
        ...(result.meta ?? {}),
        executionId,
      },
    };
  } catch (error) {
    await (prisma as any).aiToolExecution.update({
      where: { id: executionId! },
      data: {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : "Mutation execution failed",
        completedAt: new Date(),
      },
    }).catch(() => {});
    await (prisma as any).aiToolExecution.delete({ where: { id: executionId! } }).catch(() => {});
    throw error;
  }
}

// ─── Main Executor ──────────────────────────────────────────────────────────

async function executeToolLegacy(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<LegacyToolResult> {
  try {
    switch (toolName) {

      // ═══════════════════════════════════════════════════════════
      // ISSUES
      // ═══════════════════════════════════════════════════════════

      case "list_issues": {
        const limit = Math.min(num(args.limit, 10), 25);
        const query = str(args.q);
        const where: Record<string, unknown> = {
          workspaceId: ctx.workspaceId,
          ...(query
            ? {
                AND: [
                  issueVisibilityWhere(ctx),
                  {
                    OR: [
                      { title: { contains: query, mode: "insensitive" } },
                      { id: { contains: query, mode: "insensitive" } },
                    ],
                  },
                ],
              }
            : issueVisibilityWhere(ctx)),
        };
        // Status can be either Prisma enum (UPPERCASE) or custom status key (kebab-case)
        // Try lowercase kebab first (custom statuses), fall back to uppercase enum
        if (args.status) {
          const statusInput = str(args.status).toLowerCase().replace(/_/g, "-");
          where.status = statusInput;
        }
        if (args.priority) where.priority = str(args.priority).toUpperCase();
        if (args.type) where.type = str(args.type).toUpperCase();
        if (args.assigneeId) where.assigneeId = resolveUserId(args.assigneeId, ctx);
        if (args.overdueOnly === true) {
          where.dueDate = { lt: new Date() };
          where.completedAt = null;
        }
        if (args.projectId) {
          const projectId = str(args.projectId);
          await assertProjectVisible(projectId, ctx);
          where.projectId = projectId;
        }
        if (args.teamId) {
          const teamId = str(args.teamId);
          await assertTeamVisible(teamId, ctx);
          where.teamId = teamId;
        }
        if (args.blockedOnly === true) {
          where.relationsTo = { some: { type: "BLOCKED_BY" } };
        }
        const issues = await prisma.issue.findMany({
          where,
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            type: true,
            dueDate: true,
            assignee: { select: { name: true } },
            project: { select: { name: true } },
            _count: { select: { relationsTo: true } },
          },
          orderBy: args.sort === "priority:desc" ? { priority: "desc" } : { updatedAt: "desc" },
          take: limit,
        });

        return {
          success: true,
          data: issues.map((i) => ({
            id: i.id,
            title: i.title,
            status: i.status,
            priority: i.priority,
            type: i.type,
            assignee: i.assignee?.name ?? "Unassigned",
            project: i.project?.name ?? "—",
            dueDate: i.dueDate?.toISOString() ?? null,
            blockedByCount: i._count.relationsTo,
          })),
          meta: {
            ...(args.overdueOnly === true ? { overdueOnly: true } : {}),
            ...(args.blockedOnly === true ? { blockedOnly: true } : {}),
            ...(args.assigneeId ? { assigneeId: resolveUserId(args.assigneeId, ctx) } : {}),
          },
        };
      }

      case "get_issue": {
        const issue = await prisma.issue.findFirst({
          where: { workspaceId: ctx.workspaceId, id: str(args.issueId), ...issueVisibilityWhere(ctx) },
          select: { id: true, title: true, description: true, status: true, priority: true, type: true, assignee: { select: { id: true, name: true } }, creator: { select: { name: true } }, project: { select: { id: true, name: true } }, team: { select: { name: true } }, labels: { select: { label: { select: { name: true } } } }, createdAt: true, updatedAt: true, completedAt: true },
        });
        if (!issue) return { success: false, data: null, error: `Issue ${args.issueId} not found` };
        return { success: true, data: { ...issue, labels: issue.labels.map((l) => l.label.name) } };
      }

      case "create_issue": {
        if (!canWrite(ctx)) return { success: false, data: null, error: "You don't have permission to create issues" };
        const assigneeId = resolveUserId(args.assigneeId, ctx);
        const description = args.description
          ? str(args.description)
          : `Created via Trussen AI: "${str(args.title)}"`;
        const dueDate = args.dueDate ? resolveDueDate(str(args.dueDate)) : null;
        return withMutationGuard(
          "create_issue",
          {
            title: str(args.title, "Untitled"),
            projectId: str(args.projectId),
            assigneeId: assigneeId ?? null,
            type: str(args.type, "TASK").toUpperCase(),
            priority: str(args.priority, "MEDIUM").toUpperCase(),
            status: args.status ? str(args.status).toLowerCase().replace(/_/g, "-") : null,
            dueDate: dueDate?.toISOString() ?? null,
          },
          ctx,
          async () => {
            const issue = await prisma.$transaction(async (tx) => {
              const project = await tx.project.findFirst({
                where: { id: str(args.projectId), workspaceId: ctx.workspaceId },
                select: { id: true, teamId: true, visibility: true, leadId: true, memberships: { select: { userId: true } } },
              });
              if (!project) return null;

              if (
                project.visibility === "PRIVATE" &&
                !isAdmin(ctx) &&
                project.leadId !== ctx.userId &&
                !project.memberships.some((m) => m.userId === ctx.userId)
              ) {
                throw new AppError(403, "FORBIDDEN", "You don't have access to this project");
              }

              if (assigneeId) {
                const member = await tx.workspaceMembership.findFirst({
                  where: { userId: assigneeId, workspaceId: ctx.workspaceId },
                  select: { userId: true },
                });
                if (!member) {
                  throw new AppError(422, "VALIDATION_ERROR", "Assignee must be a workspace member");
                }
              }

              const workspace = await tx.workspace.update({
                where: { id: ctx.workspaceId },
                data: { issueCounter: { increment: 1 } },
                select: { issuePrefix: true, issueCounter: true, customStatuses: true },
              });

              const issueId = `${workspace.issuePrefix}-${workspace.issueCounter}`;

              let issueStatus = "todo";
              if (args.status) {
                issueStatus = str(args.status).toLowerCase().replace(/_/g, "-");
              } else {
                const statuses = workspace.customStatuses as Array<{ key: string }> | null;
                if (statuses && statuses.length > 1 && statuses[1]) {
                  issueStatus = statuses[1].key;
                }
              }

              return tx.issue.create({
                data: { id: issueId, number: workspace.issueCounter, workspaceId: ctx.workspaceId, projectId: project.id, teamId: project.teamId, title: str(args.title, "Untitled"), type: str(args.type, "TASK").toUpperCase() as "TASK" | "BUG" | "ISSUE", priority: str(args.priority, "MEDIUM").toUpperCase() as "LOW" | "MEDIUM" | "HIGH" | "URGENT", status: issueStatus, description, creatorId: ctx.userId, assigneeId: assigneeId ?? null, dueDate },
                select: { id: true, title: true, status: true, priority: true, type: true, projectId: true, assigneeId: true },
              });
            });

            if (!issue) return { success: false, data: null, error: "Project not found" };

            await recordAiMutationActivity({
              ctx,
              toolName: "create_issue",
              targetType: "ISSUE",
              targetId: issue.id,
              message: `AI created issue ${issue.id}`,
              metadata: {
                issueId: issue.id,
                entityId: issue.id,
                entityTitle: issue.title,
                projectId: issue.projectId,
                assigneeId: issue.assigneeId,
                status: issue.status,
                priority: issue.priority,
              },
            });

            await triggerIssueBackgroundJobs({
              workspaceId: ctx.workspaceId,
              issueId: issue.id,
              triggeredByUserId: ctx.userId,
              reason: "created",
            });

            return { success: true, data: { ...issue, message: `Issue ${issue.id} created` } };
          },
        );
      }

      case "update_issue": {
        if (!canWrite(ctx)) return { success: false, data: null, error: "You don't have permission to update issues" };

        const existing = await prisma.issue.findFirst({
          where: { id: str(args.issueId), workspaceId: ctx.workspaceId, ...issueVisibilityWhere(ctx) },
          select: { id: true, title: true, assigneeId: true, creatorId: true, status: true, priority: true, dueDate: true },
        });
        if (!existing) return { success: false, data: null, error: `Issue ${args.issueId} not found` };

        // Ownership check — MEMBER can only update own issues
        if (!isAdmin(ctx) && existing.assigneeId !== ctx.userId && existing.creatorId !== ctx.userId) {
          return { success: false, data: null, error: "You can only update issues assigned to you or created by you" };
        }

        const data: Record<string, unknown> = {};
        if (args.title) data.title = str(args.title);
        if (args.description) data.description = str(args.description);
        if (args.priority) data.priority = str(args.priority).toUpperCase();
        if (args.type) data.type = str(args.type).toUpperCase();
        if (args.status) {
          // Use kebab-case status keys (matching workspace custom statuses)
          const status = str(args.status).toLowerCase().replace(/_/g, "-");
          data.status = status;
          if (status === "done") data.completedAt = new Date();
          else if (existing.status === "done" || existing.status === "DONE") data.completedAt = null;
        }
        if (args.dueDate) {
          const dueDateStr = str(args.dueDate);
          const resolved = resolveDueDate(dueDateStr);
          if (resolved) data.dueDate = resolved;
        }

        return withMutationGuard(
          "update_issue",
          {
            issueId: existing.id,
            ...data,
          },
          ctx,
          async () => {
            const updated = await prisma.issue.update({
              where: { id: existing.id },
              data,
              select: { id: true, title: true, status: true, priority: true, assigneeId: true, dueDate: true },
            });

            await recordAiMutationActivity({
              ctx,
              toolName: "update_issue",
              targetType: "ISSUE",
              targetId: updated.id,
              message: `AI updated issue ${updated.id}`,
              metadata: {
                issueId: updated.id,
                entityId: updated.id,
                entityTitle: updated.title,
                changedFields: Object.keys(data),
                before: {
                  title: existing.title,
                  status: existing.status,
                  priority: existing.priority,
                  assigneeId: existing.assigneeId,
                  dueDate: existing.dueDate?.toISOString() ?? null,
                },
                after: {
                  title: updated.title,
                  status: updated.status,
                  priority: updated.priority,
                  assigneeId: updated.assigneeId,
                  dueDate: updated.dueDate?.toISOString() ?? null,
                },
              },
            });

            await triggerIssueBackgroundJobs({
              workspaceId: ctx.workspaceId,
              issueId: updated.id,
              triggeredByUserId: ctx.userId,
              reason: "updated",
            });

            return { success: true, data: { ...updated, message: `${existing.id} updated` } };
          },
        );
      }

      case "update_issue_status": {
        return executeToolLegacy(
          "update_issue",
          {
            issueId: args.issueId,
            status: args.status,
          },
          ctx,
        );
      }

      case "assign_issue": {
        if (!canWrite(ctx)) return { success: false, data: null, error: "No permission" };

        const existing = await prisma.issue.findFirst({
          where: { id: str(args.issueId), workspaceId: ctx.workspaceId, ...issueVisibilityWhere(ctx) },
          select: { id: true, assigneeId: true, creatorId: true },
        });
        if (!existing) return { success: false, data: null, error: `Issue ${args.issueId} not found` };

        // MEMBER can only assign their own issues or unassigned issues
        if (!isAdmin(ctx) && existing.assigneeId && existing.assigneeId !== ctx.userId && existing.creatorId !== ctx.userId) {
          return { success: false, data: null, error: "You can only reassign issues assigned to you or created by you" };
        }

        const assigneeId = resolveUserId(args.assigneeId, ctx);
        if (assigneeId) {
          const member = await prisma.workspaceMembership.findFirst({ where: { userId: assigneeId, workspaceId: ctx.workspaceId }, select: { user: { select: { name: true } } } });
          if (!member) return { success: false, data: null, error: "That person is not a workspace member" };
        }

        return withMutationGuard(
          "assign_issue",
          {
            issueId: existing.id,
            assigneeId: assigneeId ?? null,
          },
          ctx,
          async () => {
            await prisma.issue.update({ where: { id: existing.id }, data: { assigneeId: assigneeId ?? null } });

            await recordAiMutationActivity({
              ctx,
              toolName: "assign_issue",
              targetType: "ISSUE",
              targetId: existing.id,
              message: `AI ${assigneeId ? "assigned" : "unassigned"} issue ${existing.id}`,
              metadata: {
                issueId: existing.id,
                entityId: existing.id,
                before: { assigneeId: existing.assigneeId },
                after: { assigneeId: assigneeId ?? null },
              },
            });

            await triggerIssueBackgroundJobs({
              workspaceId: ctx.workspaceId,
              issueId: existing.id,
              triggeredByUserId: ctx.userId,
              reason: "updated",
            });

            return { success: true, data: { issueId: existing.id, message: `${existing.id} ${assigneeId ? "assigned" : "unassigned"}` } };
          },
        );
      }

      case "add_comment": {
        if (!canWrite(ctx)) return { success: false, data: null, error: "No permission" };

        const existing = await prisma.issue.findFirst({
          where: { id: str(args.issueId), workspaceId: ctx.workspaceId, ...issueVisibilityWhere(ctx) },
          select: { id: true },
        });
        if (!existing) return { success: false, data: null, error: `Issue ${args.issueId} not found` };

        const commentBody = str(args.body).slice(0, 50000); // Max comment length
        if (!commentBody) return { success: false, data: null, error: "Comment body is empty" };

        return withMutationGuard(
          "add_comment",
          {
            issueId: existing.id,
            body: commentBody,
          },
          ctx,
          async () => {
            const comment = await prisma.comment.create({
              data: { issueId: existing.id, authorId: ctx.userId, body: commentBody },
              select: { id: true },
            });

            await recordAiMutationActivity({
              ctx,
              toolName: "add_comment",
              targetType: "COMMENT",
              targetId: comment.id,
              message: `AI added a comment to ${existing.id}`,
              metadata: {
                issueId: existing.id,
                commentId: comment.id,
                entityId: existing.id,
              },
            });

            return { success: true, data: { issueId: existing.id, commentId: comment.id, message: `Comment added to ${existing.id}` } };
          },
        );
      }

      case "add_label_to_issue": {
        if (!canWrite(ctx)) return { success: false, data: null, error: "No permission" };

        const existing = await prisma.issue.findFirst({
          where: { id: str(args.issueId), workspaceId: ctx.workspaceId, ...issueVisibilityWhere(ctx) },
          select: { id: true },
        });
        if (!existing) return { success: false, data: null, error: `Issue ${args.issueId} not found` };

        const label = await prisma.label.findFirst({ where: { workspaceId: ctx.workspaceId, name: { equals: str(args.labelName), mode: "insensitive" } }, select: { id: true, name: true } });
        if (!label) return { success: false, data: null, error: `Label "${args.labelName}" not found` };

        return withMutationGuard(
          "add_label_to_issue",
          {
            issueId: existing.id,
            labelId: label.id,
          },
          ctx,
          async () => {
            await prisma.issueLabel.upsert({ where: { issueId_labelId: { issueId: existing.id, labelId: label.id } }, create: { issueId: existing.id, labelId: label.id }, update: {} });

            await recordAiMutationActivity({
              ctx,
              toolName: "add_label_to_issue",
              targetType: "ISSUE",
              targetId: existing.id,
              message: `AI added label "${label.name}" to ${existing.id}`,
              metadata: {
                issueId: existing.id,
                entityId: existing.id,
                labelId: label.id,
                labelName: label.name,
              },
            });

            await triggerIssueBackgroundJobs({
              workspaceId: ctx.workspaceId,
              issueId: existing.id,
              triggeredByUserId: ctx.userId,
              reason: "updated",
            });

            return { success: true, data: { issueId: existing.id, label: label.name, message: `Label "${label.name}" added to ${existing.id}` } };
          },
        );
      }

      case "create_subtask": {
        if (!canWrite(ctx)) return { success: false, data: null, error: "No permission" };

        const issueId = str(args.issueId);
        const title = str(args.title).trim();
        if (!issueId) return { success: false, data: null, error: "issueId is required" };
        if (!title) return { success: false, data: null, error: "Subtask title is required" };
        await assertIssueVisible(issueId, ctx);

        return withMutationGuard(
          "create_subtask",
          { issueId, title, order: args.order ? num(args.order, 0) : null },
          ctx,
          async () => {
            const subtask = await createSubtask(ctx.workspaceId, issueId, {
              title,
              ...(args.order ? { order: num(args.order, 0) } : {}),
            });

            await recordAiMutationActivity({
              ctx,
              toolName: "create_subtask",
              targetType: "ISSUE",
              targetId: issueId,
              message: `AI created a subtask on ${issueId}`,
              metadata: {
                issueId,
                subtaskId: subtask.id,
                entityId: issueId,
                entityTitle: title,
              },
            });

            await triggerIssueBackgroundJobs({
              workspaceId: ctx.workspaceId,
              issueId,
              triggeredByUserId: ctx.userId,
              reason: "updated",
            });

            return { success: true, data: { id: subtask.id, issueId, title: subtask.title, completed: subtask.completed, order: subtask.order } };
          },
        );
      }

      case "update_subtask": {
        if (!canWrite(ctx)) return { success: false, data: null, error: "No permission" };

        const issueId = str(args.issueId);
        const subtaskId = str(args.subtaskId);
        if (!issueId) return { success: false, data: null, error: "issueId is required" };
        if (!subtaskId) return { success: false, data: null, error: "subtaskId is required" };
        await assertIssueVisible(issueId, ctx);

        const completed =
          typeof args.completed === "string"
            ? args.completed.toLowerCase() === "true"
            : typeof args.completed === "boolean"
              ? args.completed
              : undefined;

        return withMutationGuard(
          "update_subtask",
          {
            issueId,
            subtaskId,
            title: args.title ? str(args.title).trim() : null,
            completed: completed ?? null,
            order: args.order ? num(args.order, 0) : null,
          },
          ctx,
          async () => {
            const subtask = await updateSubtask(ctx.workspaceId, issueId, subtaskId, {
              ...(args.title ? { title: str(args.title).trim() } : {}),
              ...(completed !== undefined ? { completed } : {}),
              ...(args.order ? { order: num(args.order, 0) } : {}),
            });

            await recordAiMutationActivity({
              ctx,
              toolName: "update_subtask",
              targetType: "ISSUE",
              targetId: issueId,
              message: `AI updated a subtask on ${issueId}`,
              metadata: {
                issueId,
                subtaskId: subtask.id,
                entityId: issueId,
                changedFields: Object.keys(args).filter((key) => !["issueId", "subtaskId"].includes(key)),
              },
            });

            await triggerIssueBackgroundJobs({
              workspaceId: ctx.workspaceId,
              issueId,
              triggeredByUserId: ctx.userId,
              reason: "updated",
            });

            return { success: true, data: { id: subtask.id, issueId, title: subtask.title, completed: subtask.completed, order: subtask.order } };
          },
        );
      }

      case "reorder_subtasks": {
        if (!canWrite(ctx)) return { success: false, data: null, error: "No permission" };

        const issueId = str(args.issueId);
        if (!issueId) return { success: false, data: null, error: "issueId is required" };
        await assertIssueVisible(issueId, ctx);

        const items = parseJsonArray(args.itemsJson)
          .map((item) => item && typeof item === "object" ? item as Record<string, unknown> : null)
          .filter((item): item is Record<string, unknown> => Boolean(item))
          .map((item) => ({ id: str(item.id), order: num(item.order, 0) }))
          .filter((item) => item.id.length > 0)
          .slice(0, 100);

        if (items.length === 0) return { success: false, data: null, error: "itemsJson must contain at least one {id, order} object" };

        return withMutationGuard(
          "reorder_subtasks",
          { issueId, items },
          ctx,
          async () => {
            const subtasks = await reorderSubtasks(ctx.workspaceId, issueId, items);

            await recordAiMutationActivity({
              ctx,
              toolName: "reorder_subtasks",
              targetType: "ISSUE",
              targetId: issueId,
              message: `AI reordered subtasks on ${issueId}`,
              metadata: {
                issueId,
                entityId: issueId,
                subtaskIds: items.map((item) => item.id),
              },
            });

            await triggerIssueBackgroundJobs({
              workspaceId: ctx.workspaceId,
              issueId,
              triggeredByUserId: ctx.userId,
              reason: "updated",
            });

            return { success: true, data: subtasks.map((subtask) => ({ id: subtask.id, title: subtask.title, completed: subtask.completed, order: subtask.order })) };
          },
        );
      }

      case "add_issue_watchers": {
        if (!canWrite(ctx)) return { success: false, data: null, error: "No permission" };

        const issueId = str(args.issueId);
        if (!issueId) return { success: false, data: null, error: "issueId is required" };
        await assertIssueVisible(issueId, ctx);

        const userIds = parseJsonArray(args.userIdsJson)
          .map((value) => resolveUserId(value, ctx))
          .filter((value): value is string => Boolean(value))
          .slice(0, 50);

        if (userIds.length === 0) return { success: false, data: null, error: "userIdsJson must contain at least one user ID" };

        return withMutationGuard(
          "add_issue_watchers",
          { issueId, userIds },
          ctx,
          async () => {
            const result = await addWatchers(ctx.workspaceId, issueId, userIds, ctx.userId);

            await recordAiMutationActivity({
              ctx,
              toolName: "add_issue_watchers",
              targetType: "ISSUE",
              targetId: issueId,
              message: `AI added watchers to ${issueId}`,
              metadata: {
                issueId,
                entityId: issueId,
                userIds,
              },
            });

            return { success: true, data: { issueId, added: result.added } };
          },
        );
      }

      case "list_issue_watchers": {
        const issueId = str(args.issueId);
        if (!issueId) return { success: false, data: null, error: "issueId is required" };
        await assertIssueVisible(issueId, ctx);

        const watchers = await listWatchers(ctx.workspaceId, issueId);
        return { success: true, data: { issueId, watchers } };
      }

      case "add_issue_dependency": {
        if (!canWrite(ctx)) return { success: false, data: null, error: "No permission" };

        const issueId = str(args.issueId);
        const relatedIssueId = str(args.relatedIssueId);
        const relationInput = str(args.relation, "related");
        const relation = relationInput === "blocks" || relationInput === "blocked-by" ? relationInput : "related";
        if (!issueId) return { success: false, data: null, error: "issueId is required" };
        if (!relatedIssueId) return { success: false, data: null, error: "relatedIssueId is required" };
        await assertIssueVisible(issueId, ctx);
        await assertIssueVisible(relatedIssueId, ctx);

        return withMutationGuard(
          "add_issue_dependency",
          { issueId, relatedIssueId, relation },
          ctx,
          async () => {
            const dependency = await addDependency(ctx.workspaceId, issueId, relatedIssueId, relation, ctx.userId);

            await recordAiMutationActivity({
              ctx,
              toolName: "add_issue_dependency",
              targetType: "ISSUE",
              targetId: issueId,
              message: `AI added an issue dependency on ${issueId}`,
              metadata: {
                issueId,
                relatedIssueId,
                relation,
                entityId: issueId,
              },
            });

            await triggerIssueBackgroundJobs({
              workspaceId: ctx.workspaceId,
              issueId,
              triggeredByUserId: ctx.userId,
              reason: "updated",
            });

            return { success: true, data: dependency };
          },
        );
      }

      case "update_issue_integration_ref": {
        if (!canWrite(ctx)) return { success: false, data: null, error: "No permission" };

        const issueId = str(args.issueId);
        const provider = str(args.provider);
        if (!issueId) return { success: false, data: null, error: "issueId is required" };
        if (!provider) return { success: false, data: null, error: "provider is required" };
        await assertIssueVisible(issueId, ctx);

        const integrationRef = {
          provider,
          ...(args.label ? { label: str(args.label).slice(0, 100) } : {}),
          ...(args.externalId ? { externalId: str(args.externalId).slice(0, 255) } : {}),
          ...(args.url ? { url: str(args.url).slice(0, 500) } : {}),
        };

        return withMutationGuard(
          "update_issue_integration_ref",
          { issueId, integrationRef },
          ctx,
          async () => {
            await updateIntegrationRefs(ctx.workspaceId, issueId, [
              {
                id: "ai-ref",
                provider: integrationRef.provider,
                label: integrationRef.label ?? null,
                externalId: integrationRef.externalId ?? null,
                url: integrationRef.url ?? null,
              },
            ], ctx.userId);

            await recordAiMutationActivity({
              ctx,
              toolName: "update_issue_integration_ref",
              targetType: "ISSUE",
              targetId: issueId,
              message: `AI linked an integration reference on ${issueId}`,
              metadata: {
                issueId,
                entityId: issueId,
                integrationRef,
              },
            });

            await triggerIssueBackgroundJobs({
              workspaceId: ctx.workspaceId,
              issueId,
              triggeredByUserId: ctx.userId,
              reason: "updated",
            });

            return { success: true, data: { issueId, integrationRefs: [integrationRef] } };
          },
        );
      }

      // ═══════════════════════════════════════════════════════════
      // PROJECTS
      // ═══════════════════════════════════════════════════════════

      case "list_projects": {
        const limit = Math.min(num(args.limit, 10), 25);

        // Get user's project memberships for visibility filtering
        const userProjectIds = await prisma.projectMembership.findMany({ where: { userId: ctx.userId }, select: { projectId: true } });
        const memberProjectIds = new Set(userProjectIds.map((p) => p.projectId));

        const where: Record<string, unknown> = { workspaceId: ctx.workspaceId };
        if (args.status) where.status = str(args.status);
        if (args.teamId) where.teamId = str(args.teamId);
        if (args.q) where.name = { contains: str(args.q), mode: "insensitive" };

        const projects = await prisma.project.findMany({
          where, select: { id: true, name: true, status: true, visibility: true, _count: { select: { issues: true } } },
          orderBy: { name: "asc" }, take: limit,
        });

        // Filter private projects — only show if user is a member or admin
        const visible = projects.filter((p) => p.visibility === "PUBLIC" || isAdmin(ctx) || memberProjectIds.has(p.id));
        return { success: true, data: visible.map((p) => ({ id: p.id, name: p.name, status: p.status, issueCount: p._count.issues })) };
      }

      case "get_project_summary": {
        const project = await prisma.project.findFirst({
          where: { id: str(args.projectId), workspaceId: ctx.workspaceId },
          select: { id: true, name: true, status: true, description: true, visibility: true, lead: { select: { name: true } }, team: { select: { name: true } }, memberships: { select: { userId: true } } },
        });
        if (!project) return { success: false, data: null, error: "Project not found" };

        // Visibility check
        if (project.visibility === "PRIVATE" && !isAdmin(ctx) && !project.memberships.some((m) => m.userId === ctx.userId)) {
          return { success: false, data: null, error: "You don't have access to this project" };
        }

        const statusCounts = await prisma.issue.groupBy({ by: ["status"], where: { projectId: project.id, workspaceId: ctx.workspaceId }, _count: true });
        const stats = Object.fromEntries(statusCounts.map((s) => [s.status, s._count]));
        const totalIssues = statusCounts.reduce((sum, entry) => sum + Number(entry._count ?? 0), 0);
        const doneIssues = Number((stats as Record<string, number>).done ?? 0);
        const openIssues = Math.max(0, totalIssues - doneIssues);

        return {
          success: true,
          data: { id: project.id, name: project.name, status: project.status, description: project.description, lead: project.lead?.name ?? "None", team: project.team.name, issuesByStatus: stats },
          meta: {
            scope: "project",
            scopeId: project.id,
            report: `${project.name} is ${String(project.status ?? "unknown").toLowerCase()}. ${openIssues} open issue${openIssues === 1 ? "" : "s"}, ${doneIssues} done. Team: ${project.team.name}. Lead: ${project.lead?.name ?? "None"}.`,
          },
        };
      }

      case "create_project": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can create projects" };

        const team = await prisma.team.findFirst({ where: { id: str(args.teamId), workspaceId: ctx.workspaceId }, select: { id: true, departmentId: true } });
        if (!team) return { success: false, data: null, error: "Team not found" };

        const name = str(args.name, "New Project");
        const slug = toSlug(name) || `project-${Date.now()}`;

        return withMutationGuard(
          "create_project",
          {
            teamId: team.id,
            name,
            slug,
            description: args.description ? str(args.description) : null,
          },
          ctx,
          async () => {
            const project = await prisma.project.create({
              data: { workspaceId: ctx.workspaceId, teamId: team.id, departmentId: team.departmentId, name, slug, description: args.description ? str(args.description) : null, leadId: ctx.userId },
              select: { id: true, name: true, slug: true, teamId: true, departmentId: true },
            });

            invalidateContextCache(ctx.workspaceId);
            await upsertEntityAliases({
              workspaceId: ctx.workspaceId,
              entityType: "PROJECT",
              entityId: project.id,
              aliases: [project.name],
            });
            await enqueueEmbedding({
              workspaceId: ctx.workspaceId,
              entityType: "PROJECT",
              entityId: project.id,
              triggeredByUserId: ctx.userId,
              reason: "created",
            });
            await recordAiMutationActivity({
              ctx,
              toolName: "create_project",
              targetType: "PROJECT",
              targetId: project.id,
              message: `AI created project "${project.name}"`,
              metadata: {
                projectId: project.id,
                entityId: project.id,
                entityTitle: project.name,
                teamId: project.teamId,
                departmentId: project.departmentId,
              },
            });

            return { success: true, data: { ...project, message: `Project "${project.name}" created` } };
          },
        );
      }

      case "update_project": {
        const project = await prisma.project.findFirst({
          where: { id: str(args.projectId), workspaceId: ctx.workspaceId },
          select: { id: true, leadId: true },
        });
        if (!project) return { success: false, data: null, error: "Project not found" };

        if (!isAdmin(ctx) && project.leadId !== ctx.userId) {
          return { success: false, data: null, error: "Only admins, owners, or the project lead can update this project" };
        }

        const data: Record<string, unknown> = {};
        if (args.name) data.name = str(args.name);
        if (args.description !== undefined) data.description = str(args.description) || null;
        if (args.status) {
          const status = str(args.status).toUpperCase();
          if (status === "ARCHIVED" || status === "COMPLETED") {
            const confirmationError = requireConfirmedHighImpact(
              ctx,
              "update_project",
              {
                projectId: project.id,
                ...(data.name !== undefined ? { name: data.name } : {}),
                ...(data.description !== undefined ? { description: data.description } : {}),
                status,
              },
              "Changing a project to archived or completed requires explicit confirmation first.",
            );
            if (confirmationError) return confirmationError;
          }
          data.status = status;
        }

        return withMutationGuard(
          "update_project",
          {
            projectId: project.id,
            ...data,
          },
          ctx,
          async () => {
            const updated = await prisma.project.update({ where: { id: project.id }, data, select: { id: true, name: true, status: true } });

            invalidateContextCache(ctx.workspaceId);
            await upsertEntityAliases({
              workspaceId: ctx.workspaceId,
              entityType: "PROJECT",
              entityId: updated.id,
              aliases: [updated.name],
            });
            await enqueueEmbedding({
              workspaceId: ctx.workspaceId,
              entityType: "PROJECT",
              entityId: updated.id,
              triggeredByUserId: ctx.userId,
              reason: "updated",
            });
            await recordAiMutationActivity({
              ctx,
              toolName: "update_project",
              targetType: "PROJECT",
              targetId: updated.id,
              message: `AI updated project "${updated.name}"`,
              metadata: {
                projectId: updated.id,
                entityId: updated.id,
                entityTitle: updated.name,
                changedFields: Object.keys(data),
                status: updated.status,
              },
            });

            return { success: true, data: { ...updated, message: `Project "${updated.name}" updated` } };
          },
        );
      }

      case "list_project_members": {
        const projectId = str(args.projectId);
        if (!projectId) return { success: false, data: null, error: "projectId is required" };
        const result = await listProjectMembers(ctx.workspaceId, workspaceRole(ctx), ctx.userId, projectId, {
          limit: Math.min(num(args.limit, 50), 100),
          view: "compact",
        });
        return { success: true, data: result.items, meta: result.meta };
      }

      case "add_project_members": {
        const projectId = str(args.projectId);
        const userIds = parseJsonArray(args.userIdsJson).map((entry) => String(entry)).filter(Boolean);
        if (!projectId || userIds.length === 0) return { success: false, data: null, error: "projectId and userIdsJson are required" };

        const ownership = await getProjectOwnership(ctx.workspaceId, projectId);
        if (!ownership.exists) return { success: false, data: null, error: "Project not found" };
        if (!isAdmin(ctx) && ownership.ownerId !== ctx.userId) {
          return { success: false, data: null, error: "You do not have permission to manage this project" };
        }

        return withMutationGuard(
          "add_project_members",
          { projectId, userIds },
          ctx,
          async () => {
            const added = await addProjectMembers(ctx.workspaceId, projectId, ctx.userId, { userIds });
            await recordAiMutationActivity({
              ctx,
              toolName: "add_project_members",
              targetType: "PROJECT",
              targetId: projectId,
              message: `AI added ${userIds.length} project member(s)`,
              metadata: { projectId, addedUserIds: added.added },
            });
            return { success: true, data: added };
          },
        );
      }

      case "remove_project_member": {
        const projectId = str(args.projectId);
        const userId = resolveUserId(args.userId, ctx);
        if (!projectId || !userId) return { success: false, data: null, error: "projectId and userId are required" };
        const confirmationError = requireConfirmedHighImpact(
          ctx,
          "remove_project_member",
          { projectId, userId },
          "Removing a project member requires explicit confirmation first.",
        );
        if (confirmationError) return confirmationError;

        const ownership = await getProjectOwnership(ctx.workspaceId, projectId);
        if (!ownership.exists) return { success: false, data: null, error: "Project not found" };
        if (!isAdmin(ctx) && ownership.ownerId !== ctx.userId) {
          return { success: false, data: null, error: "You do not have permission to manage this project" };
        }

        return withMutationGuard(
          "remove_project_member",
          { projectId, userId },
          ctx,
          async () => {
            await removeProjectMember(ctx.workspaceId, projectId, ctx.userId, userId);
            await recordAiMutationActivity({
              ctx,
              toolName: "remove_project_member",
              targetType: "PROJECT",
              targetId: projectId,
              message: "AI removed a project member",
              metadata: { projectId, removedUserId: userId },
            });
            return { success: true, data: { projectId, userId, message: "Project member removed" } };
          },
        );
      }

      case "get_workspace": {
        const workspace = await getWorkspaceById(ctx.workspaceId);
        return { success: true, data: workspace };
      }

      case "update_workspace": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can update workspace settings" };

        return withMutationGuard(
          "update_workspace",
          {
            name: args.name ? str(args.name) : null,
            logo: args.logo ? str(args.logo) : null,
          },
          ctx,
          async () => {
            const updated = await updateWorkspace(ctx.workspaceId, {
              ...(args.name !== undefined ? { name: str(args.name) } : {}),
              ...(args.logo !== undefined ? { logo: str(args.logo) } : {}),
            });
            invalidateContextCache(ctx.workspaceId);
            await recordAiMutationActivity({
              ctx,
              toolName: "update_workspace",
              targetType: "WORKSPACE",
              targetId: ctx.workspaceId,
              message: `AI updated workspace "${updated.name}"`,
              metadata: { workspaceId: ctx.workspaceId, entityId: ctx.workspaceId, entityTitle: updated.name },
            });
            return { success: true, data: updated };
          },
        );
      }

      case "list_workspace_members": {
        const result = await listWorkspaceMembers(ctx.workspaceId, {
          ...(args.q ? { q: str(args.q) } : {}),
          ...(args.role ? { role: str(args.role).toUpperCase() as WorkspaceRole } : {}),
          limit: Math.min(num(args.limit, 50), 100),
          view: "compact",
        });
        return { success: true, data: result.items, meta: result.meta };
      }

      case "change_workspace_member_role": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can change workspace roles" };
        const userId = resolveUserId(args.userId, ctx);
        const role = str(args.role).toUpperCase();
        if (!userId || !role) return { success: false, data: null, error: "userId and role are required" };
        const confirmationError = requireConfirmedHighImpact(
          ctx,
          "change_workspace_member_role",
          { userId, role },
          "Changing a workspace member role requires explicit confirmation first.",
        );
        if (confirmationError) return confirmationError;

        return withMutationGuard(
          "change_workspace_member_role",
          { userId, role },
          ctx,
          async () => {
            const updated = await changeMemberRole(ctx.workspaceId, userId, role as Exclude<WorkspaceRole, "OWNER">);
            await recordAiMutationActivity({
              ctx,
              toolName: "change_workspace_member_role",
              targetType: "WORKSPACE",
              targetId: ctx.workspaceId,
              message: `AI changed a workspace member role`,
              metadata: { workspaceId: ctx.workspaceId, targetUserId: userId, newRole: role },
            });
            return { success: true, data: updated };
          },
        );
      }

      case "remove_workspace_member": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can remove workspace members" };
        const userId = resolveUserId(args.userId, ctx);
        if (!userId) return { success: false, data: null, error: "userId is required" };
        const confirmationError = requireConfirmedHighImpact(
          ctx,
          "remove_workspace_member",
          { userId },
          "Removing a workspace member requires explicit confirmation first.",
        );
        if (confirmationError) return confirmationError;

        return withMutationGuard(
          "remove_workspace_member",
          { userId },
          ctx,
          async () => {
            await removeWorkspaceMember(ctx.workspaceId, userId);
            await recordAiMutationActivity({
              ctx,
              toolName: "remove_workspace_member",
              targetType: "WORKSPACE",
              targetId: ctx.workspaceId,
              message: "AI removed a workspace member",
              metadata: { workspaceId: ctx.workspaceId, removedUserId: userId },
            });
            return { success: true, data: { userId, message: "Workspace member removed" } };
          },
        );
      }

      case "update_workspace_statuses": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can update workspace statuses" };
        let statuses: unknown[];
        try {
          statuses = JSON.parse(str(args.statusesJson));
        } catch {
          return { success: false, data: null, error: "statusesJson must be valid JSON" };
        }
        if (!Array.isArray(statuses)) return { success: false, data: null, error: "statusesJson must be a JSON array" };

        const confirmationError = requireConfirmedHighImpact(
          ctx,
          "update_workspace_statuses",
          { statuses },
          "Updating workspace statuses requires explicit confirmation first.",
        );
        if (confirmationError) return confirmationError;

        return withMutationGuard(
          "update_workspace_statuses",
          { statuses },
          ctx,
          async () => {
            const updated = await updateWorkspaceStatuses(ctx.workspaceId, statuses as any);
            await recordAiMutationActivity({
              ctx,
              toolName: "update_workspace_statuses",
              targetType: "WORKSPACE",
              targetId: ctx.workspaceId,
              message: "AI updated workspace statuses",
              metadata: { workspaceId: ctx.workspaceId, statusCount: updated.length },
            });
            return { success: true, data: updated };
          },
        );
      }

      case "list_user_workspaces": {
        const items = await listWorkspaces(ctx.userId);
        return { success: true, data: items };
      }

      case "get_workspace_access_summary": {
        const [workspaces, pendingInvites, currentWorkspace] = await Promise.all([
          listWorkspaces(ctx.userId),
          listPendingInvitationsForUser(ctx.userId),
          getWorkspaceById(ctx.workspaceId),
        ]);

        const activeWorkspace = workspaces.find((workspace) => workspace.id === ctx.workspaceId) ?? null;

        return {
          success: true,
          data: {
            activeWorkspace: activeWorkspace ?? {
              id: currentWorkspace.id,
              name: currentWorkspace.name,
              slug: currentWorkspace.slug,
              role: ctx.userRole,
            },
            accessibleWorkspaces: workspaces.map((workspace) => ({
              id: workspace.id,
              name: workspace.name,
              slug: workspace.slug,
              role: workspace.role,
              unreadNotifications: workspace.unreadNotifications,
            })),
            pendingInvites: pendingInvites.map((invite) => ({
              id: invite.id,
              workspace: invite.workspace,
              role: invite.role,
              team: invite.team,
              department: invite.department,
              expiresAt: invite.expiresAt,
            })),
          },
          meta: {
            activeWorkspaceId: ctx.workspaceId,
            workspaceCount: workspaces.length,
            pendingInviteCount: pendingInvites.length,
          },
        };
      }

      case "remove_member": {
        if (typeof args.teamId === "string" && args.teamId) {
          return executeToolLegacy("remove_team_member", { teamId: args.teamId, userId: args.userId }, ctx);
        }
        if (typeof args.projectId === "string" && args.projectId) {
          return executeToolLegacy("remove_project_member", { projectId: args.projectId, userId: args.userId }, ctx);
        }
        if (typeof args.departmentId === "string" && args.departmentId) {
          return executeToolLegacy("remove_department_member", { departmentId: args.departmentId, userId: args.userId }, ctx);
        }
        return executeToolLegacy("remove_workspace_member", { userId: args.userId }, ctx);
      }

      case "list_pending_workspace_invites": {
        const items = await listPendingInvitationsForUser(ctx.userId);
        return { success: true, data: items };
      }

      case "accept_workspace_invite": {
        const invitationId = str(args.invitationId);
        if (!invitationId) return { success: false, data: null, error: "invitationId is required" };

        return withMutationGuard(
          "accept_workspace_invite",
          { invitationId },
          ctx,
          async () => {
            const result = await acceptInvitationById(invitationId, ctx.userId);
            invalidateContextCache(result.workspace.id);
            await recordAiMutationActivity({
              ctx,
              toolName: "accept_workspace_invite",
              targetType: "WORKSPACE",
              targetId: result.workspace.id,
              message: `AI accepted workspace invitation for "${result.workspace.name}"`,
              metadata: {
                workspaceId: result.workspace.id,
                workspaceSlug: result.workspace.slug,
                role: result.role,
                alreadyAccepted: result.alreadyAccepted,
              },
            });
            return { success: true, data: result };
          },
        );
      }

      case "list_workspace_invitations": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can list workspace invitations" };
        const items = await listInvitations(ctx.workspaceId);
        return { success: true, data: items };
      }

      // ═══════════════════════════════════════════════════════════
      // TEAMS & MEMBERS
      // ═══════════════════════════════════════════════════════════

      case "list_teams": {
        const result = await listTeamsService(ctx.workspaceId, workspaceRole(ctx), {
          ...(args.q ? { q: str(args.q) } : {}),
          limit: Math.min(num(args.limit, 20), 50),
          view: "compact",
        });
        return { success: true, data: result.items, meta: result.meta };
      }

      case "get_team": {
        const teamId = str(args.teamId);
        if (!teamId) return { success: false, data: null, error: "teamId is required" };

        const team = await getTeamById(ctx.workspaceId, workspaceRole(ctx), teamId);
        return { success: true, data: team };
      }

      case "create_team": {
        if (ctx.userRole === "GUEST") return { success: false, data: null, error: "Guests cannot create teams" };

        const name = str(args.name);
        const leadId = resolveUserId(args.leadId, ctx);
        if (!name || !leadId) return { success: false, data: null, error: "name and leadId are required" };

        return withMutationGuard(
          "create_team",
          {
            name,
            leadId,
            departmentId: args.departmentId ? str(args.departmentId) : null,
            description: args.description ? str(args.description) : null,
            visibility: args.visibility ? str(args.visibility).toUpperCase() : "PUBLIC",
            memberIdsJson: parseJsonArray(args.memberIdsJson),
          },
          ctx,
          async () => {
            const team = await createTeam(ctx.workspaceId, ctx.userId, {
              name,
              leadId,
              ...(args.departmentId ? { departmentId: str(args.departmentId) } : {}),
              ...(args.description ? { description: str(args.description) } : {}),
              ...(args.visibility ? { visibility: str(args.visibility).toUpperCase() as "PUBLIC" | "PRIVATE" } : {}),
              ...(Array.isArray(parseJsonArray(args.memberIdsJson)) ? { memberIds: parseJsonArray(args.memberIdsJson).map((entry) => String(entry)) } : {}),
            });

            invalidateContextCache(ctx.workspaceId);
            await upsertEntityAliases({
              workspaceId: ctx.workspaceId,
              entityType: "TEAM",
              entityId: team.id,
              aliases: [team.name],
            });
            await enqueueEmbedding({
              workspaceId: ctx.workspaceId,
              entityType: "TEAM",
              entityId: team.id,
              triggeredByUserId: ctx.userId,
              reason: "created",
            });
            await recordAiMutationActivity({
              ctx,
              toolName: "create_team",
              targetType: "TEAM",
              targetId: team.id,
              message: `AI created team "${team.name}"`,
              metadata: {
                teamId: team.id,
                entityId: team.id,
                entityTitle: team.name,
                leadId: team.lead?.id ?? leadId,
              },
            });

            return { success: true, data: team };
          },
        );
      }

      case "update_team": {
        const teamId = str(args.teamId);
        if (!teamId) return { success: false, data: null, error: "teamId is required" };

        const ownership = await getTeamOwnership(ctx.workspaceId, teamId);
        if (!ownership.exists) return { success: false, data: null, error: "Team not found" };
        if (!isAdmin(ctx) && ownership.ownerId !== ctx.userId) {
          return { success: false, data: null, error: "You do not have permission to update this team" };
        }

        return withMutationGuard(
          "update_team",
          {
            teamId,
            name: args.name ? str(args.name) : null,
            leadId: args.leadId ? resolveUserId(args.leadId, ctx) : null,
            departmentId: args.departmentId === "" ? null : (args.departmentId ? str(args.departmentId) : undefined),
            description: args.description !== undefined ? str(args.description) : undefined,
            visibility: args.visibility ? str(args.visibility).toUpperCase() : null,
          },
          ctx,
          async () => {
            const updated = await updateTeam(ctx.workspaceId, teamId, {
              ...(args.name ? { name: str(args.name) } : {}),
              ...(args.leadId ? { leadId: resolveUserId(args.leadId, ctx)! } : {}),
              ...(args.departmentId !== undefined ? { departmentId: str(args.departmentId) || null } : {}),
              ...(args.description !== undefined ? { description: str(args.description) || null } : {}),
              ...(args.visibility ? { visibility: str(args.visibility).toUpperCase() as "PUBLIC" | "PRIVATE" } : {}),
            });

            invalidateContextCache(ctx.workspaceId);
            await upsertEntityAliases({
              workspaceId: ctx.workspaceId,
              entityType: "TEAM",
              entityId: updated.id,
              aliases: [updated.name],
            });
            await enqueueEmbedding({
              workspaceId: ctx.workspaceId,
              entityType: "TEAM",
              entityId: updated.id,
              triggeredByUserId: ctx.userId,
              reason: "updated",
            });
            await recordAiMutationActivity({
              ctx,
              toolName: "update_team",
              targetType: "TEAM",
              targetId: updated.id,
              message: `AI updated team "${updated.name}"`,
              metadata: {
                teamId: updated.id,
                entityId: updated.id,
                entityTitle: updated.name,
              },
            });

            return { success: true, data: updated };
          },
        );
      }

      case "add_team_members": {
        const teamId = str(args.teamId);
        const userIds = parseJsonArray(args.userIdsJson).map((entry) => String(entry)).filter(Boolean);
        if (!teamId || userIds.length === 0) return { success: false, data: null, error: "teamId and userIdsJson are required" };

        const ownership = await getTeamOwnership(ctx.workspaceId, teamId);
        if (!ownership.exists) return { success: false, data: null, error: "Team not found" };
        if (!isAdmin(ctx) && ownership.ownerId !== ctx.userId) {
          return { success: false, data: null, error: "You do not have permission to manage this team" };
        }

        return withMutationGuard(
          "add_team_members",
          { teamId, userIds },
          ctx,
          async () => {
            const added = await addTeamMembers(ctx.workspaceId, teamId, ctx.userId, { userIds });
            await recordAiMutationActivity({
              ctx,
              toolName: "add_team_members",
              targetType: "TEAM",
              targetId: teamId,
              message: `AI added ${userIds.length} team member(s)`,
              metadata: { teamId, addedUserIds: added.added },
            });
            return { success: true, data: added };
          },
        );
      }

      case "remove_team_member": {
        const teamId = str(args.teamId);
        const userId = resolveUserId(args.userId, ctx);
        if (!teamId || !userId) return { success: false, data: null, error: "teamId and userId are required" };
        const confirmationError = requireConfirmedHighImpact(
          ctx,
          "remove_team_member",
          { teamId, userId },
          "Removing a team member requires explicit confirmation first.",
        );
        if (confirmationError) return confirmationError;

        const ownership = await getTeamOwnership(ctx.workspaceId, teamId);
        if (!ownership.exists) return { success: false, data: null, error: "Team not found" };
        if (!isAdmin(ctx) && ownership.ownerId !== ctx.userId) {
          return { success: false, data: null, error: "You do not have permission to manage this team" };
        }

        return withMutationGuard(
          "remove_team_member",
          { teamId, userId },
          ctx,
          async () => {
            await removeTeamMember(ctx.workspaceId, teamId, ctx.userId, userId);
            await recordAiMutationActivity({
              ctx,
              toolName: "remove_team_member",
              targetType: "TEAM",
              targetId: teamId,
              message: `AI removed a member from team`,
              metadata: { teamId, removedUserId: userId },
            });
            return { success: true, data: { teamId, userId, message: "Team member removed" } };
          },
        );
      }

      case "list_team_members": {
        const teamId = str(args.teamId);
        if (!teamId) return { success: false, data: null, error: "teamId is required" };
        const result = await listTeamMembersService(ctx.workspaceId, workspaceRole(ctx), teamId, {
          limit: Math.min(num(args.limit, 50), 100),
          view: "compact",
        });
        return { success: true, data: result.items, meta: result.meta };
      }

      case "list_members": {
        const where: Record<string, unknown> = { workspaceId: ctx.workspaceId };

        const memberships = await prisma.workspaceMembership.findMany({
          where, select: { role: true, user: { select: { id: true, name: true, email: true } } },
          orderBy: { user: { name: "asc" } }, take: 50,
        });

        // Filter by search
        let result = memberships.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.role }));
        if (args.q) {
          const q = str(args.q).toLowerCase();
          result = result.filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
        }

        return { success: true, data: result };
      }

      case "get_team_workload": {
        const where: Record<string, unknown> = { workspaceId: ctx.workspaceId, status: { not: "done" } };
        if (args.teamId) {
          // Verify user can see this team (private team check)
          const team = await prisma.team.findFirst({
            where: { id: str(args.teamId), workspaceId: ctx.workspaceId },
            select: { id: true, visibility: true, memberships: { select: { userId: true } } },
          });
          if (!team) return { success: false, data: null, error: "Team not found" };
          if (team.visibility === "PRIVATE" && !isAdmin(ctx) && !team.memberships.some((m) => m.userId === ctx.userId)) {
            return { success: false, data: null, error: "You don't have access to this team" };
          }
          where.teamId = str(args.teamId);
        }

        const issues = await prisma.issue.groupBy({ by: ["assigneeId"], where, _count: true });
        const userIds = issues.map((i) => i.assigneeId).filter(Boolean) as string[];
        const users = userIds.length > 0 ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
        const userMap = new Map(users.map((u) => [u.id, u.name]));

        return { success: true, data: issues.filter((i) => i.assigneeId).map((i) => ({ name: userMap.get(i.assigneeId!) ?? "Unknown", openIssues: i._count })).sort((a, b) => b.openIssues - a.openIssues) };
      }

      case "invite_member": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can send invitations" };

        const email = str(args.email).toLowerCase().trim();
        if (!email || !email.includes("@")) return { success: false, data: null, error: "Invalid email address" };

        const team = await prisma.team.findFirst({ where: { id: str(args.teamId), workspaceId: ctx.workspaceId }, select: { id: true } });
        if (!team) return { success: false, data: null, error: "Team not found" };

        // Check if already a member
        const existingMember = await prisma.user.findFirst({ where: { email }, select: { id: true } });
        if (existingMember) {
          const membership = await prisma.workspaceMembership.findFirst({ where: { userId: existingMember.id, workspaceId: ctx.workspaceId }, select: { id: true } });
          if (membership) return { success: false, data: null, error: `${email} is already a workspace member` };
        }

        // Check for pending invitation
        const existingInvite = await prisma.workspaceInvitation.findFirst({ where: { workspaceId: ctx.workspaceId, email, status: "PENDING" }, select: { id: true } });
        if (existingInvite) return { success: false, data: null, error: `A pending invitation already exists for ${email}` };

        const token = randomBytes(32).toString("hex");
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const role = str(args.role, "MEMBER") as "ADMIN" | "MEMBER" | "GUEST";

        return withMutationGuard(
          "invite_member",
          {
            email,
            role,
            teamId: team.id,
          },
          ctx,
          async () => {
            await prisma.workspaceInvitation.create({
              data: { workspaceId: ctx.workspaceId, email, role, teamId: team.id, tokenHash, invitedById: ctx.userId, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
            });

            await recordAiMutationActivity({
              ctx,
              toolName: "invite_member",
              targetType: "WORKSPACE",
              targetId: ctx.workspaceId,
              message: `AI sent a workspace invitation to ${email}`,
              metadata: {
                email,
                role,
                teamId: team.id,
              },
            });

            return { success: true, data: { email, role, message: `Invitation sent to ${email} as ${role}` } };
          },
        );
      }

      case "list_departments": {
        const result = await listDepartments(ctx.workspaceId, workspaceRole(ctx), {
          ...(args.q ? { q: str(args.q) } : {}),
          limit: Math.min(num(args.limit, 20), 50),
          view: "compact",
        });
        return { success: true, data: result.items, meta: result.meta };
      }

      case "get_department": {
        const departmentId = str(args.departmentId);
        if (!departmentId) return { success: false, data: null, error: "departmentId is required" };

        const department = await getDepartmentById(ctx.workspaceId, workspaceRole(ctx), departmentId);
        return { success: true, data: department };
      }

      case "create_department": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can create departments" };

        const name = str(args.name);
        if (!name) return { success: false, data: null, error: "name is required" };
        const memberIds = parseJsonArray(args.memberIdsJson).map((entry) => String(entry)).filter(Boolean);

        return withMutationGuard(
          "create_department",
          {
            name,
            headId: args.headId ? resolveUserId(args.headId, ctx) : null,
            color: args.color ? str(args.color) : null,
            visibility: args.visibility ? str(args.visibility).toUpperCase() : "PUBLIC",
            isDefault: args.isDefault ? str(args.isDefault).toLowerCase() === "true" : false,
            memberIds,
          },
          ctx,
          async () => {
            const department = await createDepartment(ctx.workspaceId, {
              name,
              ...(args.headId ? { headId: resolveUserId(args.headId, ctx) ?? str(args.headId) } : {}),
              ...(args.description ? { description: str(args.description) } : {}),
              ...(args.color ? { color: str(args.color) } : {}),
              ...(args.visibility ? { visibility: str(args.visibility).toUpperCase() as "PUBLIC" | "PRIVATE" } : {}),
              ...(args.isDefault ? { isDefault: str(args.isDefault).toLowerCase() === "true" } : {}),
              ...(memberIds.length > 0 ? { memberIds } : {}),
            });

            invalidateContextCache(ctx.workspaceId);
            await upsertEntityAliases({
              workspaceId: ctx.workspaceId,
              entityType: "DEPARTMENT",
              entityId: department.id,
              aliases: [department.name],
            });
            await enqueueEmbedding({
              workspaceId: ctx.workspaceId,
              entityType: "DEPARTMENT",
              entityId: department.id,
              triggeredByUserId: ctx.userId,
              reason: "created",
            });
            await recordAiMutationActivity({
              ctx,
              toolName: "create_department",
              targetType: "DEPARTMENT",
              targetId: department.id,
              message: `AI created department "${department.name}"`,
              metadata: {
                departmentId: department.id,
                entityId: department.id,
                entityTitle: department.name,
              },
            });
            return { success: true, data: department };
          },
        );
      }

      case "update_department": {
        const departmentId = str(args.departmentId);
        if (!departmentId) return { success: false, data: null, error: "departmentId is required" };

        const ownership = await getDepartmentOwnership(ctx.workspaceId, departmentId);
        if (!ownership.exists) return { success: false, data: null, error: "Department not found" };
        if (!isAdmin(ctx) && ownership.ownerId !== ctx.userId) {
          return { success: false, data: null, error: "You do not have permission to update this department" };
        }

        return withMutationGuard(
          "update_department",
          {
            departmentId,
            name: args.name ? str(args.name) : null,
            headId: args.headId !== undefined ? (resolveUserId(args.headId, ctx) ?? str(args.headId)) : undefined,
            color: args.color !== undefined ? str(args.color) : undefined,
            visibility: args.visibility ? str(args.visibility).toUpperCase() : null,
            isDefault: args.isDefault !== undefined ? str(args.isDefault).toLowerCase() === "true" : undefined,
          },
          ctx,
          async () => {
            const updated = await updateDepartment(ctx.workspaceId, departmentId, {
              ...(args.name ? { name: str(args.name) } : {}),
              ...(args.headId !== undefined ? { headId: (resolveUserId(args.headId, ctx) ?? str(args.headId)) || null } : {}),
              ...(args.description !== undefined ? { description: str(args.description) || null } : {}),
              ...(args.color !== undefined ? { color: str(args.color) || null } : {}),
              ...(args.visibility ? { visibility: str(args.visibility).toUpperCase() as "PUBLIC" | "PRIVATE" } : {}),
              ...(args.isDefault !== undefined ? { isDefault: str(args.isDefault).toLowerCase() === "true" } : {}),
            });

            invalidateContextCache(ctx.workspaceId);
            await upsertEntityAliases({
              workspaceId: ctx.workspaceId,
              entityType: "DEPARTMENT",
              entityId: updated.id,
              aliases: [updated.name],
            });
            await enqueueEmbedding({
              workspaceId: ctx.workspaceId,
              entityType: "DEPARTMENT",
              entityId: updated.id,
              triggeredByUserId: ctx.userId,
              reason: "updated",
            });
            await recordAiMutationActivity({
              ctx,
              toolName: "update_department",
              targetType: "DEPARTMENT",
              targetId: updated.id,
              message: `AI updated department "${updated.name}"`,
              metadata: {
                departmentId: updated.id,
                entityId: updated.id,
                entityTitle: updated.name,
              },
            });
            return { success: true, data: updated };
          },
        );
      }

      case "add_department_members": {
        const departmentId = str(args.departmentId);
        const userIds = parseJsonArray(args.userIdsJson).map((entry) => String(entry)).filter(Boolean);
        if (!departmentId || userIds.length === 0) return { success: false, data: null, error: "departmentId and userIdsJson are required" };

        const ownership = await getDepartmentOwnership(ctx.workspaceId, departmentId);
        if (!ownership.exists) return { success: false, data: null, error: "Department not found" };
        if (!isAdmin(ctx) && ownership.ownerId !== ctx.userId) {
          return { success: false, data: null, error: "You do not have permission to manage this department" };
        }

        return withMutationGuard(
          "add_department_members",
          { departmentId, userIds },
          ctx,
          async () => {
            const added = await addDepartmentMembers(ctx.workspaceId, departmentId, { userIds });
            await recordAiMutationActivity({
              ctx,
              toolName: "add_department_members",
              targetType: "DEPARTMENT",
              targetId: departmentId,
              message: `AI added ${userIds.length} department member(s)`,
              metadata: { departmentId, addedUserIds: added.added },
            });
            return { success: true, data: added };
          },
        );
      }

      case "list_department_members": {
        const departmentId = str(args.departmentId);
        if (!departmentId) return { success: false, data: null, error: "departmentId is required" };
        const result = await listDepartmentMembers(ctx.workspaceId, workspaceRole(ctx), departmentId, {
          limit: Math.min(num(args.limit, 50), 100),
          view: "compact",
        });
        return { success: true, data: result.items, meta: result.meta };
      }

      case "remove_department_member": {
        const departmentId = str(args.departmentId);
        const userId = resolveUserId(args.userId, ctx);
        if (!departmentId || !userId) return { success: false, data: null, error: "departmentId and userId are required" };
        const confirmationError = requireConfirmedHighImpact(
          ctx,
          "remove_department_member",
          { departmentId, userId },
          "Removing a department member requires explicit confirmation first.",
        );
        if (confirmationError) return confirmationError;

        const ownership = await getDepartmentOwnership(ctx.workspaceId, departmentId);
        if (!ownership.exists) return { success: false, data: null, error: "Department not found" };
        if (!isAdmin(ctx) && ownership.ownerId !== ctx.userId) {
          return { success: false, data: null, error: "You do not have permission to manage this department" };
        }

        return withMutationGuard(
          "remove_department_member",
          { departmentId, userId },
          ctx,
          async () => {
            await removeDepartmentMember(ctx.workspaceId, departmentId, userId);
            await recordAiMutationActivity({
              ctx,
              toolName: "remove_department_member",
              targetType: "DEPARTMENT",
              targetId: departmentId,
              message: `AI removed a member from department`,
              metadata: { departmentId, removedUserId: userId },
            });
            return { success: true, data: { departmentId, userId, message: "Department member removed" } };
          },
        );
      }

      // ═══════════════════════════════════════════════════════════
      // CYCLES / SPRINTS
      // ═══════════════════════════════════════════════════════════

      case "list_cycles": {
        const result = await listCyclesService(ctx.workspaceId, {
          ...(args.teamId ? { teamId: str(args.teamId) } : {}),
          ...(args.status ? { status: str(args.status) as "UPCOMING" | "CURRENT" | "COMPLETED" } : {}),
          limit: Math.min(num(args.limit, 10), 30),
        });
        return { success: true, data: result.items, meta: result.meta };
      }

      case "get_cycle": {
        const cycleId = str(args.cycleId);
        if (!cycleId) return { success: false, data: null, error: "cycleId is required" };

        const cycle = await getCycleById(ctx.workspaceId, cycleId, ctx.userId, workspaceRole(ctx));
        return { success: true, data: cycle };
      }

      case "create_cycle": {
        if (ctx.userRole === "GUEST") return { success: false, data: null, error: "Guests cannot create cycles" };

        const teamId = str(args.teamId);
        const name = str(args.name);
        const startsAt = str(args.startsAt);
        const endsAt = str(args.endsAt);
        if (!teamId || !name || !startsAt || !endsAt) {
          return { success: false, data: null, error: "teamId, name, startsAt, and endsAt are required" };
        }

        return withMutationGuard(
          "create_cycle",
          { teamId, name, startsAt, endsAt, status: args.status ? str(args.status).toUpperCase() : "UPCOMING" },
          ctx,
          async () => {
            const cycle = await createCycle(ctx.workspaceId, ctx.userId, workspaceRole(ctx), {
              teamId,
              name,
              startsAt,
              endsAt,
              ...(args.description !== undefined ? { description: str(args.description) || null } : {}),
              ...(args.goal !== undefined ? { goal: str(args.goal) || null } : {}),
              ...(args.status ? { status: str(args.status).toUpperCase() as "UPCOMING" | "CURRENT" | "COMPLETED" } : {}),
            });

            await upsertEntityAliases({
              workspaceId: ctx.workspaceId,
              entityType: "CYCLE",
              entityId: cycle.id,
              aliases: [cycle.name],
            });
            await enqueueEmbedding({
              workspaceId: ctx.workspaceId,
              entityType: "CYCLE",
              entityId: cycle.id,
              triggeredByUserId: ctx.userId,
              reason: "created",
            });
            await recordAiMutationActivity({
              ctx,
              toolName: "create_cycle",
              targetType: "CYCLE",
              targetId: cycle.id,
              message: `AI created cycle "${cycle.name}"`,
              metadata: { cycleId: cycle.id, entityId: cycle.id, entityTitle: cycle.name, teamId: cycle.team.id },
            });
            return { success: true, data: cycle };
          },
        );
      }

      case "update_cycle": {
        const cycleId = str(args.cycleId);
        if (!cycleId) return { success: false, data: null, error: "cycleId is required" };
        if (ctx.userRole === "GUEST") return { success: false, data: null, error: "Guests cannot update cycles" };

        return withMutationGuard(
          "update_cycle",
          {
            cycleId,
            name: args.name ? str(args.name) : null,
            startsAt: args.startsAt ? str(args.startsAt) : null,
            endsAt: args.endsAt ? str(args.endsAt) : null,
            status: args.status ? str(args.status).toUpperCase() : null,
          },
          ctx,
          async () => {
            const cycle = await updateCycle(ctx.workspaceId, cycleId, ctx.userId, workspaceRole(ctx), {
              ...(args.name ? { name: str(args.name) } : {}),
              ...(args.description !== undefined ? { description: str(args.description) || null } : {}),
              ...(args.goal !== undefined ? { goal: str(args.goal) || null } : {}),
              ...(args.startsAt ? { startsAt: str(args.startsAt) } : {}),
              ...(args.endsAt ? { endsAt: str(args.endsAt) } : {}),
              ...(args.status ? { status: str(args.status).toUpperCase() as "UPCOMING" | "CURRENT" | "COMPLETED" } : {}),
            });
            await upsertEntityAliases({
              workspaceId: ctx.workspaceId,
              entityType: "CYCLE",
              entityId: cycle.id,
              aliases: [cycle.name],
            });
            await enqueueEmbedding({
              workspaceId: ctx.workspaceId,
              entityType: "CYCLE",
              entityId: cycle.id,
              triggeredByUserId: ctx.userId,
              reason: "updated",
            });
            await recordAiMutationActivity({
              ctx,
              toolName: "update_cycle",
              targetType: "CYCLE",
              targetId: cycle.id,
              message: `AI updated cycle "${cycle.name}"`,
              metadata: { cycleId: cycle.id, entityId: cycle.id, entityTitle: cycle.name, teamId: cycle.team.id },
            });
            return { success: true, data: cycle };
          },
        );
      }

      case "complete_cycle": {
        const cycleId = str(args.cycleId);
        if (!cycleId) return { success: false, data: null, error: "cycleId is required" };
        const confirmationError = requireConfirmedHighImpact(
          ctx,
          "complete_cycle",
          { cycleId },
          "Completing a cycle requires explicit confirmation first.",
        );
        if (confirmationError) return confirmationError;

        return withMutationGuard(
          "complete_cycle",
          { cycleId },
          ctx,
          async () => {
            const cycle = await completeCycle(ctx.workspaceId, cycleId, ctx.userId, workspaceRole(ctx));
            await recordAiMutationActivity({
              ctx,
              toolName: "complete_cycle",
              targetType: "CYCLE",
              targetId: cycle.id,
              message: `AI completed cycle "${cycle.name}"`,
              metadata: { cycleId: cycle.id, entityId: cycle.id, entityTitle: cycle.name, teamId: cycle.team.id },
            });
            return { success: true, data: cycle };
          },
        );
      }

      case "reopen_cycle": {
        const cycleId = str(args.cycleId);
        if (!cycleId) return { success: false, data: null, error: "cycleId is required" };
        const confirmationError = requireConfirmedHighImpact(
          ctx,
          "reopen_cycle",
          { cycleId },
          "Reopening a cycle requires explicit confirmation first.",
        );
        if (confirmationError) return confirmationError;

        return withMutationGuard(
          "reopen_cycle",
          { cycleId },
          ctx,
          async () => {
            const cycle = await reopenCycle(ctx.workspaceId, cycleId, ctx.userId, workspaceRole(ctx));
            await recordAiMutationActivity({
              ctx,
              toolName: "reopen_cycle",
              targetType: "CYCLE",
              targetId: cycle.id,
              message: `AI reopened cycle "${cycle.name}"`,
              metadata: { cycleId: cycle.id, entityId: cycle.id, entityTitle: cycle.name, teamId: cycle.team.id },
            });
            return { success: true, data: cycle };
          },
        );
      }

      case "carry_over_cycle": {
        const cycleId = str(args.cycleId);
        const mode = str(args.mode);
        if (!cycleId || !mode) return { success: false, data: null, error: "cycleId and mode are required" };
        const confirmationError = requireConfirmedHighImpact(
          ctx,
          "carry_over_cycle",
          { cycleId, mode, targetCycleId: args.targetCycleId ? str(args.targetCycleId) : null },
          "Carrying over a cycle requires explicit confirmation first.",
        );
        if (confirmationError) return confirmationError;

        return withMutationGuard(
          "carry_over_cycle",
          { cycleId, mode, targetCycleId: args.targetCycleId ? str(args.targetCycleId) : null },
          ctx,
          async () => {
            const result = await carryOverCycle(ctx.workspaceId, cycleId, ctx.userId, workspaceRole(ctx), {
              mode: mode as "nextCycle" | "backlog",
              ...(args.targetCycleId ? { targetCycleId: str(args.targetCycleId) } : {}),
            });
            await recordAiMutationActivity({
              ctx,
              toolName: "carry_over_cycle",
              targetType: "CYCLE",
              targetId: cycleId,
              message: "AI carried over unfinished cycle work",
              metadata: { cycleId, mode, targetCycleId: args.targetCycleId ? str(args.targetCycleId) : null },
            });
            return { success: true, data: result };
          },
        );
      }

      case "get_cycle_progress": {
        const cycle = await prisma.cycle.findFirst({
          where: { id: str(args.cycleId), workspaceId: ctx.workspaceId },
          select: { id: true, name: true, status: true, startsAt: true, endsAt: true, goal: true },
        });
        if (!cycle) return { success: false, data: null, error: "Cycle not found" };

        const statusCounts = await prisma.issue.groupBy({ by: ["status"], where: { cycleId: cycle.id }, _count: true });
        const stats = Object.fromEntries(statusCounts.map((s) => [s.status, s._count]));
        const total = statusCounts.reduce((sum, s) => sum + s._count, 0);
        const done = stats["done"] ?? stats["DONE"] ?? 0;

        return { success: true, data: { ...cycle, startsAt: cycle.startsAt.toISOString().slice(0, 10), endsAt: cycle.endsAt.toISOString().slice(0, 10), issuesByStatus: stats, total, done, progress: total > 0 ? Math.round((done / total) * 100) : 0 } };
      }

      // ═══════════════════════════════════════════════════════════
      // LABELS
      // ═══════════════════════════════════════════════════════════

      case "list_labels": {
        const labels = await prisma.label.findMany({
          where: { workspaceId: ctx.workspaceId },
          select: { id: true, name: true, color: true },
          orderBy: { name: "asc" }, take: 50,
        });
        return { success: true, data: labels };
      }

      case "list_templates": {
        const result = await listTemplates(ctx.workspaceId, ctx.userId, {
          ...(args.q ? { q: str(args.q) } : {}),
          ...(args.issueType ? { issueType: str(args.issueType) as "task" | "bug" | "issue" } : {}),
          ...(args.lifecycle ? { lifecycle: str(args.lifecycle).toUpperCase() as "ACTIVE" | "INACTIVE" | "ARCHIVED" } : {}),
          limit: Math.min(num(args.limit, 20), 50),
        });
        return { success: true, data: result.items, meta: result.meta };
      }

      case "list_active_templates": {
        const result = await listActiveTemplates(ctx.workspaceId, ctx.userId, {
          ...(args.issueType ? { issueType: str(args.issueType) as "task" | "bug" | "issue" } : {}),
        });
        return { success: true, data: result.items };
      }

      case "get_template": {
        const templateId = str(args.templateId);
        if (!templateId) return { success: false, data: null, error: "templateId is required" };
        const template = await getTemplateById(ctx.workspaceId, templateId, ctx.userId);
        return { success: true, data: template };
      }

      case "create_template": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can create templates" };
        const name = str(args.name);
        if (!name) return { success: false, data: null, error: "name is required" };
        return withMutationGuard(
          "create_template",
          { name, issueType: args.issueType ? str(args.issueType) : null },
          ctx,
          async () => {
            const template = await createTemplate(ctx.workspaceId, ctx.userId, {
              name,
              description: str(args.description),
              issueType: str(args.issueType) as "task" | "bug" | "issue",
              category: str(args.category),
              titleTemplate: str(args.titleTemplate),
              contentTemplate: str(args.contentTemplate),
              defaultPriority: str(args.defaultPriority),
              defaultStatus: str(args.defaultStatus),
              defaultAssigneeType: str(args.defaultAssigneeType) as "UNASSIGNED" | "CREATOR" | "SPECIFIC_USER",
              ...(args.defaultAssigneeId ? { defaultAssigneeId: resolveUserId(args.defaultAssigneeId, ctx) ?? str(args.defaultAssigneeId) } : {}),
              ...(args.acceptanceCriteriaTemplate ? { acceptanceCriteriaTemplate: str(args.acceptanceCriteriaTemplate) } : {}),
            });
            await recordAiMutationActivity({
              ctx,
              toolName: "create_template",
              targetType: "WORKSPACE",
              targetId: template.id,
              message: `AI created template "${template.name}"`,
              metadata: { templateId: template.id, entityId: template.id, entityTitle: template.name },
            });
            return { success: true, data: template };
          },
        );
      }

      case "update_template": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can update templates" };
        const templateId = str(args.templateId);
        if (!templateId) return { success: false, data: null, error: "templateId is required" };
        return withMutationGuard(
          "update_template",
          { templateId, name: args.name ? str(args.name) : null },
          ctx,
          async () => {
            const template = await updateTemplate(ctx.workspaceId, templateId, ctx.userId, {
              ...(args.name !== undefined ? { name: str(args.name) } : {}),
              ...(args.description !== undefined ? { description: str(args.description) } : {}),
              ...(args.titleTemplate !== undefined ? { titleTemplate: str(args.titleTemplate) } : {}),
              ...(args.contentTemplate !== undefined ? { contentTemplate: str(args.contentTemplate) } : {}),
              ...(args.defaultPriority !== undefined ? { defaultPriority: str(args.defaultPriority) } : {}),
              ...(args.defaultStatus !== undefined ? { defaultStatus: str(args.defaultStatus) } : {}),
              ...(args.defaultAssigneeType !== undefined ? { defaultAssigneeType: str(args.defaultAssigneeType) as "UNASSIGNED" | "CREATOR" | "SPECIFIC_USER" } : {}),
              ...(args.defaultAssigneeId !== undefined ? { defaultAssigneeId: (resolveUserId(args.defaultAssigneeId, ctx) ?? str(args.defaultAssigneeId)) || null } : {}),
              ...(args.acceptanceCriteriaTemplate !== undefined ? { acceptanceCriteriaTemplate: str(args.acceptanceCriteriaTemplate) || null } : {}),
            });
            await recordAiMutationActivity({
              ctx,
              toolName: "update_template",
              targetType: "WORKSPACE",
              targetId: template.id,
              message: `AI updated template "${template.name}"`,
              metadata: { templateId: template.id, entityId: template.id, entityTitle: template.name },
            });
            return { success: true, data: template };
          },
        );
      }

      case "duplicate_template": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can duplicate templates" };
        const templateId = str(args.templateId);
        if (!templateId) return { success: false, data: null, error: "templateId is required" };
        return withMutationGuard(
          "duplicate_template",
          { templateId },
          ctx,
          async () => {
            const template = await duplicateTemplate(ctx.workspaceId, templateId, ctx.userId);
            await recordAiMutationActivity({
              ctx,
              toolName: "duplicate_template",
              targetType: "WORKSPACE",
              targetId: template.id,
              message: `AI duplicated template "${template.name}"`,
              metadata: { templateId: template.id, entityId: template.id, entityTitle: template.name },
            });
            return { success: true, data: template };
          },
        );
      }

      case "activate_template": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can activate templates" };
        const templateId = str(args.templateId);
        if (!templateId) return { success: false, data: null, error: "templateId is required" };
        const confirmationError = requireConfirmedHighImpact(
          ctx,
          "activate_template",
          { templateId },
          "Activating a template requires explicit confirmation first.",
        );
        if (confirmationError) return confirmationError;
        return withMutationGuard("activate_template", { templateId }, ctx, async () => {
          const template = await activateTemplate(ctx.workspaceId, templateId, ctx.userId);
          await recordAiMutationActivity({
            ctx,
            toolName: "activate_template",
            targetType: "WORKSPACE",
            targetId: ctx.workspaceId,
            message: `AI activated template "${String((template as any).name ?? templateId)}"`,
            metadata: { templateId, entityId: templateId, entityTitle: String((template as any).name ?? templateId) },
          });
          return { success: true, data: template };
        });
      }

      case "deactivate_template": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can deactivate templates" };
        const templateId = str(args.templateId);
        if (!templateId) return { success: false, data: null, error: "templateId is required" };
        const confirmationError = requireConfirmedHighImpact(
          ctx,
          "deactivate_template",
          { templateId },
          "Deactivating a template requires explicit confirmation first.",
        );
        if (confirmationError) return confirmationError;
        return withMutationGuard("deactivate_template", { templateId }, ctx, async () => {
          const template = await deactivateTemplate(ctx.workspaceId, templateId, ctx.userId);
          await recordAiMutationActivity({
            ctx,
            toolName: "deactivate_template",
            targetType: "WORKSPACE",
            targetId: ctx.workspaceId,
            message: `AI deactivated template "${String((template as any).name ?? templateId)}"`,
            metadata: { templateId, entityId: templateId, entityTitle: String((template as any).name ?? templateId) },
          });
          return { success: true, data: template };
        });
      }

      case "list_notifications": {
        const result = await listNotifications(ctx.workspaceId, ctx.userId, {
          ...(args.unreadOnly ? { unreadOnly: str(args.unreadOnly).toLowerCase() === "true" } : {}),
          ...(args.category ? { category: str(args.category) as any } : {}),
          limit: Math.min(num(args.limit, 20), 50),
        });
        return { success: true, data: result.items, meta: result.meta };
      }

      case "mark_notification_read": {
        const notificationId = str(args.notificationId);
        if (!notificationId) return { success: false, data: null, error: "notificationId is required" };
        return withMutationGuard("mark_notification_read", { notificationId }, ctx, async () => {
          const notification = await markRead(ctx.workspaceId, ctx.userId, notificationId);
          await recordAiMutationActivity({
            ctx,
            toolName: "mark_notification_read",
            targetType: "WORKSPACE",
            targetId: ctx.workspaceId,
            message: "AI marked a notification as read",
            metadata: { notificationId },
          });
          return { success: true, data: notification };
        });
      }

      case "mark_all_notifications_read": {
        return withMutationGuard("mark_all_notifications_read", {}, ctx, async () => {
          const result = await markAllRead(ctx.workspaceId, ctx.userId);
          await recordAiMutationActivity({
            ctx,
            toolName: "mark_all_notifications_read",
            targetType: "WORKSPACE",
            targetId: ctx.workspaceId,
            message: "AI marked all notifications as read",
          });
          return { success: true, data: result };
        });
      }

      case "create_document": {
        const scopeType = str(args.scopeType).toUpperCase();
        const name = str(args.name);
        const fileKey = str(args.fileKey);
        const fileName = str(args.fileName);
        const contentType = str(args.contentType);
        const sizeBytes = parseInt(str(args.sizeBytes), 10);

        if (!name || !fileKey || !fileName || !contentType || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
          return { success: false, data: null, error: "scopeType, name, fileKey, fileName, contentType, and a valid positive sizeBytes are required" };
        }
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can create documents" };

        return withMutationGuard(
          "create_document",
          {
            scopeType,
            name,
            teamId: args.teamId ? str(args.teamId) : null,
            projectId: args.projectId ? str(args.projectId) : null,
            folderId: args.folderId ? str(args.folderId) : null,
            fileKey,
            fileName,
            contentType,
            sizeBytes,
          },
          ctx,
          async () => {
            const input = {
              name,
              ...(args.description !== undefined ? { description: str(args.description) || null } : {}),
              ...(args.folderId !== undefined ? { folderId: str(args.folderId) || null } : {}),
              file: {
                key: fileKey,
                fileName,
                contentType,
                size: sizeBytes,
                kind: "document" as const,
                ...(args.assetUrl ? { assetUrl: str(args.assetUrl) } : {}),
              },
            };

            let document;
            if (scopeType === "WORKSPACE") {
              document = await createWorkspaceDocument(ctx.workspaceId, workspaceRole(ctx), ctx.userId, input);
            } else if (scopeType === "TEAM") {
              const teamId = str(args.teamId);
              if (!teamId) return { success: false, data: null, error: "teamId is required for TEAM scope" };
              document = await createTeamDocument(ctx.workspaceId, workspaceRole(ctx), teamId, ctx.userId, input);
            } else if (scopeType === "PROJECT") {
              const projectId = str(args.projectId);
              if (!projectId) return { success: false, data: null, error: "projectId is required for PROJECT scope" };
              document = await createProjectDocument(ctx.workspaceId, workspaceRole(ctx), projectId, ctx.userId, input);
            } else {
              return { success: false, data: null, error: "scopeType must be WORKSPACE, TEAM, or PROJECT" };
            }

            await recordAiMutationActivity({
              ctx,
              toolName: "create_document",
              targetType: "DOCUMENT",
              targetId: String((document as any).id),
              message: `AI created document "${String((document as any).name)}"`,
              metadata: {
                documentId: String((document as any).id),
                entityId: String((document as any).id),
                entityTitle: String((document as any).name),
                scope: String((document as any).scope),
                teamId: (document as any).teamId ?? null,
                projectId: (document as any).projectId ?? null,
              },
            });
            return { success: true, data: document };
          },
        );
      }

      case "list_documents": {
        const scopeType = str(args.scopeType).toUpperCase();
        const query = {
          ...(args.folderId !== undefined ? { folderId: str(args.folderId) || null } : {}),
          limit: Math.min(num(args.limit, 20), 50),
        };
        if (scopeType === "WORKSPACE") return { success: true, data: await listWorkspaceDocuments(ctx.workspaceId, query as any) };
        if (scopeType === "TEAM") return { success: true, data: await listTeamDocuments(ctx.workspaceId, workspaceRole(ctx), ctx.userId, str(args.teamId), query as any) };
        if (scopeType === "PROJECT") return { success: true, data: await listProjectDocuments(ctx.workspaceId, workspaceRole(ctx), ctx.userId, str(args.projectId), query as any) };
        return { success: false, data: null, error: "scopeType must be WORKSPACE, TEAM, or PROJECT" };
      }

      case "list_document_folders": {
        const scopeType = str(args.scopeType).toUpperCase();
        const query = { ...(args.parentId !== undefined ? { parentId: str(args.parentId) || null } : {}) };
        if (scopeType === "WORKSPACE") return { success: true, data: await listWorkspaceFolders(ctx.workspaceId, query as any) };
        if (scopeType === "TEAM") return { success: true, data: await listTeamFolders(ctx.workspaceId, workspaceRole(ctx), ctx.userId, str(args.teamId), query as any) };
        if (scopeType === "PROJECT") return { success: true, data: await listProjectFolders(ctx.workspaceId, workspaceRole(ctx), ctx.userId, str(args.projectId), query as any) };
        return { success: false, data: null, error: "scopeType must be WORKSPACE, TEAM, or PROJECT" };
      }

      case "create_document_folder": {
        const scopeType = str(args.scopeType).toUpperCase();
        const name = str(args.name);
        if (!name) return { success: false, data: null, error: "name is required" };
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can create document folders" };
        return withMutationGuard("create_document_folder", { scopeType, name, parentId: args.parentId ? str(args.parentId) : null }, ctx, async () => {
          let folder;
          if (scopeType === "WORKSPACE") folder = await createWorkspaceFolder(ctx.workspaceId, { name, ...(args.parentId !== undefined ? { parentId: str(args.parentId) || null } : {}) }, ctx.userId);
          else if (scopeType === "TEAM") folder = await createTeamFolder(ctx.workspaceId, str(args.teamId), { name, ...(args.parentId !== undefined ? { parentId: str(args.parentId) || null } : {}) }, ctx.userId);
          else if (scopeType === "PROJECT") folder = await createProjectFolder(ctx.workspaceId, str(args.projectId), { name, ...(args.parentId !== undefined ? { parentId: str(args.parentId) || null } : {}) }, ctx.userId);
          else return { success: false, data: null, error: "scopeType must be WORKSPACE, TEAM, or PROJECT" };
          await recordAiMutationActivity({
            ctx,
            toolName: "create_document_folder",
            targetType: "DOCUMENT",
            targetId: String((folder as any).id),
            message: `AI created document folder "${String((folder as any).name ?? name)}"`,
            metadata: { folderId: String((folder as any).id), entityId: String((folder as any).id), entityTitle: String((folder as any).name ?? name), scopeType },
          });
          return { success: true, data: folder };
        });
      }

      case "rename_document_folder": {
        const scopeType = str(args.scopeType).toUpperCase();
        const folderId = str(args.folderId);
        const name = str(args.name);
        if (!folderId || !name) return { success: false, data: null, error: "folderId and name are required" };
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can rename document folders" };
        return withMutationGuard("rename_document_folder", { scopeType, folderId, name }, ctx, async () => {
          let folder;
          if (scopeType === "WORKSPACE") folder = await renameWorkspaceFolder(ctx.workspaceId, folderId, { name }, ctx.userId);
          else if (scopeType === "TEAM") folder = await renameTeamFolder(ctx.workspaceId, str(args.teamId), folderId, { name }, ctx.userId);
          else if (scopeType === "PROJECT") folder = await renameProjectFolder(ctx.workspaceId, str(args.projectId), folderId, { name }, ctx.userId);
          else return { success: false, data: null, error: "scopeType must be WORKSPACE, TEAM, or PROJECT" };
          await recordAiMutationActivity({
            ctx,
            toolName: "rename_document_folder",
            targetType: "DOCUMENT",
            targetId: folderId,
            message: `AI renamed document folder to "${String((folder as any).name ?? name)}"`,
            metadata: { folderId, entityId: folderId, entityTitle: String((folder as any).name ?? name), scopeType },
          });
          return { success: true, data: folder };
        });
      }

      case "move_document_folder": {
        const scopeType = str(args.scopeType).toUpperCase();
        const folderId = str(args.folderId);
        if (!folderId) return { success: false, data: null, error: "folderId is required" };
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can move document folders" };
        return withMutationGuard("move_document_folder", { scopeType, folderId, parentId: args.parentId ? str(args.parentId) : null }, ctx, async () => {
          const input = { parentId: args.parentId ? str(args.parentId) : null };
          let folder;
          if (scopeType === "WORKSPACE") folder = await moveWorkspaceFolder(ctx.workspaceId, folderId, input, ctx.userId);
          else if (scopeType === "TEAM") folder = await moveTeamFolder(ctx.workspaceId, str(args.teamId), folderId, input, ctx.userId);
          else if (scopeType === "PROJECT") folder = await moveProjectFolder(ctx.workspaceId, str(args.projectId), folderId, input, ctx.userId);
          else return { success: false, data: null, error: "scopeType must be WORKSPACE, TEAM, or PROJECT" };
          await recordAiMutationActivity({
            ctx,
            toolName: "move_document_folder",
            targetType: "DOCUMENT",
            targetId: folderId,
            message: "AI moved a document folder",
            metadata: { folderId, parentId: input.parentId, scopeType },
          });
          return { success: true, data: folder };
        });
      }

      case "move_document": {
        const scopeType = str(args.scopeType).toUpperCase();
        const documentId = str(args.documentId);
        if (!documentId) return { success: false, data: null, error: "documentId is required" };
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can move documents" };
        return withMutationGuard("move_document", { scopeType, documentId, folderId: args.folderId ? str(args.folderId) : null }, ctx, async () => {
          const input = { folderId: args.folderId ? str(args.folderId) : null };
          let document;
          if (scopeType === "WORKSPACE") document = await moveWorkspaceDocument(ctx.workspaceId, documentId, input, ctx.userId);
          else if (scopeType === "TEAM") document = await moveTeamDocument(ctx.workspaceId, str(args.teamId), documentId, input, ctx.userId);
          else if (scopeType === "PROJECT") document = await moveProjectDocument(ctx.workspaceId, str(args.projectId), documentId, input, ctx.userId);
          else return { success: false, data: null, error: "scopeType must be WORKSPACE, TEAM, or PROJECT" };
          await recordAiMutationActivity({
            ctx,
            toolName: "move_document",
            targetType: "DOCUMENT",
            targetId: documentId,
            message: "AI moved a document",
            metadata: { documentId, folderId: input.folderId, scopeType },
          });
          return { success: true, data: document };
        });
      }

      case "update_document": {
        const scopeType = str(args.scopeType).toUpperCase();
        const documentId = str(args.documentId);
        if (!documentId) return { success: false, data: null, error: "documentId is required" };
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can update documents" };
        return withMutationGuard("update_document", { scopeType, documentId, name: args.name ? str(args.name) : null }, ctx, async () => {
          const input = {
            ...(args.name !== undefined ? { name: str(args.name) } : {}),
            ...(args.description !== undefined ? { description: str(args.description) || null } : {}),
          };
          let document;
          if (scopeType === "WORKSPACE") document = await updateWorkspaceDocument(ctx.workspaceId, documentId, ctx.userId, input);
          else if (scopeType === "TEAM") document = await updateTeamDocument(ctx.workspaceId, str(args.teamId), documentId, ctx.userId, input);
          else if (scopeType === "PROJECT") document = await updateProjectDocument(ctx.workspaceId, str(args.projectId), documentId, ctx.userId, input);
          else return { success: false, data: null, error: "scopeType must be WORKSPACE, TEAM, or PROJECT" };
          await recordAiMutationActivity({
            ctx,
            toolName: "update_document",
            targetType: "DOCUMENT",
            targetId: documentId,
            message: `AI updated document "${String((document as any).name ?? documentId)}"`,
            metadata: { documentId, entityId: documentId, entityTitle: String((document as any).name ?? documentId), scopeType, changedFields: Object.keys(input) },
          });
          return { success: true, data: document };
        });
      }

      case "list_roadmap": {
        const data = await listRoadmap(ctx.workspaceId, workspaceRole(ctx), ctx.userId, {
          ...(args.teamId ? { teamId: str(args.teamId) } : {}),
          ...(args.departmentId ? { departmentId: str(args.departmentId) } : {}),
          ...(args.projectId ? { projectId: str(args.projectId) } : {}),
          ...(args.health ? { health: str(args.health).toUpperCase() as any } : {}),
          limit: Math.min(num(args.limit, 20), 50),
        });
        return { success: true, data };
      }

      case "get_project_roadmap": {
        const projectId = str(args.projectId);
        if (!projectId) return { success: false, data: null, error: "projectId is required" };
        return { success: true, data: await getProjectRoadmapDetail(ctx.workspaceId, workspaceRole(ctx), ctx.userId, projectId) };
      }

      case "update_project_schedule": {
        const projectId = str(args.projectId);
        if (!projectId) return { success: false, data: null, error: "projectId is required" };
        const allowed = await hasRoadmapManageAccess(ctx.workspaceId, ctx.userId, workspaceRole(ctx), projectId);
        if (!allowed) return { success: false, data: null, error: "You do not have permission to manage this roadmap" };
        const scheduleArgs = {
          projectId,
          startDate: args.startDate ? str(args.startDate) : null,
          targetDate: args.targetDate ? str(args.targetDate) : null,
        };
        const confirmationError = requireConfirmedHighImpact(
          ctx,
          "update_project_schedule",
          scheduleArgs,
          "Updating a project schedule requires explicit confirmation first.",
        );
        if (confirmationError) return confirmationError;
        return withMutationGuard("update_project_schedule", scheduleArgs, ctx, async () => {
          const project = await updateProjectSchedule(ctx.workspaceId, workspaceRole(ctx), ctx.userId, projectId, {
            ...(args.startDate !== undefined ? { startDate: str(args.startDate) || null } : {}),
            ...(args.targetDate !== undefined ? { targetDate: str(args.targetDate) || null } : {}),
            ...(args.reason !== undefined ? { reason: str(args.reason) || null } : {}),
            ...(args.force !== undefined ? { force: str(args.force).toLowerCase() === "true" } : {}),
          });
          await recordAiMutationActivity({
            ctx,
            toolName: "update_project_schedule",
            targetType: "PROJECT",
            targetId: projectId,
            message: `AI updated roadmap schedule for project "${String((project as any).name ?? projectId)}"`,
            metadata: {
              projectId,
              entityId: projectId,
              entityTitle: String((project as any).name ?? projectId),
              startDate: scheduleArgs.startDate,
              targetDate: scheduleArgs.targetDate,
            },
          });
          return { success: true, data: project };
        });
      }

      case "create_milestone": {
        const projectId = str(args.projectId);
        if (!projectId || !args.name || !args.dueDate) return { success: false, data: null, error: "projectId, name, and dueDate are required" };
        const allowed = await hasRoadmapManageAccess(ctx.workspaceId, ctx.userId, workspaceRole(ctx), projectId);
        if (!allowed) return { success: false, data: null, error: "You do not have permission to manage this roadmap" };
        return withMutationGuard("create_milestone", { projectId, name: str(args.name), dueDate: str(args.dueDate) }, ctx, async () => {
          const milestone = await createMilestone(ctx.workspaceId, ctx.userId, projectId, {
            name: str(args.name),
            dueDate: str(args.dueDate),
            ...(args.ownerId ? { ownerId: resolveUserId(args.ownerId, ctx) ?? str(args.ownerId) } : {}),
            ...(args.description !== undefined ? { description: str(args.description) || null } : {}),
            ...(args.status ? { status: str(args.status).toUpperCase() as any } : {}),
          });
          await recordAiMutationActivity({
            ctx,
            toolName: "create_milestone",
            targetType: "PROJECT",
            targetId: projectId,
            message: `AI created milestone "${String((milestone as any).name ?? str(args.name))}"`,
            metadata: { projectId, milestoneId: String((milestone as any).id), entityId: String((milestone as any).id), entityTitle: String((milestone as any).name ?? str(args.name)) },
          });
          return { success: true, data: milestone };
        });
      }

      case "update_milestone": {
        const projectId = str(args.projectId);
        const milestoneId = str(args.milestoneId);
        if (!projectId || !milestoneId) return { success: false, data: null, error: "projectId and milestoneId are required" };
        const allowed = await hasRoadmapManageAccess(ctx.workspaceId, ctx.userId, workspaceRole(ctx), projectId);
        if (!allowed) return { success: false, data: null, error: "You do not have permission to manage this roadmap" };
        return withMutationGuard("update_milestone", { projectId, milestoneId }, ctx, async () => {
          const milestone = await updateMilestone(ctx.workspaceId, ctx.userId, projectId, milestoneId, {
            ...(args.name !== undefined ? { name: str(args.name) } : {}),
            ...(args.dueDate !== undefined ? { dueDate: str(args.dueDate) } : {}),
            ...(args.ownerId !== undefined ? { ownerId: (resolveUserId(args.ownerId, ctx) ?? str(args.ownerId)) || null } : {}),
            ...(args.description !== undefined ? { description: str(args.description) || null } : {}),
            ...(args.status ? { status: str(args.status).toUpperCase() as any } : {}),
          });
          await recordAiMutationActivity({
            ctx,
            toolName: "update_milestone",
            targetType: "PROJECT",
            targetId: projectId,
            message: `AI updated milestone "${String((milestone as any).name ?? milestoneId)}"`,
            metadata: { projectId, milestoneId, entityId: milestoneId, entityTitle: String((milestone as any).name ?? milestoneId) },
          });
          return { success: true, data: milestone };
        });
      }

      case "create_roadmap_dependency": {
        const blockingProjectId = str(args.blockingProjectId);
        const blockedProjectId = str(args.blockedProjectId);
        if (!blockingProjectId || !blockedProjectId) return { success: false, data: null, error: "blockingProjectId and blockedProjectId are required" };
        const allowed = await hasAnyRoadmapManageAccess(ctx.workspaceId, ctx.userId, workspaceRole(ctx), [blockingProjectId, blockedProjectId]);
        if (!allowed) return { success: false, data: null, error: "You do not have permission to manage roadmap dependencies for these projects" };
        return withMutationGuard("create_roadmap_dependency", { blockingProjectId, blockedProjectId }, ctx, async () => {
          const dependency = await createRoadmapDependency(ctx.workspaceId, ctx.userId, {
            blockingProjectId,
            blockedProjectId,
            ...(args.note !== undefined ? { note: str(args.note) || null } : {}),
          });
          await recordAiMutationActivity({
            ctx,
            toolName: "create_roadmap_dependency",
            targetType: "PROJECT",
            targetId: blockedProjectId,
            message: "AI created a roadmap dependency",
            metadata: { blockingProjectId, blockedProjectId, dependencyId: String((dependency as any).id ?? "") || null },
          });
          return { success: true, data: dependency };
        });
      }

      case "reorder_milestones": {
        const projectId = str(args.projectId);
        if (!projectId) return { success: false, data: null, error: "projectId is required" };
        const allowed = await hasRoadmapManageAccess(ctx.workspaceId, ctx.userId, workspaceRole(ctx), projectId);
        if (!allowed) return { success: false, data: null, error: "You do not have permission to manage this roadmap" };
        let orderedIds: string[];
        try {
          orderedIds = JSON.parse(str(args.orderedIdsJson));
        } catch {
          return { success: false, data: null, error: "orderedIdsJson must be valid JSON" };
        }
        if (!Array.isArray(orderedIds) || orderedIds.length === 0) return { success: false, data: null, error: "orderedIdsJson must be a non-empty JSON array" };
        return withMutationGuard("reorder_milestones", { projectId, orderedIds }, ctx, async () => {
          const result = await reorderMilestones(ctx.workspaceId, ctx.userId, projectId, { orderedIds });
          await recordAiMutationActivity({
            ctx,
            toolName: "reorder_milestones",
            targetType: "PROJECT",
            targetId: projectId,
            message: "AI reordered roadmap milestones",
            metadata: { projectId, orderedIds },
          });
          return { success: true, data: result };
        });
      }

      case "resolve_roadmap_dependency": {
        const dependencyId = str(args.dependencyId);
        if (!dependencyId) return { success: false, data: null, error: "dependencyId is required" };
        const confirmationError = requireConfirmedHighImpact(
          ctx,
          "resolve_roadmap_dependency",
          { dependencyId },
          "Resolving a roadmap dependency requires explicit confirmation first.",
        );
        if (confirmationError) return confirmationError;
        return withMutationGuard("resolve_roadmap_dependency", { dependencyId }, ctx, async () => {
          const dependency = await resolveDependency(ctx.workspaceId, ctx.userId, dependencyId, {
            ...(args.note !== undefined ? { note: str(args.note) || null } : {}),
          });
          await recordAiMutationActivity({
            ctx,
            toolName: "resolve_roadmap_dependency",
            targetType: "PROJECT",
            targetId: String((dependency as any).blockedProjectId ?? dependencyId),
            message: "AI resolved a roadmap dependency",
            metadata: { dependencyId },
          });
          return { success: true, data: dependency };
        });
      }

      case "cancel_roadmap_dependency": {
        const dependencyId = str(args.dependencyId);
        if (!dependencyId) return { success: false, data: null, error: "dependencyId is required" };
        const confirmationError = requireConfirmedHighImpact(
          ctx,
          "cancel_roadmap_dependency",
          { dependencyId },
          "Canceling a roadmap dependency requires explicit confirmation first.",
        );
        if (confirmationError) return confirmationError;
        return withMutationGuard("cancel_roadmap_dependency", { dependencyId }, ctx, async () => {
          const dependency = await cancelDependency(ctx.workspaceId, ctx.userId, dependencyId, {
            ...(args.note !== undefined ? { note: str(args.note) || null } : {}),
          });
          await recordAiMutationActivity({
            ctx,
            toolName: "cancel_roadmap_dependency",
            targetType: "PROJECT",
            targetId: String((dependency as any).blockedProjectId ?? dependencyId),
            message: "AI canceled a roadmap dependency",
            metadata: { dependencyId },
          });
          return { success: true, data: dependency };
        });
      }

      case "list_api_keys": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can view API keys" };
        return { success: true, data: await listApiKeys(ctx.workspaceId) };
      }

      case "create_api_key": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can create API keys" };

        const name = str(args.name);
        if (!name) return { success: false, data: null, error: "name is required" };

        const expiresAt = args.expiresAt !== undefined ? str(args.expiresAt) : "";
        if (expiresAt) {
          const expiresDate = new Date(expiresAt);
          if (Number.isNaN(expiresDate.getTime())) {
            return { success: false, data: null, error: "expiresAt must be a valid ISO-8601 timestamp" };
          }
          if (expiresDate <= new Date()) {
            return { success: false, data: null, error: "expiresAt must be in the future" };
          }
        }

        return withMutationGuard(
          "create_api_key",
          { name, expiresAt: expiresAt || null },
          ctx,
          async () => {
            const apiKey = await createApiKey(ctx.workspaceId, ctx.userId, {
              name,
              ...(expiresAt ? { expiresAt } : {}),
            });

            await recordAiMutationActivity({
              ctx,
              toolName: "create_api_key",
              targetType: "WORKSPACE",
              targetId: ctx.workspaceId,
              message: `AI created API key "${apiKey.name}"`,
              metadata: {
                apiKeyId: apiKey.id,
                entityId: apiKey.id,
                entityTitle: apiKey.name,
                keyPrefix: apiKey.keyPrefix,
              },
            });

            return {
              success: true,
              data: {
                ...apiKey,
                secretShownOnce: true,
              },
            };
          },
          {
            persistResult: sanitizeApiKeyReplayResult,
          },
        );
      }

      case "get_api_key": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can view API keys" };
        const keyId = str(args.keyId);
        if (!keyId) return { success: false, data: null, error: "keyId is required" };
        return { success: true, data: await getApiKeyById(ctx.workspaceId, keyId) };
      }

      case "list_integrations": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can view integrations" };
        return { success: true, data: await listIntegrations(ctx.workspaceId) };
      }

      case "get_integration_status": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can view integrations" };
        const provider = str(args.provider).toLowerCase();
        if (!provider) return { success: false, data: null, error: "provider is required" };
        const integration = await findConnectedIntegration(ctx.workspaceId, provider.toUpperCase() as any);
        if (!integration) return { success: true, data: { provider, connected: false } };
        const settings = await getIntegrationSettings(integration.id);
        return { success: true, data: { provider, connected: true, settings, providerMeta: integration.providerMeta ?? null, connectedById: integration.connectedById ?? null } };
      }

      // ═══════════════════════════════════════════════════════════
      // ANALYTICS
      // ═══════════════════════════════════════════════════════════

      case "get_workspace_analytics": {
        if (!isAdmin(ctx)) {
          return { success: false, data: null, error: "Workspace analytics require admin or owner access" };
        }

        const data = await getWorkspaceAnalytics(ctx.workspaceId, analyticsQueryFromArgs(args));
        return {
          success: true,
          data,
          meta: {
            scope: "workspace",
            asOf: new Date().toISOString(),
            report: formatAnalyticsReport("workspace", data as Record<string, unknown>),
          },
        };
      }

      case "get_project_analytics": {
        const projectId = str(args.projectId);
        if (!projectId) return { success: false, data: null, error: "projectId is required" };

        const data = await getProjectAnalytics(
          ctx.workspaceId,
          workspaceRole(ctx),
          ctx.userId,
          projectId,
          analyticsQueryFromArgs(args),
        );

        return {
          success: true,
          data,
          meta: {
            scope: "project",
            scopeId: projectId,
            asOf: new Date().toISOString(),
            report: formatAnalyticsReport("project", data as Record<string, unknown>),
          },
        };
      }

      case "get_team_analytics": {
        const teamId = str(args.teamId);
        if (!teamId) return { success: false, data: null, error: "teamId is required" };

        const data = await getTeamAnalytics(
          ctx.workspaceId,
          workspaceRole(ctx),
          ctx.userId,
          teamId,
          analyticsQueryFromArgs(args),
        );

        return {
          success: true,
          data,
          meta: {
            scope: "team",
            scopeId: teamId,
            asOf: new Date().toISOString(),
            report: formatAnalyticsReport("team", data as Record<string, unknown>),
          },
        };
      }

      case "get_member_analytics": {
        const memberId = resolveUserId(args.memberId, ctx);
        if (!memberId) return { success: false, data: null, error: "memberId is required" };

        const data = await getMemberAnalytics(
          ctx.workspaceId,
          workspaceRole(ctx),
          ctx.userId,
          memberId,
          analyticsQueryFromArgs(args),
        );

        return {
          success: true,
          data,
          meta: {
            scope: "member",
            scopeId: memberId,
            asOf: new Date().toISOString(),
            report: formatAnalyticsReport("member", data as Record<string, unknown>),
          },
        };
      }

      case "get_cycle_analytics": {
        const cycleId = str(args.cycleId);
        if (!cycleId) return { success: false, data: null, error: "cycleId is required" };

        const data = await getCycleAnalytics(
          ctx.workspaceId,
          workspaceRole(ctx),
          ctx.userId,
          cycleId,
          analyticsQueryFromArgs(args),
        );

        return {
          success: true,
          data,
          meta: {
            scope: "cycle",
            scopeId: cycleId,
            asOf: new Date().toISOString(),
            report: formatAnalyticsReport("cycle", data as Record<string, unknown>),
          },
        };
      }

      case "get_current_cycle_for_team": {
        const teamId = str(args.teamId);
        if (!teamId) return { success: false, data: null, error: "teamId is required" };
        await assertTeamVisible(teamId, ctx);

        const now = new Date();
        const cycle = await getCurrentCycle(ctx.workspaceId, teamId);

        if (!cycle) {
          return { success: false, data: null, error: "No current cycle found for this team" };
        }

        return {
          success: true,
          data: cycle,
          meta: {
            scope: "team",
            scopeId: teamId,
            asOf: now.toISOString(),
          },
        };
      }

      case "export_analytics_report": {
        const scope = str(args.scope).toLowerCase();
        if (!scope || !["workspace", "project", "team", "member", "cycle"].includes(scope)) {
          return { success: false, data: null, error: "scope must be workspace, project, team, member, or cycle" };
        }

        const format = str(args.format).toLowerCase();
        if (!format || !["json", "csv", "pdf"].includes(format)) {
          return { success: false, data: null, error: "format must be json, csv, or pdf" };
        }

        const scopeId = str(args.scopeId);
        if (scope !== "workspace" && !scopeId) {
          return { success: false, data: null, error: "scopeId is required for non-workspace exports" };
        }

        const file = await exportAnalytics(ctx.workspaceId, workspaceRole(ctx), ctx.userId, {
          ...analyticsQueryFromArgs(args),
          scope: scope as any,
          ...(scopeId ? { scopeId } : {}),
          format: format as any,
        });

        const artifactBody =
          typeof file.body === "string"
            ? file.body
            : Buffer.isBuffer(file.body)
              ? file.body.toString("base64")
              : "";
        const artifactEncoding =
          typeof file.body === "string"
            ? "utf8"
            : Buffer.isBuffer(file.body)
              ? "base64"
              : "unknown";
        const sizeBytes =
          typeof file.body === "string"
            ? Buffer.byteLength(file.body, "utf8")
            : Buffer.isBuffer(file.body)
              ? file.body.length
              : null;
        const artifactAllowed = sizeBytes !== null && sizeBytes <= MAX_AI_EXPORT_ARTIFACT_BYTES;

        return {
          success: true,
          data: {
            fileName: file.fileName,
            contentType: file.contentType,
            bodyPreview:
              file.contentType === "application/pdf"
                ? "PDF export generated successfully."
                : typeof file.body === "string"
                  ? file.body.slice(0, 4000)
                  : "Binary export generated successfully.",
            truncated: typeof file.body === "string" ? file.body.length > 4000 : false,
            sizeBytes,
            downloadableInChat: artifactAllowed,
          },
          meta: {
            export: true,
            scope,
            ...(scopeId ? { scopeId } : {}),
            format,
            asOf: new Date().toISOString(),
            ...(artifactAllowed
              ? {
                  artifact: {
                    kind: "analytics_export",
                    fileName: file.fileName,
                    contentType: file.contentType,
                    encoding: artifactEncoding,
                    body: artifactBody,
                  },
                }
              : {
                  artifactOmitted: true,
                  artifactOmittedReason: `Export exceeds ${MAX_AI_EXPORT_ARTIFACT_BYTES} bytes and should be downloaded through the direct analytics export endpoint.`,
                }),
          },
        };
      }

      case "compare_projects": {
        const leftProjectId = str(args.projectId || args.projectIdA || args.leftProjectId);
        const rightProjectId = str(args.comparisonTarget || args.projectIdB || args.rightProjectId);
        if (!leftProjectId || !rightProjectId) {
          return { success: false, data: null, error: "Two project IDs are required for comparison" };
        }

        const [left, right] = await Promise.all([
          getProjectAnalytics(ctx.workspaceId, workspaceRole(ctx), ctx.userId, leftProjectId, analyticsQueryFromArgs(args)),
          getProjectAnalytics(ctx.workspaceId, workspaceRole(ctx), ctx.userId, rightProjectId, analyticsQueryFromArgs(args)),
        ]);

        return {
          success: true,
          data: {
            leftProjectId,
            rightProjectId,
            left,
            right,
          },
          meta: {
            comparison: true,
            asOf: new Date().toISOString(),
          },
        };
      }

      case "prioritize_tasks": {
        const where: Prisma.IssueWhereInput = {
          workspaceId: ctx.workspaceId,
          ...issueVisibilityWhere(ctx),
          status: { notIn: ["done"] },
        };
        if (args.assigneeId) {
          const assigneeId = resolveUserId(args.assigneeId, ctx);
          if (assigneeId) where.assigneeId = assigneeId;
        }
        if (args.overdueOnly === true) {
          where.dueDate = { lt: new Date() };
          where.completedAt = null;
        }
        if (args.blockedOnly === true) {
          where.relationsTo = { some: { type: "BLOCKED_BY" } };
        }
        if (args.priority) {
          where.priority = str(args.priority).toUpperCase() as IssuePriority;
        }
        if (args.projectId) where.projectId = str(args.projectId);
        if (args.teamId) where.teamId = str(args.teamId);

        const issues: Array<{
          id: string;
          title: string;
          priority: string;
          status: string;
          dueDate: Date | null;
          assignee: { name: string } | null;
          project: { name: string } | null;
        }> = await prisma.issue.findMany({
          where,
          include: {
            assignee: { select: { name: true } },
            project: { select: { name: true } },
          },
          orderBy: [{ priority: "desc" }, { dueDate: "asc" }, { updatedAt: "desc" }],
          take: Math.min(num(args.limit, 10), 20),
        });

        issues.sort((left, right) => {
          const leftPriority = String(left.priority);
          const rightPriority = String(right.priority);
          if (leftPriority !== rightPriority) return rightPriority.localeCompare(leftPriority);
          const leftDue = left.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
          const rightDue = right.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
          if (leftDue !== rightDue) return leftDue - rightDue;
          return 0;
        });

        return {
          success: true,
          data: issues.slice(0, Math.min(num(args.limit, 10), 20)).map((issue) => ({
            id: issue.id,
            title: issue.title,
            priority: issue.priority,
            status: issue.status,
            dueDate: issue.dueDate?.toISOString() ?? null,
            assignee: issue.assignee?.name ?? "Unassigned",
            project: issue.project?.name ?? "—",
          })),
        };
      }

      case "upcoming_deadlines": {
        const from = new Date();
        const to = new Date();
        to.setDate(to.getDate() + Math.max(1, Math.min(60, num(args.days, 14))));

        const issues = await prisma.issue.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            ...issueVisibilityWhere(ctx),
            dueDate: { gte: from, lte: to },
            status: { notIn: ["done"] },
          },
          select: {
            id: true,
            title: true,
            dueDate: true,
            priority: true,
            status: true,
            assignee: { select: { name: true } },
            project: { select: { name: true } },
          },
          orderBy: [{ dueDate: "asc" }, { priority: "desc" }],
          take: Math.min(num(args.limit, 15), 25),
        });

        return {
          success: true,
          data: issues.map((issue) => ({
            id: issue.id,
            title: issue.title,
            dueDate: issue.dueDate?.toISOString() ?? null,
            priority: issue.priority,
            status: issue.status,
            assignee: issue.assignee?.name ?? "Unassigned",
            project: issue.project?.name ?? "—",
          })),
          meta: {
            rangeDays: Math.max(1, Math.min(60, num(args.days, 14))),
            asOf: from.toISOString(),
          },
        };
      }

      case "activity_summary": {
        const items = await prisma.activity.findMany({
          where: { workspaceId: ctx.workspaceId },
          select: {
            id: true,
            type: true,
            targetType: true,
            targetId: true,
            message: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: Math.min(num(args.limit, 15), 30),
        });

        return {
          success: true,
          data: items.map((item) => ({
            id: item.id,
            type: item.type,
            targetType: item.targetType,
            targetId: item.targetId,
            message: item.message,
            createdAt: item.createdAt.toISOString(),
          })),
        };
      }

      case "app_help": {
        const query = str(args.query).toLowerCase();
        const area = /\b(project|issue|task|team|department|cycle|sprint|analytics|document|doc|workspace)\b/.exec(query)?.[1] ?? null;
        const route = area === "project" ? "Sidebar > Projects"
          : area === "issue" || area === "task" ? "Sidebar > Issues"
            : area === "team" ? "Sidebar > Teams"
              : area === "department" ? "Sidebar > Departments"
                : area === "cycle" || area === "sprint" ? "Sidebar > Cycles"
                  : area === "analytics" ? "Sidebar > Analytics"
                    : area === "document" || area === "doc" ? "Sidebar > Documents"
                      : area === "workspace" ? "Workspace Settings"
                        : null;
        return {
          success: true,
          data: {
            supportedAreas: ["issues", "projects", "teams", "departments", "cycles", "analytics", "workspace access", "documents"],
            blockedActions: ["delete issues", "delete projects", "delete teams", "delete departments", "delete workspace data"],
            guidance: "Ask naturally. Trussen AI can create, update, assign, invite, report, and summarize across your workspace.",
            ...(route ? { navigation: { area, route } } : {}),
          },
        };
      }

      case "policy_block": {
        return {
          success: false,
          data: null,
          error: "This action is blocked by Trussen AI policy.",
          meta: {
            blocked: true,
            reason: str(args.reason, "policy_block"),
          },
        };
      }

      // ═══════════════════════════════════════════════════════════
      // SEARCH
      // ═══════════════════════════════════════════════════════════

      case "search_issues": {
        const limit = Math.min(num(args.limit, 10), 25);
        const q = str(args.query || args.q);

        const issues = await prisma.issue.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            AND: [
              issueVisibilityWhere(ctx),
              {
                OR: [
                  { title: { contains: q, mode: "insensitive" } },
                  { description: { contains: q, mode: "insensitive" } },
                  { id: { contains: q, mode: "insensitive" } },
                ],
              },
            ],
          },
          select: { id: true, title: true, status: true, priority: true, assignee: { select: { name: true } } },
          orderBy: { updatedAt: "desc" }, take: limit,
        });

        return { success: true, data: issues.map((i) => ({ id: i.id, title: i.title, status: i.status, priority: i.priority, assignee: i.assignee?.name ?? "Unassigned" })) };
      }

      default:
        return { success: false, data: null, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    logAiError("tool_executor_failed", {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      feature: "chat",
      toolName,
      success: false,
      errorCode: error instanceof AppError ? error.code : "TOOL_EXECUTION_FAILED",
      errorMessage: error instanceof Error ? error.message : "Tool execution failed",
    });
    const message = error instanceof AppError ? error.message : "Tool execution failed";
    return { success: false, data: null, error: message };
  }
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutorResult> {
  const result = await executeToolLegacy(toolName, args, ctx);
  return normalizeExecutorResult(result);
}
