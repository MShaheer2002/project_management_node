import { prisma } from "../../shared/utils/prisma.js";
import { incrementAiMetricCounter, logAiInfo } from "./ai.observability.js";
import type { AiIntent } from "./ai.capabilities.js";
import { callAI, CHAT_MODEL_DEFAULT } from "./ai.provider.js";
import {
  resolveEntityReference,
  type EntityResolutionResult,
  type ResolutionRisk,
  type ResolvedEntityType,
} from "./ai.entity-resolution.js";
import { classifyAiIntentHybrid } from "./ai.intent.js";
import { buildResolverContextFromMemory, type ConversationMemory } from "./ai.memory.js";
import { createPendingActionId } from "./ai.memory.js";

type PendingActionName =
  | "create_project"
  | "project_action"
  | "create_issue"
  | "issue_action"
  | "create_document"
  | "invite_member"
  | "analytics_report"
  | "high_impact_action"
  | "delete_boundary";

type PendingActionStatus = "collecting_slots" | "awaiting_confirmation" | "blocked_boundary";

type PendingAmbiguity = {
  field: string;
  candidates: Array<{ id: string; label: string }>;
};

type PendingCapabilityCandidate = {
  intent: AiIntent;
  label: string;
  confidence: number;
};

export type PendingAiAction = {
  pendingActionId?: string;
  action: PendingActionName;
  intent?: AiIntent;
  status: PendingActionStatus;
  slots: Record<string, string>;
  missing: string[];
  ambiguity?: PendingAmbiguity[];
  capabilityCandidates?: PendingCapabilityCandidate[];
  prompt: string;
  createdAt: string;
  updatedAt: string;
  riskLevel?: "low" | "medium" | "high" | "blocked";
  previewText?: string;
  expiresAt?: string;
  executor?: string;
  executorArgsHash?: string;
  confirmationRequired?: boolean;
};

export type AiPreflightDecision =
  | {
      kind: "respond";
      content: string;
      pendingAction: PendingAiAction | null;
    }
  | {
      kind: "continue";
      pendingAction: PendingAiAction | null;
      systemContext?: string;
      confirmedHighImpact?: boolean;
      confirmedHighImpactToolName?: string;
      confirmedHighImpactToolArgsJson?: string;
      compactMode?: "confirmation";
      historyLimit?: number;
      resolvedToolName?: string;
      resolvedToolArgsJson?: string;
      resolvedResponseMode?: "overloaded";
    };

type PreflightInput = {
  message: string;
  pendingAction: PendingAiAction | null;
  conversationMemory?: ConversationMemory | null;
  workspaceId: string;
  userId: string;
  userRole: string;
};

type CandidateResolution = {
  match: { id: string; name: string } | null;
  ambiguity?: Array<{ id: string; label: string }>;
};

type ExtractedEntityMention = {
  mention: string;
  confidence: number;
  reason: string;
};

type ExtractedSlotValue = {
  value: string;
  confidence: number;
  reason: string;
};

type ExtractedProjectUpdateSlots = {
  projectMention?: string | undefined;
  name?: string | undefined;
  status?: string | undefined;
  description?: string | undefined;
  confidence: number;
  reason: string;
};

type ResolverContext = {
  workspaceId: string;
  userId: string;
  userRole: string;
  conversationMemory?: ConversationMemory | null | undefined;
};

const ROLE_PATTERN = /\b(owner|admin|member|guest)\b/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PROJECT_HINT_PATTERN = /\b(?:project|app)\s*:\s*([^\n.]+)/i;
const PROJECT_CREATE_NAME_PATTERNS = [
  /\b(?:create|make|build|open|new)\b[\s,.:;-]*(?:a\b[\s,.:;-]*)?project\b[\s,.:;-]*(?:called|named|titled)\b[\s,.:;-]*["“]?([^"”\n]+?)["”]?\s*[\?.!]*$/iu,
  /\b(?:create|make|build|open|new)\b[\s,.:;-]*(?:a\b[\s,.:;-]*)?project\b[\s,.:;-]*["“]?([^"”\n]+?)["”]?\s*[\?.!]*$/iu,
] as const;
const PROJECT_INLINE_PATTERN = /\b(?:project|app)\s+(?:is\s+)?([A-Z][A-Za-z0-9 _-]{2,80})/;
const PROJECT_SUBJECT_PATTERN = /\b([A-Z0-9][A-Za-z0-9_-]*(?:\s+[A-Z0-9][A-Za-z0-9_-]*){0,4})\s+(?:project|app)\b/u;
const PROJECT_FROM_PATTERN = /\bfrom\s+(.+?)\s+(?:project|app)\b/i;
const PROJECT_TRAILING_PATTERN = /\b(?:in|for)\s+(.+?)\s+(?:project|app)\b/i;
const PROJECT_OBJECT_PATTERN = /\b(?:in|for|of)\s+(.+?)\s*$/i;
const PROJECT_STATUS_PATTERN = /\b([A-Za-z0-9][A-Za-z0-9 _-]{1,80})\s+(?:is|looks?)\s+(?:in\s+bad\s+shape|at\s+risk|healthy|doing\s+well|doing\s+badly)\b/i;
const PROJECT_QUESTION_PATTERN = /\b(?:how\s+is|is)\s+([A-Za-z0-9][A-Za-z0-9 _-]{1,80}?)\s+(?:doing|healthy|at\s+risk|in\s+bad\s+shape|doing\s+well|doing\s+badly)\b/i;
const PROJECT_ABOUT_PATTERN = /\b(?:tell\s+me\s+about|what\s+about|describe|brief\s+me\s+on|summarize|summary\s+of)\s+([A-Za-z0-9][A-Za-z0-9 _-]{1,80})\b/i;
const PROJECT_COMPARE_TARGET_PATTERN = /\b(?:with|vs|versus|against)\s+(.+?)\s*$/i;
const PROJECT_RENAME_PATTERNS = [
  /\b(?:rename|retitle)\s+(.+?)\s+\bto\b\s+(.+?)\s*[\?.!]*$/iu,
  /\b(?:change|update)\s+the\s+name\s+of\s+(.+?)\s+\bto\b\s+(.+?)\s*[\?.!]*$/iu,
  /\b(?:change|update)\s+(.+?)\s+\bto\b\s+(.+?)\s*[\?.!]*$/iu,
] as const;
const TEAM_HINT_PATTERN = /\bteam\s*:\s*([^\n.]+)/i;
const TEAM_INLINE_PATTERN = /\bteam\s+(?:is\s+)?([A-Z][A-Za-z0-9 _-]{2,80})/;
const TEAM_FROM_PATTERN = /\bfrom\s+(.+?)\s+team\b/i;
const TEAM_TRAILING_PATTERN = /\b(?:in|for)\s+(.+?)\s+team\b/i;
const DEPARTMENT_HINT_PATTERN = /\bdepartment\s*:\s*([^\n.]+)/i;
const DEPARTMENT_INLINE_PATTERN = /\bdepartment\s+(?:is\s+)?([A-Z][A-Za-z0-9 _-]{2,80})/;
const DEPARTMENT_FROM_PATTERN = /\bfrom\s+(.+?)\s+department\b/i;
const DEPARTMENT_TRAILING_PATTERN = /\b(?:in|for)\s+(.+?)\s+department\b/i;
const MEMBER_MENTION_PATTERN = /@([^\n,]+?)(?=\s+\bfrom\b|\s+\bto\b|$)/i;
const MEMBER_REMOVE_PATTERN = /\b(?:remove|kick)\s+(.+?)\s+\bfrom\b/i;
const ISSUE_REF_PATTERN = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/i;
const FILE_KEY_PATTERN = /\b(?:file|asset)\s*key\s*:\s*([^\s,]+)/i;
const FILE_NAME_PATTERN = /\bfile\s*name\s*:\s*([^\n]+)/i;
const FILE_SIZE_PATTERN = /\b(?:size|sizeBytes)\s*:\s*(\d+)\b/i;
const CONTENT_TYPE_PATTERN = /\b(?:content[- ]?type|mime)\s*:\s*([^\s,]+)/i;
const ISO_DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/g;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const PENDING_ACTION_TTL_MS = 15 * 60 * 1000;
const ENTITY_EXTRACTION_MODEL = CHAT_MODEL_DEFAULT;

const isAdminRole = (role: string) => role === "OWNER" || role === "ADMIN";

export function parsePendingAiAction(value: unknown): PendingAiAction | null {
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  if (
    typeof record.action !== "string" ||
    !["create_project", "project_action", "create_issue", "issue_action", "create_document", "invite_member", "analytics_report", "high_impact_action", "delete_boundary"].includes(record.action) ||
    typeof record.status !== "string" ||
    !["collecting_slots", "awaiting_confirmation", "blocked_boundary"].includes(record.status)
  ) {
    return null;
  }

  const ambiguity = Array.isArray(record.ambiguity)
    ? record.ambiguity
      .map((entry) => sanitizePendingAmbiguity(entry))
      .filter((entry): entry is PendingAmbiguity => entry !== null)
    : [];
  const capabilityCandidates = Array.isArray(record.capabilityCandidates)
    ? record.capabilityCandidates
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const item = entry as Record<string, unknown>;
        if (typeof item.intent !== "string" || typeof item.label !== "string" || typeof item.confidence !== "number") return null;
        return {
          intent: item.intent as AiIntent,
          label: item.label.trim().slice(0, 120),
          confidence: Math.max(0, Math.min(1, item.confidence)),
        };
      })
      .filter((entry): entry is PendingCapabilityCandidate => entry !== null)
      .slice(0, 5)
    : [];

  return {
    ...(typeof record.pendingActionId === "string" ? { pendingActionId: record.pendingActionId } : {}),
    action: record.action as PendingActionName,
    ...(typeof record.intent === "string" ? { intent: record.intent as AiIntent } : {}),
    status: record.status as PendingActionStatus,
    slots: sanitizeStringRecord(record.slots),
    missing: Array.isArray(record.missing)
      ? record.missing.filter((entry): entry is string => typeof entry === "string")
      : [],
    ...(ambiguity.length > 0 ? { ambiguity } : {}),
    ...(capabilityCandidates.length > 0 ? { capabilityCandidates } : {}),
    prompt: typeof record.prompt === "string" ? record.prompt : "",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
    ...(typeof record.riskLevel === "string" ? { riskLevel: record.riskLevel as PendingAiAction["riskLevel"] } : {}),
    ...(typeof record.previewText === "string" ? { previewText: record.previewText } : {}),
    ...(typeof record.expiresAt === "string" ? { expiresAt: record.expiresAt } : {}),
    ...(typeof record.executor === "string" ? { executor: record.executor } : {}),
    ...(typeof record.executorArgsHash === "string" ? { executorArgsHash: record.executorArgsHash } : {}),
    ...(record.confirmationRequired === true ? { confirmationRequired: true } : {}),
  } as PendingAiAction;
}

export async function resolveAiPreflight(input: PreflightInput): Promise<AiPreflightDecision> {
  const message = input.message.trim();
  const lower = message.toLowerCase();
  const classifiedIntent = await classifyAiIntentHybrid(message, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    allowModel: true,
  });

  if (input.pendingAction && isPendingActionExpired(input.pendingAction)) {
    logAiInfo("chat_confirmation_expired", {
      workspaceId: input.workspaceId,
      userId: input.userId,
      feature: "chat",
      success: true,
      metadata: {
        pendingAction: input.pendingAction.action,
        pendingStatus: input.pendingAction.status,
      },
    });
    void incrementAiMetricCounter({
      workspaceId: input.workspaceId,
      feature: "chat",
      metric: "confirmation_expiration",
      dimensions: {
        pendingAction: input.pendingAction.action,
        pendingStatus: input.pendingAction.status,
      },
    });
    if (shouldTreatAsFreshStandaloneRequest(input.pendingAction, message, lower, classifiedIntent.intent, input.conversationMemory)) {
      logAiInfo("chat_pending_action_replaced", {
        workspaceId: input.workspaceId,
        userId: input.userId,
        feature: "chat",
        success: true,
        metadata: {
          reason: "expired_then_new_request",
          previousAction: input.pendingAction.action,
          nextIntent: classifiedIntent.intent,
        },
      });
      return resolveAiPreflight({ ...input, pendingAction: null });
    }

    return {
      kind: "respond",
      pendingAction: null,
      content: "That pending action expired. Please send the full request again.",
    };
  }

  if (input.pendingAction?.action === "delete_boundary") {
    return resolveDeleteBoundaryTurn(input);
  }

  if (input.pendingAction?.status === "collecting_slots" && shouldTreatAsFreshStandaloneRequest(input.pendingAction, message, lower, classifiedIntent.intent, input.conversationMemory)) {
    logAiInfo("chat_pending_action_replaced", {
      workspaceId: input.workspaceId,
      userId: input.userId,
      feature: "chat",
      success: true,
      metadata: {
        reason: "new_top_level_request",
        previousAction: input.pendingAction.action,
        nextIntent: classifiedIntent.intent,
      },
    });
    return resolveAiPreflight({ ...input, pendingAction: null });
  }

  if (input.pendingAction?.status === "awaiting_confirmation") {
    return resolveConfirmationTurn(input.pendingAction, message);
  }

  if (input.pendingAction?.status === "collecting_slots") {
    return resolvePendingSlotTurn(input);
  }

  if (classifiedIntent.intent === "DELETE_REQUEST_BLOCKED" || isDeleteIntent(lower)) {
    const targetRef = extractIssueRef(message);
    const pending = createPendingAction(
      "delete_boundary",
      message,
      targetRef ? { targetRef } : {},
      [],
      "blocked_boundary",
      false,
      {
        intent: "DELETE_REQUEST_BLOCKED",
        riskLevel: "blocked",
        previewText: "Delete request blocked by policy.",
      },
    );

    logAiInfo("chat_policy_blocked", {
      workspaceId: input.workspaceId,
      userId: input.userId,
      feature: "chat",
      success: true,
      metadata: {
        blockedIntent: "DELETE_REQUEST_BLOCKED",
        targetRef: targetRef ?? null,
      },
    });
    void incrementAiMetricCounter({
      workspaceId: input.workspaceId,
      feature: "chat",
      metric: "blocked_policy",
      dimensions: {
        blockedIntent: "DELETE_REQUEST_BLOCKED",
      },
    });

    return {
      kind: "respond",
      pendingAction: pending,
      content: "Trussen AI cannot delete anything. I can help with safer alternatives like archiving, completing, deactivating, unassigning, or showing you where to do a manual admin action.",
    };
  }

  if (classifiedIntent.intent === "IRREVERSIBLE_ACTION_BLOCKED") {
    logAiInfo("chat_policy_blocked", {
      workspaceId: input.workspaceId,
      userId: input.userId,
      feature: "chat",
      success: true,
      metadata: {
        blockedIntent: "IRREVERSIBLE_ACTION_BLOCKED",
      },
    });
    void incrementAiMetricCounter({
      workspaceId: input.workspaceId,
      feature: "chat",
      metric: "blocked_policy",
      dimensions: {
        blockedIntent: "IRREVERSIBLE_ACTION_BLOCKED",
      },
    });

    return {
      kind: "respond",
      pendingAction: null,
      content: "Trussen AI cannot make destructive billing, subscription, API key, credential, or integration-destruction changes. Use the workspace settings or admin console for those manual actions.",
    };
  }

  if (isVagueRevertIntent(lower)) {
    return {
      kind: "respond",
      pendingAction: null,
      content: "I need the exact restore action before changing anything. Tell me the issue ID and the value to restore, for example: `set FIS-15 back to todo` or `unassign FIS-15`.",
    };
  }

  const membershipRemoval = await buildMembershipRemovalPendingAction(message, input.workspaceId, input.userId, input.userRole, input.conversationMemory);
  if (membershipRemoval) {
    if (membershipRemoval.status === "awaiting_confirmation") {
      return {
        kind: "respond",
        pendingAction: membershipRemoval,
        content: buildHighImpactConfirmationPrompt(membershipRemoval),
      };
    }

    return {
      kind: "respond",
      pendingAction: membershipRemoval,
      content: questionForMissingSlot(membershipRemoval),
    };
  }

  if (classifiedIntent.intent === "ROLE_OR_ACCESS_QUESTION") {
    return {
      kind: "continue",
      pendingAction: null,
      resolvedToolName: "get_workspace_access_summary",
      resolvedToolArgsJson: JSON.stringify({}),
      systemContext: "The user is asking about their role or access. Answer directly from the workspace access summary tool result.",
    };
  }

  if (isHighImpactIntent(lower)) {
    return {
      kind: "continue",
      pendingAction: null,
      systemContext: [
        "High-impact mutation guidance:",
        "Resolve the exact target and exact tool arguments first.",
        "Do not ask for confirmation until the exact tool and exact args are known.",
        "If the tool returns confirmationRequired, stop and ask the user to reply Confirm or Cancel.",
        "Do not execute a different substitute action.",
      ].join("\n"),
    };
  }

  if (classifiedIntent.intent === "INVITE_MEMBER") {
    const pending = await buildInvitePendingAction(message, input.workspaceId, input.userId, input.userRole, input.conversationMemory);
    if (pending.missing.length > 0) {
      return {
        kind: "respond",
        pendingAction: pending,
        content: questionForMissingSlot(pending),
      };
    }

    return continueWithResolvedAction(pending, "Invite member details are resolved. Use the invite_member tool with these slots.");
  }

  if (classifiedIntent.intent === "CREATE_PROJECT") {
    const pending = await buildCreateProjectPendingAction(message, input.workspaceId, input.userId, input.userRole, input.conversationMemory);
    if (pending.missing.length > 0 || (pending.ambiguity?.length ?? 0) > 0) {
      return {
        kind: "respond",
        pendingAction: pending,
        content: questionForMissingSlot(pending),
      };
    }

    return buildDirectResolvedToolDecision(
      "create_project",
      {
        name: pending.slots.name,
        teamId: pending.slots.teamId,
      },
      "Project creation is fully resolved. Create the project once with the exact resolved name and team.",
    );
  }

  if (classifiedIntent.intent === "UPDATE_PROJECT") {
    const pending = await buildProjectUpdatePendingAction(
      message,
      input.workspaceId,
      input.userId,
      input.userRole,
      input.conversationMemory,
    );
    if (pending.missing.length > 0 || (pending.ambiguity?.length ?? 0) > 0) {
      return {
        kind: "respond",
        pendingAction: pending,
        content: questionForMissingSlot(pending),
      };
    }

    if (typeof pending.slots.toolName === "string" && typeof pending.slots.toolArgsJson === "string") {
      return buildDirectResolvedToolDecision(
        pending.slots.toolName,
        JSON.parse(pending.slots.toolArgsJson),
        "The project update was resolved safely. Execute the exact tool call once and summarize the result clearly.",
      );
    }

    return continueWithPendingResolvedAction(
      pending,
      "The project update has enough detail to continue deterministically. Resolve any remaining project ambiguity before mutating.",
    );
  }

  if (classifiedIntent.intent === "CREATE_ISSUE") {
    const pending = await buildCreateIssuePendingAction(message, input.workspaceId, input.userId, input.userRole, input.conversationMemory);
    if (pending.missing.length > 0) {
      return {
        kind: "respond",
        pendingAction: pending,
        content: questionForMissingSlot(pending),
      };
    }

    return continueWithResolvedAction(
      pending,
      "Issue creation project is resolved. Use the create_issue tool with the original user request and these slots.",
    );
  }

  if (classifiedIntent.intent === "COMPARE_PROJECTS") {
    return buildCompareProjectsDecision(message, input.workspaceId, input.userId, input.userRole, input.conversationMemory);
  }

  if (classifiedIntent.intent === "LIST_PROJECTS") {
    return buildDirectResolvedToolDecision(
      "list_projects",
      {},
      "The user is asking for the visible project list. Return the current visible projects only.",
    );
  }

  if (classifiedIntent.intent === "MY_TASKS") {
    return buildDirectResolvedToolDecision(
      "list_issues",
      { assigneeId: "me" },
      "The user is asking for their assigned tasks. Return only the current visible issues assigned to them.",
    );
  }

  if (classifiedIntent.intent === "SEARCH_ISSUES") {
    return buildDirectResolvedToolDecision(
      "search_issues",
      { query: message },
      "The user is searching issues. Use the original request as the search query and summarize only grounded matches.",
    );
  }

  if (classifiedIntent.intent === "OVERDUE_TASKS") {
    return buildDirectResolvedToolDecision(
      "list_issues",
      { overdueOnly: true },
      "The user is asking for overdue tasks. Return only overdue visible issues.",
    );
  }

  if (classifiedIntent.intent === "BLOCKED_TASKS") {
    return buildDirectResolvedToolDecision(
      "list_issues",
      { blockedOnly: true },
      "The user is asking for blocked tasks. Return only visible blocked issues.",
    );
  }

  if (classifiedIntent.intent === "APP_NAVIGATION_HELP") {
    return buildDirectResolvedToolDecision(
      "app_help",
      { query: message },
      "The user is asking where to find something in the app. Answer with the relevant navigation path only.",
    );
  }

  if (
    classifiedIntent.intent === "ASSIGN_ISSUE" ||
    classifiedIntent.intent === "UPDATE_ISSUE_STATUS" ||
    classifiedIntent.intent === "ADD_COMMENT"
  ) {
    const pending = await buildIssueActionPendingAction(
      classifiedIntent.intent,
      message,
      input.workspaceId,
      input.userId,
      input.userRole,
      input.conversationMemory,
    );

    if (pending.missing.length > 0 || (pending.ambiguity?.length ?? 0) > 0) {
      return {
        kind: "respond",
        pendingAction: pending,
        content: questionForMissingSlot(pending),
      };
    }

    if (typeof pending.slots.toolName === "string" && typeof pending.slots.toolArgsJson === "string") {
      return buildDirectResolvedToolDecision(
        pending.slots.toolName,
        JSON.parse(pending.slots.toolArgsJson),
        "The issue mutation was resolved safely. Execute the exact tool call once and summarize the result clearly.",
      );
    }

    return continueWithPendingResolvedAction(
      pending,
      "The issue action has enough detail to continue through a deterministic multi-step plan. Resolve any remaining issue or member query safely before mutating.",
    );
  }

  if (isCreateDocumentIntent(lower)) {
    const pending = await buildCreateDocumentPendingAction(message, input.workspaceId, input.userId, input.userRole, input.conversationMemory);
    if (pending.missing.length > 0 || (pending.ambiguity?.length ?? 0) > 0) {
      return {
        kind: "respond",
        pendingAction: pending,
        content: questionForMissingSlot(pending),
      };
    }

    return continueWithResolvedAction(
      pending,
      "Document creation context is resolved. Use the create_document tool only if a valid uploaded file reference is available. Do not invent file metadata.",
    );
  }

  if (
    classifiedIntent.intent === "PROJECT_REPORT" ||
    classifiedIntent.intent === "PROJECT_HEALTH" ||
    classifiedIntent.intent === "PROJECT_PROGRESS" ||
    classifiedIntent.intent === "PROJECT_RISK" ||
    classifiedIntent.intent === "TEAM_REPORT" ||
    classifiedIntent.intent === "TEAM_WORKLOAD" ||
    classifiedIntent.intent === "INDIVIDUAL_REPORT" ||
    classifiedIntent.intent === "USER_WORKLOAD" ||
    classifiedIntent.intent === "CYCLE_STATUS" ||
    classifiedIntent.intent === "WORKSPACE_SUMMARY" ||
    classifiedIntent.intent === "PERFORMANCE_REPORT" ||
    classifiedIntent.intent === "WHO_IS_OVERLOADED"
  ) {
    const preferredScopeKind =
      classifiedIntent.intent === "PROJECT_REPORT" || classifiedIntent.intent === "PROJECT_HEALTH" || classifiedIntent.intent === "PROJECT_PROGRESS" || classifiedIntent.intent === "PROJECT_RISK"
        ? "project"
        : classifiedIntent.intent === "TEAM_REPORT" || classifiedIntent.intent === "TEAM_WORKLOAD"
          ? "team"
          : classifiedIntent.intent === "INDIVIDUAL_REPORT" || classifiedIntent.intent === "USER_WORKLOAD"
            ? "member"
            : classifiedIntent.intent === "CYCLE_STATUS"
              ? "cycle"
              : classifiedIntent.intent === "WORKSPACE_SUMMARY" || classifiedIntent.intent === "PERFORMANCE_REPORT"
                ? "workspace"
                : undefined;

    const pending = await buildAnalyticsPendingAction(message, input.workspaceId, input.userId, input.userRole, preferredScopeKind, input.conversationMemory);
    if (pending.missing.length > 0 || (pending.ambiguity?.length ?? 0) > 0) {
      void incrementAiMetricCounter({
        workspaceId: input.workspaceId,
        feature: "chat",
        metric: "clarification_requested",
        dimensions: {
          intent: classifiedIntent.intent,
          missing: pending.missing.join(",") || "none",
          ambiguity: (pending.ambiguity?.length ?? 0) > 0 ? "yes" : "no",
        },
      });
      return {
        kind: "respond",
        pendingAction: pending,
        content: questionForMissingSlot(pending),
      };
    }

    return continueWithResolvedAnalytics(pending);
  }

  if (classifiedIntent.intent === "UNKNOWN" && classifiedIntent.capabilityCandidates?.length) {
    if (classifiedIntent.preferredScopeKind) {
      const pending = await buildAnalyticsPendingAction(
        message,
        input.workspaceId,
        input.userId,
        input.userRole,
        classifiedIntent.preferredScopeKind,
        input.conversationMemory,
      );
      if (pending.missing.length > 0 || (pending.ambiguity?.length ?? 0) > 0) {
        void incrementAiMetricCounter({
          workspaceId: input.workspaceId,
          feature: "chat",
          metric: "clarification_requested",
          dimensions: {
            intent: "UNKNOWN",
            reason: "semantic_scope_inferred",
          },
        });
        return {
          kind: "respond",
          pendingAction: pending,
          content: questionForMissingSlot(pending),
        };
      }

      return continueWithResolvedAnalytics(pending);
    }

    const inferredPending = await inferAnalyticsPendingActionFromEntity(
      message,
      input.workspaceId,
      input.userId,
      input.userRole,
      input.conversationMemory,
    );
    if (inferredPending) {
      if (inferredPending.missing.length > 0 || (inferredPending.ambiguity?.length ?? 0) > 0) {
        return {
          kind: "respond",
          pendingAction: inferredPending,
          content: questionForMissingSlot(inferredPending),
        };
      }

      return continueWithResolvedAnalytics(inferredPending);
    }

    const pending = createPendingAction("analytics_report", message, {}, ["scope"], "collecting_slots", false, {
      intent: "PERFORMANCE_REPORT",
      riskLevel: "low",
      capabilityCandidates: classifiedIntent.capabilityCandidates.slice(0, 5).map((candidate) => ({
        intent: candidate.intent,
        label: capabilityLabelForIntent(candidate.intent),
        confidence: candidate.confidence,
      })),
    });
    void incrementAiMetricCounter({
      workspaceId: input.workspaceId,
      feature: "chat",
      metric: "clarification_requested",
      dimensions: {
        intent: "UNKNOWN",
        reason: "capability_candidates",
      },
    });
    return {
      kind: "respond",
      pendingAction: pending,
      content: questionForMissingSlot(pending),
    };
  }

  if (classifiedIntent.intent === "UNKNOWN") {
    const contextualPending = await inferAnalyticsPendingActionFromConversationContext(
      message,
      lower,
      input.workspaceId,
      input.userId,
      input.userRole,
      input.conversationMemory,
    );

    if (contextualPending) {
      if (contextualPending.missing.length > 0 || (contextualPending.ambiguity?.length ?? 0) > 0) {
        return {
          kind: "respond",
          pendingAction: contextualPending,
          content: questionForMissingSlot(contextualPending),
        };
      }

      return continueWithResolvedAnalytics(contextualPending);
    }
  }

  return {
    kind: "continue",
    pendingAction: null,
    ...(classifiedIntent.intent !== "UNKNOWN"
      ? {
          systemContext: [
            `Detected semantic intent: ${classifiedIntent.intent}`,
            `Intent reason: ${classifiedIntent.reason}`,
            "If you use tools, stay within this intent boundary unless the user explicitly redirects the request.",
          ].join("\n"),
        }
      : {}),
  };
}

function createPendingAction(
  action: PendingActionName,
  prompt: string,
  slots: Record<string, string>,
  missing: string[],
  status: PendingActionStatus,
  confirmationRequired = false,
  options?: {
    intent?: AiIntent;
    riskLevel?: PendingAiAction["riskLevel"];
    previewText?: string;
    executor?: string;
    expiresAt?: string;
    capabilityCandidates?: PendingCapabilityCandidate[];
  },
): PendingAiAction {
  const now = new Date().toISOString();
  const expiresAt = options?.expiresAt ?? new Date(Date.now() + PENDING_ACTION_TTL_MS).toISOString();
  return {
    pendingActionId: createPendingActionId(),
    action,
    ...(options?.intent ? { intent: options.intent } : {}),
    status,
    slots,
    missing,
    prompt,
    createdAt: now,
    updatedAt: now,
    ...(options?.riskLevel ? { riskLevel: options.riskLevel } : {}),
    ...(options?.previewText ? { previewText: options.previewText } : {}),
    ...(options?.executor ? { executor: options.executor } : {}),
    ...(options?.capabilityCandidates?.length ? { capabilityCandidates: options.capabilityCandidates } : {}),
    expiresAt,
    ...(confirmationRequired ? { confirmationRequired: true } : {}),
  };
}

function sanitizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => typeof entry === "string" && entry.trim().length > 0)
      .map(([key, entry]) => [key, String(entry).trim().slice(0, 500)]),
  );
}

function sanitizePendingAmbiguity(value: unknown): PendingAmbiguity | null {
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  if (typeof record.field !== "string" || !Array.isArray(record.candidates)) return null;

  const candidates = record.candidates
    .map((candidate) => {
      if (!candidate || typeof candidate !== "object") return null;
      const item = candidate as Record<string, unknown>;
      if (typeof item.id !== "string" || typeof item.label !== "string") return null;
      return {
        id: item.id.trim().slice(0, 200),
        label: item.label.trim().slice(0, 200),
      };
    })
    .filter((candidate): candidate is { id: string; label: string } => candidate !== null)
    .slice(0, 5);

  if (candidates.length === 0) return null;
  return { field: record.field, candidates };
}

function isDeleteIntent(lower: string) {
  return /\b(delete|deleted|deleting|delte|destroy|permanently remove|hard remove|wipe)\b/.test(lower);
}

function extractIssueRef(message: string) {
  return message.match(ISSUE_REF_PATTERN)?.[0]?.toUpperCase();
}

function isVagueRevertIntent(lower: string) {
  return /\b(revert|undo|rollback|roll back|put it back)\b/.test(lower) &&
    !/\b[A-Z]{2,10}-\d+\b/i.test(lower) &&
    !/\b(backlog|todo|in-progress|in progress|review|done|unassign|assign)\b/.test(lower);
}

function isManualDeleteHelpIntent(lower: string) {
  return (
    /\b(how|where|manual|manually|ui|button|myself|by myself|from the app|from trussen)\b.*\b(delete|deleting|remove|removing)\b/.test(lower) ||
    /\b(delete|deleting|remove|removing)\b.*\b(manual|manually|ui|button|myself|by myself|from the app|from trussen)\b/.test(lower)
  );
}

function isExplicitAllowedAlternative(lower: string) {
  const hasIssueRef = /\b[a-z][a-z0-9]{1,9}-\d+\b/i.test(lower);
  if (!hasIssueRef) return false;

  return (
    /\b(mark|move|set|change)\b.*\b(backlog|todo|to do|in-progress|in progress|review|done|complete|completed)\b/.test(lower) ||
    /\b(unassign|remove assignee|clear assignee)\b/.test(lower) ||
    /\b(assign)\b.*\b(to|me)\b/.test(lower) ||
    /\b(add|write|post)\b.*\b(comment|note)\b/.test(lower)
  );
}

function isDeletePressureContinuation(lower: string) {
  return (
    isDeleteIntent(lower) ||
    /^\s*(please+|pls|plz|do it|proceed|yes|confirm|ok|okay|go ahead|i need it|i order you|must|no)\b/i.test(lower) ||
    /\b(it|that|same one|this one)\b/.test(lower) && /\b(delete|remove|do it|please|order|need|must)\b/.test(lower)
  );
}

function isUnrelatedTopLevelIntentAfterDeleteBoundary(lower: string) {
  return (
    isCreateIssueIntent(lower) ||
    isCreateDocumentIntent(lower) ||
    isInviteIntent(lower) ||
    isAnalyticsIntent(lower) ||
    isHighImpactIntent(lower)
  ) && !isDeleteIntent(lower);
}

function isHighImpactIntent(lower: string) {
  return (
    /\b(change|set|make|promote|demote)\b.*\b(owner|admin|member|guest|role)\b/.test(lower) ||
    /\b(remove|kick)\b.*\b(member|user|person|teammate)\b/.test(lower) ||
    /\b(remove|kick)\b.*\bfrom\b.*\b(team|department|project|workspace)\b/.test(lower) ||
    /\b(archive|complete|reopen|carry over|carryover)\b.*\b(project|cycle|sprint)\b/.test(lower) ||
    /\b(project|cycle|sprint)\b.*\b(archived|archive|completed|complete|reopen|carry over|carryover)\b/.test(lower)
  );
}

function isInviteIntent(lower: string) {
  return /\b(invite|send invite|add someone)\b/.test(lower);
}

function isCreateIssueIntent(lower: string) {
  return /\b(create|new|open|file)\b.*\b(issue|task|bug)\b/.test(lower);
}

function isUpdateProjectIntent(lower: string) {
  return (/\b(rename|retitle)\b/.test(lower) || (/\b(change|update)\b/.test(lower) && /\bname\b/.test(lower)))
    && !/\b(issue|task|bug|team|department|cycle|sprint)\b/.test(lower);
}

function isCreateDocumentIntent(lower: string) {
  return /\b(create|add|upload|attach|save)\b.*\b(document|doc|brief|runbook|sop|file)\b/.test(lower);
}

function isAnalyticsIntent(lower: string) {
  return /\b(analytics|report|progress|performance|summary|status|overloaded|velocity|burndown|trend|export|download)\b/.test(lower);
}

function isTopLevelIntent(lower: string) {
  return isDeleteIntent(lower) ||
    isHighImpactIntent(lower) ||
    isInviteIntent(lower) ||
    isCreateIssueIntent(lower) ||
    isUpdateProjectIntent(lower) ||
    isCreateDocumentIntent(lower) ||
    isAnalyticsIntent(lower);
}

function shouldTreatAsFreshStandaloneRequest(
  pending: PendingAiAction,
  message: string,
  lower: string,
  classifiedIntent: AiIntent,
  conversationMemory?: ConversationMemory | null,
) {
  if (containsConversationReference(message, conversationMemory)) {
    return false;
  }

  if (looksLikePendingSlotContinuation(pending, message, lower)) {
    return false;
  }

  return isTopLevelIntent(lower) || classifiedIntent !== "UNKNOWN";
}

function containsConversationReference(message: string, conversationMemory?: ConversationMemory | null) {
  const lower = message.trim().toLowerCase();
  if (/^(assign|move|mark|compare)\s+(it|that|this|them|those|these)\b/.test(lower)) return true;
  if (/^(yes|confirm|proceed|go ahead)\b/.test(lower) && conversationMemory?.pendingConfirmation) return true;
  return (conversationMemory?.recentReferences ?? []).some((reference) => lower.includes(reference));
}

function looksLikePendingSlotContinuation(
  pending: PendingAiAction,
  message: string,
  lower: string,
) {
  if (pending.action === "invite_member") {
    if (EMAIL_PATTERN.test(message) || ROLE_PATTERN.test(message)) return true;
    if (pending.missing.includes("team") && !isTopLevelIntent(lower)) return true;
  }

  if (pending.action === "create_project") {
    if (pending.missing.includes("name") && !isTopLevelIntent(lower)) return true;
    if (pending.missing.includes("team") && !isTopLevelIntent(lower)) return true;
  }

  if (pending.action === "project_action") {
    if ((pending.missing.includes("project") || pending.missing.includes("updateField")) && !isTopLevelIntent(lower)) {
      return true;
    }
  }

  if (pending.action === "create_issue") {
    if (pending.missing.includes("project") && !isCreateIssueIntent(lower) && !isTopLevelIntent(lower)) return true;
  }

  if (pending.action === "create_document") {
    if (!isCreateDocumentIntent(lower) && (
      FILE_KEY_PATTERN.test(message) ||
      FILE_NAME_PATTERN.test(message) ||
      FILE_SIZE_PATTERN.test(message) ||
      CONTENT_TYPE_PATTERN.test(message) ||
      /^(workspace|team|project)\b/i.test(message.trim())
    )) {
      return true;
    }
  }

  if (pending.action === "analytics_report") {
    if (pending.missing.includes("scope") && /^(workspace|project|app|team|member|user|me|cycle|sprint)\b/i.test(message.trim())) {
      return true;
    }

    if (
      (pending.missing.includes("project") || pending.missing.includes("team") || pending.missing.includes("member") || pending.missing.includes("cycle")) &&
      !isTopLevelIntent(lower)
    ) {
      return true;
    }
  }

  if (pending.action === "high_impact_action") {
    if (!isTopLevelIntent(lower) || /^\s*(confirm|cancel)\s*$/i.test(message)) {
      return true;
    }
  }

  return false;
}

function isPendingActionExpired(pending: PendingAiAction) {
  const updatedAt = Date.parse(pending.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt > PENDING_ACTION_TTL_MS;
}

async function buildMembershipRemovalPendingAction(
  message: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  conversationMemory?: ConversationMemory | null,
) {
  if (!/\b(remove|kick)\b/i.test(message) || !/\bfrom\b/i.test(message)) {
    return null;
  }

  const scopeKind = resolveMembershipRemovalScope(message);
  if (!scopeKind) return null;

  const slots: Record<string, string> = {
    intent: "membership_removal",
    scopeKind,
  };
  const ambiguity: PendingAmbiguity[] = [];

  const member = await resolveMemberReference(message, workspaceId, userId, userRole, conversationMemory, "REMOVE_MEMBER");
  if (member.match) {
    slots.userId = member.match.id;
    slots.memberLabel = member.match.name;
  }
  if (member.ambiguity) ambiguity.push({ field: "member", candidates: member.ambiguity });

  if (scopeKind === "team") {
    const team = await resolveTeamReference(message, workspaceId, userId, userRole, conversationMemory, "REMOVE_MEMBER");
    if (team.match) {
      slots.teamId = team.match.id;
      slots.scopeLabel = team.match.name;
    }
    if (team.ambiguity) ambiguity.push({ field: "team", candidates: team.ambiguity });
  } else if (scopeKind === "project") {
    const project = await resolveProjectReference(message, workspaceId, userId, userRole, conversationMemory, "REMOVE_MEMBER");
    if (project.match) {
      slots.projectId = project.match.id;
      slots.scopeLabel = project.match.name;
    }
    if (project.ambiguity) ambiguity.push({ field: "project", candidates: project.ambiguity });
  } else if (scopeKind === "department") {
    const department = await resolveDepartmentReference(message, workspaceId, userId, userRole, conversationMemory, "REMOVE_MEMBER");
    if (department.match) {
      slots.departmentId = department.match.id;
      slots.scopeLabel = department.match.name;
    }
    if (department.ambiguity) ambiguity.push({ field: "department", candidates: department.ambiguity });
  } else {
    slots.scopeLabel = "the workspace";
  }

  const missing = [
    ...(!slots.userId ? ["member"] : []),
    ...((scopeKind === "team" && !slots.teamId) ? ["team"] : []),
    ...((scopeKind === "project" && !slots.projectId) ? ["project"] : []),
    ...((scopeKind === "department" && !slots.departmentId) ? ["department"] : []),
  ];

  const pending = {
    ...createPendingAction("high_impact_action", message, slots, missing, missing.length > 0 || ambiguity.length > 0 ? "collecting_slots" : "awaiting_confirmation", true, {
      intent: "REMOVE_MEMBER",
      riskLevel: "high",
      previewText: slots.memberLabel && slots.scopeLabel ? `Remove ${slots.memberLabel} from ${slots.scopeLabel}` : "Membership removal requires confirmation.",
      ...(missing.length === 0 && ambiguity.length === 0 ? { executor: membershipRemovalToolForScope(scopeKind) } : {}),
    }),
    ...(ambiguity.length > 0 ? { ambiguity } : {}),
  };

  if (missing.length === 0 && ambiguity.length === 0) {
    const tool = membershipRemovalToolForScope(scopeKind);
    const toolArgs = membershipRemovalToolArgs(scopeKind, slots);
    pending.slots.toolName = tool;
    pending.slots.toolArgsJson = JSON.stringify(toolArgs);
  }

  return pending;
}

async function buildInvitePendingAction(
  message: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  conversationMemory?: ConversationMemory | null,
) {
  const slots: Record<string, string> = {};
  const ambiguity: PendingAmbiguity[] = [];
  const email = message.match(EMAIL_PATTERN)?.[0];
  const role = message.match(ROLE_PATTERN)?.[1];

  if (email) slots.email = email.toLowerCase();
  if (role) slots.role = role.toUpperCase();

  const team = await resolveTeamReference(message, workspaceId, userId, userRole, conversationMemory, "INVITE_MEMBER");
  if (team.match) slots.teamId = team.match.id;
  if (team.ambiguity) ambiguity.push({ field: "team", candidates: team.ambiguity });

  const missing = [
    ...(!slots.email ? ["email"] : []),
    ...(!slots.role ? ["role"] : []),
    ...(!slots.teamId ? ["team"] : []),
  ];

  return {
    ...createPendingAction("invite_member", message, slots, missing, "collecting_slots", false, {
      intent: "INVITE_MEMBER",
      riskLevel: "medium",
    }),
    ...(ambiguity.length > 0 ? { ambiguity } : {}),
  };
}

async function buildCreateIssuePendingAction(
  message: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  conversationMemory?: ConversationMemory | null,
) {
  const slots: Record<string, string> = {};
  const ambiguity: PendingAmbiguity[] = [];
  let project = await resolveProjectReference(message, workspaceId, userId, userRole, conversationMemory, "CREATE_ISSUE");
  if (!project.match && !project.ambiguity) {
    const trailingMention = message.match(PROJECT_OBJECT_PATTERN)?.[1]?.trim();
    if (trailingMention) {
      project = mapEntityResolutionToCandidateResolution(await resolveEntityReference({
        workspaceId,
        userId,
        userRole,
        rawMessage: message,
        mention: trailingMention,
        expectedEntityTypes: ["project"],
        accessMode: "read",
        actionRisk: "low",
        triggeringIntent: "CREATE_ISSUE",
        currentContext: buildResolverContextFromMemory(conversationMemory),
      }));
    }
  }

  if (project.match) slots.projectId = project.match.id;
  if (project.ambiguity) ambiguity.push({ field: "project", candidates: project.ambiguity });

  const missing = !slots.projectId ? ["project"] : [];
  return {
    ...createPendingAction("create_issue", message, slots, missing, "collecting_slots", false, {
      intent: "CREATE_ISSUE",
      riskLevel: "low",
      ...(slots.projectId ? { executor: "create_issue" } : {}),
    }),
    ...(ambiguity.length > 0 ? { ambiguity } : {}),
  };
}

function extractProjectNameForCreate(message: string) {
  for (const pattern of PROJECT_CREATE_NAME_PATTERNS) {
    const match = message.match(pattern)?.[1]?.trim();
    if (match && match.length > 1) {
      return sanitizeFreeformNameValue(match);
    }
  }
  return undefined;
}

function sanitizeFreeformNameValue(value: string) {
  return value
    .replace(/^["“'`]+|["”'`]+$/gu, "")
    .replace(/[\s,.:;-]+$/u, "")
    .trim();
}

function looksLikeDirectNameReply(message: string) {
  const trimmed = sanitizeFreeformNameValue(message);
  if (trimmed.length < 2 || trimmed.length > 120) return false;
  if (EMAIL_PATTERN.test(trimmed)) return false;
  if (ISSUE_REF_PATTERN.test(trimmed)) return false;
  if (/^(confirm|cancel|yes|no)$/iu.test(trimmed)) return false;
  return !/[.!?]\s+\p{L}/u.test(trimmed);
}

async function extractProjectNameForCreateSemantic(input: {
  message: string;
  workspaceId: string;
  userId: string;
  allowDirectReplyFallback?: boolean;
}): Promise<ExtractedSlotValue | null> {
  const direct = extractProjectNameForCreate(input.message);
  if (direct) {
    return { value: direct, confidence: 1, reason: "Deterministic create-project name extraction." };
  }

  try {
    const result = await callAI([
      {
        role: "system",
        content: [
          "You extract the project name from a project-creation request.",
          "The message may use any language, mixed language, typos, slang, punctuation noise, or broken grammar.",
          "Return strict JSON only: {\"value\":string|null,\"confidence\":0.0-1.0,\"reason\":string}.",
          "Extract only the new project name the user wants created.",
          "If the message does not provide a project name, return value=null.",
          "Do not invent names. Do not include extra explanation text.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          intent: "CREATE_PROJECT",
          message: input.message,
        }),
      },
    ], {
      model: ENTITY_EXTRACTION_MODEL,
      taskType: "chat_response",
      maxTokens: 140,
      temperature: 0.1,
    });

    const parsed = JSON.parse(sanitizeJsonEnvelope(result.content)) as {
      value?: string | null;
      confidence?: number;
      reason?: string;
    };

    const value = typeof parsed.value === "string" ? sanitizeFreeformNameValue(parsed.value) : "";
    if (value.length >= 2 && value.length <= 120) {
      return {
        value,
        confidence: typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.7,
        reason: typeof parsed.reason === "string" && parsed.reason.trim().length > 0
          ? parsed.reason.trim()
          : "Model-assisted project name extraction.",
      };
    }
  } catch {
    // Fall through to deterministic direct-reply fallback.
  }

  if (input.allowDirectReplyFallback && looksLikeDirectNameReply(input.message)) {
    const value = sanitizeFreeformNameValue(input.message);
    if (value.length >= 2 && value.length <= 120) {
      return {
        value,
        confidence: 0.72,
        reason: "Accepted direct reply as project name while collecting the missing slot.",
      };
    }
  }

  return null;
}

async function buildCreateProjectPendingAction(
  message: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  conversationMemory?: ConversationMemory | null,
) {
  const slots: Record<string, string> = {};
  const ambiguity: PendingAmbiguity[] = [];

  const name = await extractProjectNameForCreateSemantic({
    message,
    workspaceId,
    userId,
  });
  if (name?.value) slots.name = name.value;

  const explicitTeamMention = extractEntityMention(
    message,
    TEAM_HINT_PATTERN,
    TEAM_INLINE_PATTERN,
    [TEAM_FROM_PATTERN, TEAM_TRAILING_PATTERN],
  );
  if (explicitTeamMention) {
    const team = await resolveTeamReference(message, workspaceId, userId, userRole, conversationMemory, "CREATE_PROJECT");
    if (team.match) slots.teamId = team.match.id;
    if (team.ambiguity) ambiguity.push({ field: "team", candidates: team.ambiguity });
  }

  const missing = [
    ...(!slots.name ? ["name"] : []),
    ...(!slots.teamId ? ["team"] : []),
  ];

  return {
    ...createPendingAction("create_project", message, slots, missing, "collecting_slots", false, {
      intent: "CREATE_PROJECT",
      riskLevel: "low",
      ...(slots.name && slots.teamId ? { executor: "create_project" } : {}),
    }),
    ...(ambiguity.length > 0 ? { ambiguity } : {}),
  };
}

function extractProjectRenameDeterministic(message: string): ExtractedProjectUpdateSlots | null {
  for (const pattern of PROJECT_RENAME_PATTERNS) {
    const match = message.match(pattern);
    const projectMention = match?.[1] ? sanitizeFreeformNameValue(match[1]) : "";
    const nextName = match?.[2] ? sanitizeFreeformNameValue(match[2]) : "";
    if (projectMention.length >= 2 && nextName.length >= 2) {
      return {
        projectMention,
        name: nextName,
        confidence: 1,
        reason: "Deterministic project rename extraction.",
      };
    }
  }
  return null;
}

async function extractProjectUpdateSlotsSemantic(input: {
  message: string;
  workspaceId: string;
  userId: string;
}): Promise<ExtractedProjectUpdateSlots | null> {
  const direct = extractProjectRenameDeterministic(input.message);
  if (direct) return direct;

  try {
    const result = await callAI([
      {
        role: "system",
        content: [
          "You extract project-update slots from a user request.",
          "The message may use any language, mixed language, typos, slang, punctuation noise, or broken grammar.",
          "Return strict JSON only: {\"projectMention\":string|null,\"name\":string|null,\"status\":string|null,\"description\":string|null,\"confidence\":0.0-1.0,\"reason\":string}.",
          "Extract only grounded values present in the message.",
          "If the request is a rename, set projectMention and name.",
          "If a field is not present, return null for that field.",
          "Do not invent project names or descriptions.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          intent: "UPDATE_PROJECT",
          message: input.message,
        }),
      },
    ], {
      model: ENTITY_EXTRACTION_MODEL,
      taskType: "chat_response",
      maxTokens: 180,
      temperature: 0.1,
    });

    const parsed = JSON.parse(sanitizeJsonEnvelope(result.content)) as {
      projectMention?: string | null;
      name?: string | null;
      status?: string | null;
      description?: string | null;
      confidence?: number;
      reason?: string;
    };

    const projectMention = typeof parsed.projectMention === "string" ? sanitizeFreeformNameValue(parsed.projectMention) : "";
    const name = typeof parsed.name === "string" ? sanitizeFreeformNameValue(parsed.name) : "";
    const status = typeof parsed.status === "string" ? sanitizeFreeformNameValue(parsed.status).toUpperCase() : "";
    const description = typeof parsed.description === "string" ? parsed.description.trim() : "";

    if (!projectMention && !name && !status && !description) return null;

    return {
      ...(projectMention ? { projectMention } : {}),
      ...(name ? { name } : {}),
      ...(status ? { status } : {}),
      ...(description ? { description } : {}),
      confidence: typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.7,
      reason: typeof parsed.reason === "string" && parsed.reason.trim().length > 0
        ? parsed.reason.trim()
        : "Model-assisted project update extraction.",
    };
  } catch {
    return null;
  }
}

function inferProjectUpdateTarget(message: string) {
  const lower = message.toLowerCase();
  if (/\bdescription|desc\b/.test(lower)) return "description" as const;
  if (/\bstatus\b/.test(lower)) return "status" as const;
  if (/\b(rename|retitle)\b/.test(lower) || /\bname\b/.test(lower)) return "name" as const;
  return undefined;
}

function extractProjectStatusValue(message: string) {
  const upper = message.toUpperCase();
  if (/\bARCHIVED\b/.test(upper)) return "ARCHIVED";
  if (/\bCOMPLETED\b/.test(upper) || /\bCOMPLETE\b/.test(upper)) return "COMPLETED";
  if (/\bACTIVE\b/.test(upper)) return "ACTIVE";
  return undefined;
}

function extractProjectDescriptionValue(message: string) {
  const trimmed = message.trim();
  if (!trimmed || isTopLevelIntent(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

async function buildProjectUpdatePendingAction(
  message: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  conversationMemory?: ConversationMemory | null,
) {
  const slots: Record<string, string> = { intent: "UPDATE_PROJECT" };
  const ambiguity: PendingAmbiguity[] = [];

  const extracted = await extractProjectUpdateSlotsSemantic({
    message,
    workspaceId,
    userId,
  });
  const updateTarget = inferProjectUpdateTarget(message);

  const project = await resolveProjectReference(
    message,
    workspaceId,
    userId,
    userRole,
    conversationMemory,
    "UPDATE_PROJECT",
    extracted?.projectMention,
  );
  if (project.match) {
    slots.projectId = project.match.id;
    slots.projectLabel = project.match.name;
  }
  if (project.ambiguity) ambiguity.push({ field: "project", candidates: project.ambiguity });

  if (extracted?.name) slots.name = extracted.name;
  if (extracted?.status) slots.status = extracted.status;
  if (extracted?.description) slots.description = extracted.description;
  if (updateTarget) slots.updateFieldTarget = updateTarget;
  if (!slots.status && updateTarget === "status") {
    const status = extractProjectStatusValue(message);
    if (status) slots.status = status;
  }
  if (!slots.description && updateTarget === "description") {
    const description = extractProjectDescriptionValue(message);
    if (description && !/\bupdate\s+project\s+description\b/i.test(message)) {
      slots.description = description;
    }
  }

  const hasUpdateField = Boolean(slots.name || slots.status || slots.description);
  const missing = [
    ...(!slots.projectId ? ["project"] : []),
    ...(!hasUpdateField ? ["updateField"] : []),
  ];

  const toolArgs = {
    ...(slots.projectId ? { projectId: slots.projectId } : {}),
    ...(slots.name ? { name: slots.name } : {}),
    ...(slots.status ? { status: slots.status } : {}),
    ...(slots.description ? { description: slots.description } : {}),
  };

  return {
    ...createPendingAction("project_action", message, {
      ...slots,
      ...(slots.projectId && hasUpdateField ? {
        toolName: "update_project",
        toolArgsJson: JSON.stringify(toolArgs),
      } : {}),
    }, missing, "collecting_slots", false, {
      intent: "UPDATE_PROJECT",
      riskLevel: "medium",
      ...(slots.projectId && hasUpdateField ? { executor: "update_project" } : {}),
    }),
    ...(ambiguity.length > 0 ? { ambiguity } : {}),
  };
}

async function buildCreateDocumentPendingAction(
  message: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  conversationMemory?: ConversationMemory | null,
) {
  const slots: Record<string, string> = {};
  const ambiguity: PendingAmbiguity[] = [];

  const team = await resolveTeamReference(message, workspaceId, userId, userRole, conversationMemory, "UNKNOWN");
  const project = await resolveProjectReference(message, workspaceId, userId, userRole, conversationMemory, "UNKNOWN");

  if (team.match) {
    slots.scopeType = "TEAM";
    slots.teamId = team.match.id;
  } else if (project.match) {
    slots.scopeType = "PROJECT";
    slots.projectId = project.match.id;
  } else if (/\bworkspace\b/i.test(message)) {
    slots.scopeType = "WORKSPACE";
  }

  if (team.ambiguity) ambiguity.push({ field: "team", candidates: team.ambiguity });
  if (project.ambiguity && !slots.scopeType) ambiguity.push({ field: "project", candidates: project.ambiguity });

  const fileKey = message.match(FILE_KEY_PATTERN)?.[1]?.trim();
  const fileName = message.match(FILE_NAME_PATTERN)?.[1]?.trim();
  const sizeBytes = message.match(FILE_SIZE_PATTERN)?.[1]?.trim();
  const contentType = message.match(CONTENT_TYPE_PATTERN)?.[1]?.trim();

  if (fileKey) slots.fileKey = fileKey;
  if (fileName) slots.fileName = fileName;
  if (sizeBytes) slots.sizeBytes = sizeBytes;
  if (contentType) slots.contentType = contentType;

  const missing = [
    ...(!slots.scopeType ? ["scope"] : []),
    ...(!(slots.fileKey && slots.fileName && slots.sizeBytes && slots.contentType) ? ["file"] : []),
  ];

  return {
    ...createPendingAction("create_document", message, slots, missing, "collecting_slots", false, {
      intent: "UNKNOWN",
      riskLevel: "low",
    }),
    ...(ambiguity.length > 0 ? { ambiguity } : {}),
  };
}

async function buildCompareProjectsDecision(
  message: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  conversationMemory?: ConversationMemory | null,
): Promise<AiPreflightDecision> {
  const comparisonTargetMention = message.match(PROJECT_COMPARE_TARGET_PATTERN)?.[1]?.trim();
  const currentProjectId = conversationMemory?.currentProjectId;
  const project = await resolveProjectReference(message, workspaceId, userId, userRole, conversationMemory, "COMPARE_PROJECTS");
  const comparisonTarget = comparisonTargetMention
    ? mapEntityResolutionToCandidateResolution(await resolveEntityReference({
        workspaceId,
        userId,
        userRole,
        rawMessage: message,
        mention: comparisonTargetMention,
        expectedEntityTypes: ["project"],
        accessMode: "read",
        actionRisk: "low",
        triggeringIntent: "COMPARE_PROJECTS",
        currentContext: buildResolverContextFromMemory(conversationMemory),
      }))
    : { match: null, ambiguity: undefined };

  const leftProjectId = project.match?.id ?? (currentProjectId && containsConversationReference(message, conversationMemory) ? currentProjectId : undefined);
  const rightProjectId = comparisonTarget.match?.id ?? (project.match && project.match.id !== currentProjectId ? project.match.id : undefined);

  if (comparisonTarget.ambiguity?.length) {
    const pending = createPendingAction("analytics_report", message, { scopeKind: "project", compareMode: "named_projects" }, ["project"], "collecting_slots", false, {
      intent: "COMPARE_PROJECTS",
      riskLevel: "low",
    });
    pending.ambiguity = [{ field: "project", candidates: comparisonTarget.ambiguity }];
    return {
      kind: "respond",
      pendingAction: pending,
      content: buildOptionQuestion("Which project should I compare against?", "Available projects:", comparisonTarget.ambiguity),
    };
  }

  if (!leftProjectId || !rightProjectId || leftProjectId === rightProjectId) {
    return {
      kind: "respond",
      pendingAction: null,
      content: !leftProjectId
        ? "Which project should I use as the first side of the comparison?"
        : "Which second project should I compare it with?",
    };
  }

  return buildDirectResolvedToolDecision(
    "compare_projects",
    {
      projectId: leftProjectId,
      comparisonTarget: rightProjectId,
    },
    "The user wants a direct project comparison. Compare exactly these two resolved projects and summarize the grounded differences only.",
  );
}

async function buildAnalyticsPendingAction(
  message: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  preferredScopeKind?: "workspace" | "project" | "team" | "member" | "cycle",
  conversationMemory?: ConversationMemory | null,
) {
  const slots: Record<string, string> = {};
  const ambiguity: PendingAmbiguity[] = [];
  const scopeKind = preferredScopeKind ?? resolveAnalyticsScopeKind(message);
  Object.assign(slots, parseAnalyticsIntentDetails(message));

  if (!scopeKind) {
    return createPendingAction("analytics_report", message, slots, ["scope"], "collecting_slots", false, {
      intent: "PERFORMANCE_REPORT",
      riskLevel: "low",
    });
  }

  slots.scopeKind = scopeKind;

  if (scopeKind === "workspace") {
    return createPendingAction("analytics_report", message, slots, [], "collecting_slots", false, {
      intent: "WORKSPACE_SUMMARY",
      riskLevel: "low",
      executor: "get_workspace_analytics",
    });
  }

  if (scopeKind === "project") {
    const project = await resolveProjectReference(message, workspaceId, userId, userRole, conversationMemory, "PROJECT_REPORT");
    if (project.match) slots.projectId = project.match.id;
    if (project.ambiguity) ambiguity.push({ field: "project", candidates: project.ambiguity });
    return {
      ...createPendingAction("analytics_report", message, slots, !slots.projectId ? ["project"] : [], "collecting_slots", false, {
        intent: "PROJECT_REPORT",
        riskLevel: "low",
        ...(slots.projectId ? { executor: "get_project_analytics" } : {}),
      }),
      ...(ambiguity.length > 0 ? { ambiguity } : {}),
    };
  }

  if (scopeKind === "team") {
    const team = await resolveTeamReference(message, workspaceId, userId, userRole, conversationMemory, "TEAM_REPORT");
    if (team.match) slots.teamId = team.match.id;
    if (team.ambiguity) ambiguity.push({ field: "team", candidates: team.ambiguity });
    return {
      ...createPendingAction("analytics_report", message, slots, !slots.teamId ? ["team"] : [], "collecting_slots", false, {
        intent: "TEAM_REPORT",
        riskLevel: "low",
        ...(slots.teamId ? { executor: "get_team_analytics" } : {}),
      }),
      ...(ambiguity.length > 0 ? { ambiguity } : {}),
    };
  }

  if (scopeKind === "member") {
    const lower = message.toLowerCase();
    const hasMemberCue = hasExplicitMemberAnalyticsCue(lower);
    if (looksLikeExplicitSelfAnalyticsRequest(lower)) {
      slots.memberId = userId;
    } else {
      const member = await resolveMemberReference(message, workspaceId, userId, userRole, conversationMemory, "INDIVIDUAL_REPORT");
      if (member.match) slots.memberId = member.match.id;
      if (member.ambiguity) ambiguity.push({ field: "member", candidates: member.ambiguity });

      if (!slots.memberId && !member.ambiguity && !hasMemberCue) {
        const project = await resolveProjectReference(message, workspaceId, userId, userRole, conversationMemory, "PROJECT_REPORT");
        if (project.match) {
          slots.scopeKind = "project";
          slots.projectId = project.match.id;
          return {
            ...createPendingAction("analytics_report", message, slots, [], "collecting_slots", false, {
              intent: "PROJECT_REPORT",
              riskLevel: "low",
              executor: "get_project_analytics",
            }),
          };
        }
        if (project.ambiguity) {
          slots.scopeKind = "project";
          ambiguity.push({ field: "project", candidates: project.ambiguity });
          return {
            ...createPendingAction("analytics_report", message, slots, ["project"], "collecting_slots", false, {
              intent: "PROJECT_REPORT",
              riskLevel: "low",
            }),
            ambiguity,
          };
        }
      }
    }

    return {
      ...createPendingAction("analytics_report", message, slots, !slots.memberId ? ["member"] : [], "collecting_slots", false, {
        intent: "INDIVIDUAL_REPORT",
        riskLevel: "low",
        ...(slots.memberId ? { executor: "get_member_analytics" } : {}),
      }),
      ...(ambiguity.length > 0 ? { ambiguity } : {}),
    };
  }

  const cycle = await resolveCycleReference(message, workspaceId, userId, userRole, conversationMemory, "CYCLE_STATUS");
  if (cycle.match) {
    slots.cycleId = cycle.match.id;
    return {
      ...createPendingAction("analytics_report", message, slots, [], "collecting_slots", false, {
        intent: "CYCLE_STATUS",
        riskLevel: "low",
        executor: "get_cycle_analytics",
      }),
    };
  }
  if (cycle.ambiguity) ambiguity.push({ field: "cycle", candidates: cycle.ambiguity });

  const team = await resolveTeamReference(message, workspaceId, userId, userRole, conversationMemory, "TEAM_REPORT");
  if (team.match) slots.teamId = team.match.id;
  if (team.ambiguity) ambiguity.push({ field: "team", candidates: team.ambiguity });
  return {
    ...createPendingAction("analytics_report", message, slots, !slots.teamId ? ["team"] : [], "collecting_slots", false, {
      intent: "TEAM_REPORT",
      riskLevel: "low",
      ...(slots.teamId ? { executor: "get_team_analytics" } : {}),
    }),
    ...(ambiguity.length > 0 ? { ambiguity } : {}),
  };
}

async function inferAnalyticsPendingActionFromEntity(
  message: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  conversationMemory?: ConversationMemory | null,
) {
  const explicitMention = sanitizeAnalyticsEntityMention(extractEntityMention(
    message,
    undefined,
    undefined,
    [
      /\b(?:show|give(?:\s+me)?|get|pull|display|check)\s+([\p{L}\p{N}][\p{L}\p{N} _.-]{1,80}?)\s+(?:analytics?|report|status|progress|health|risk|summary)\b/ui,
      /^\s*([\p{L}\p{N}][\p{L}\p{N} _.-]{1,80}?)\s+(?:analytics?|report|status|progress|health|risk|summary)\s*[\?.!]*$/ui,
    ],
  ));

  if (!explicitMention) {
    return null;
  }

  const resolution = await resolveEntityReference({
    workspaceId,
    userId,
    userRole,
    rawMessage: message,
    mention: explicitMention,
    expectedEntityTypes: ["project", "team", "member", "cycle"],
    accessMode: "read",
    actionRisk: "low",
    triggeringIntent: "PERFORMANCE_REPORT",
    currentContext: buildResolverContextFromMemory(conversationMemory),
  });

  if (resolution.status !== "resolved" || !resolution.match) {
    return null;
  }

  const scopeKind =
    resolution.entityType === "project"
      ? "project"
      : resolution.entityType === "team"
        ? "team"
        : resolution.entityType === "member"
          ? "member"
          : resolution.entityType === "cycle"
            ? "cycle"
            : null;

  if (!scopeKind) {
    return null;
  }

  const slots: Record<string, string> = {
    ...parseAnalyticsIntentDetails(message),
    scopeKind,
  };
  const executor =
    scopeKind === "project"
      ? "get_project_analytics"
      : scopeKind === "team"
        ? "get_team_analytics"
        : scopeKind === "member"
          ? "get_member_analytics"
          : "get_cycle_analytics";

  if (scopeKind === "project") slots.projectId = resolution.match.id;
  if (scopeKind === "team") slots.teamId = resolution.match.id;
  if (scopeKind === "member") slots.memberId = resolution.match.id;
  if (scopeKind === "cycle") slots.cycleId = resolution.match.id;

  return createPendingAction("analytics_report", message, slots, [], "collecting_slots", false, {
    intent:
      scopeKind === "project"
        ? "PROJECT_REPORT"
        : scopeKind === "team"
          ? "TEAM_REPORT"
          : scopeKind === "member"
            ? "INDIVIDUAL_REPORT"
            : "CYCLE_STATUS",
    riskLevel: "low",
    executor,
  });
}

async function inferAnalyticsPendingActionFromConversationContext(
  message: string,
  lower: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  conversationMemory?: ConversationMemory | null,
) {
  if (!conversationMemory) return null;
  if (!containsConversationReference(message, conversationMemory)) return null;
  if (isTopLevelIntent(lower)) return null;

  const latestScopedEntity = conversationMemory.lastResolvedEntities.find((entry) =>
    entry.entityType === "project" ||
    entry.entityType === "team" ||
    entry.entityType === "member" ||
    entry.entityType === "cycle",
  );

  const preferredScopeKind =
    latestScopedEntity?.entityType === "project"
      ? "project"
      : latestScopedEntity?.entityType === "team"
        ? "team"
        : latestScopedEntity?.entityType === "member"
          ? "member"
          : latestScopedEntity?.entityType === "cycle"
            ? "cycle"
            : conversationMemory.currentProjectId
              ? "project"
              : conversationMemory.currentTeamId
                ? "team"
                : conversationMemory.currentCycleId
                  ? "cycle"
                  : undefined;

  if (!preferredScopeKind) {
    return null;
  }

  return buildAnalyticsPendingAction(
    message,
    workspaceId,
    userId,
    userRole,
    preferredScopeKind,
    conversationMemory,
  );
}

function sanitizeAnalyticsEntityMention(mention?: string) {
  const trimmed = mention?.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  if (
    /^(?:a|an|the)$/i.test(trimmed) ||
    /^(?:create|make|show|give|get|pull|display|check|tell|need|want)\b/.test(normalized)
  ) {
    return null;
  }
  return trimmed;
}

async function resolvePendingSlotTurn(input: PreflightInput): Promise<AiPreflightDecision> {
  const pending = input.pendingAction;
  if (!pending) return { kind: "continue", pendingAction: null };

  if (pending.action === "invite_member") {
    const merged = {
      ...pending,
      slots: { ...pending.slots },
      updatedAt: new Date().toISOString(),
    };

    delete merged.ambiguity;

    const email = input.message.match(EMAIL_PATTERN)?.[0];
    const role = input.message.match(ROLE_PATTERN)?.[1];
    const team = await resolveTeamReference(input.message, input.workspaceId, input.userId, input.userRole, input.conversationMemory, "INVITE_MEMBER");

    if (email) merged.slots.email = email.toLowerCase();
    if (role) merged.slots.role = role.toUpperCase();
    if (team.match) merged.slots.teamId = team.match.id;
    if (team.ambiguity) {
      merged.ambiguity = [{ field: "team", candidates: team.ambiguity }];
    }

    merged.missing = [
      ...(!merged.slots.email ? ["email"] : []),
      ...(!merged.slots.role ? ["role"] : []),
      ...(!merged.slots.teamId ? ["team"] : []),
    ];
    logPendingCorrectionProgress({
      workspaceId: input.workspaceId,
      userId: input.userId,
      previous: pending,
      next: merged,
    });

    if (merged.missing.length > 0) {
      return { kind: "respond", pendingAction: merged, content: questionForMissingSlot(merged) };
    }

    return continueWithResolvedAction(merged, "Invite member details are resolved. Use the invite_member tool with these slots.");
  }

  if (pending.action === "create_project") {
    const merged = {
      ...pending,
      slots: { ...pending.slots },
      updatedAt: new Date().toISOString(),
    };

    const name = await extractProjectNameForCreateSemantic({
      message: input.message,
      workspaceId: input.workspaceId,
      userId: input.userId,
      allowDirectReplyFallback: pending.missing.includes("name"),
    });
    if (name?.value) merged.slots.name = name.value;

    const explicitTeamMention = extractEntityMention(
      input.message,
      TEAM_HINT_PATTERN,
      TEAM_INLINE_PATTERN,
      [TEAM_FROM_PATTERN, TEAM_TRAILING_PATTERN],
    );
    if (explicitTeamMention || (pending.missing.length === 1 && pending.missing.includes("team"))) {
      const team = await resolveTeamReference(input.message, input.workspaceId, input.userId, input.userRole, input.conversationMemory, "CREATE_PROJECT");
      if (team.match) merged.slots.teamId = team.match.id;
      if (team.ambiguity) {
        merged.ambiguity = [{ field: "team", candidates: team.ambiguity }];
      } else {
        delete merged.ambiguity;
      }
    }

    merged.missing = [
      ...(!merged.slots.name ? ["name"] : []),
      ...(!merged.slots.teamId ? ["team"] : []),
    ];

    logPendingCorrectionProgress({
      workspaceId: input.workspaceId,
      userId: input.userId,
      previous: pending,
      next: merged,
    });

    if (merged.missing.length > 0 || (merged.ambiguity?.length ?? 0) > 0) {
      return { kind: "respond", pendingAction: merged, content: questionForMissingSlot(merged) };
    }

    return buildDirectResolvedToolDecision(
      "create_project",
      {
        name: merged.slots.name,
        teamId: merged.slots.teamId,
      },
      "Project creation is fully resolved. Create the project once with the exact resolved name and team.",
    );
  }

  if (pending.action === "project_action") {
    const merged = {
      ...pending,
      slots: { ...pending.slots },
      updatedAt: new Date().toISOString(),
    };
    const prioritizeProjectResolution = pending.missing.includes("project");

    const extracted = await extractProjectUpdateSlotsSemantic({
      message: [pending.prompt, input.message].filter(Boolean).join("\n"),
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const updateTarget = pending.slots.updateFieldTarget ?? inferProjectUpdateTarget(pending.prompt);
    const explicitProjectMention = extracted?.projectMention;
    const shouldReResolveProject = Boolean(explicitProjectMention) || !merged.slots.projectId;
    if (shouldReResolveProject) {
      const project = await resolveProjectReference(
        [pending.prompt, input.message].filter(Boolean).join("\n"),
        input.workspaceId,
        input.userId,
        input.userRole,
        input.conversationMemory,
        "UPDATE_PROJECT",
        explicitProjectMention,
      );

      if (project.match) {
        merged.slots.projectId = project.match.id;
        merged.slots.projectLabel = project.match.name;
      }
      if (project.ambiguity) {
        merged.ambiguity = [{ field: "project", candidates: project.ambiguity }];
      } else {
        delete merged.ambiguity;
      }
    } else {
      delete merged.ambiguity;
    }

    if (typeof updateTarget === "string") merged.slots.updateFieldTarget = updateTarget;
    if (!prioritizeProjectResolution) {
      if (extracted?.name) merged.slots.name = extracted.name;
      if (extracted?.status) merged.slots.status = extracted.status;
      if (extracted?.description) merged.slots.description = extracted.description;
      if (!merged.slots.status && updateTarget === "status") {
        const status = extractProjectStatusValue(input.message);
        if (status) merged.slots.status = status;
      }
      if (!merged.slots.description && updateTarget === "description") {
        const description = extractProjectDescriptionValue(input.message);
        if (description) merged.slots.description = description;
      }
      if (!merged.slots.name && updateTarget === "name") {
        const name = sanitizeFreeformNameValue(input.message);
        if (name.length >= 2) merged.slots.name = name;
      }
    }

    const hasUpdateField = Boolean(merged.slots.name || merged.slots.status || merged.slots.description);
    merged.missing = [
      ...(!merged.slots.projectId ? ["project"] : []),
      ...(!hasUpdateField ? ["updateField"] : []),
    ];

    if (merged.slots.projectId && hasUpdateField) {
      merged.slots.toolName = "update_project";
      merged.slots.toolArgsJson = JSON.stringify({
        projectId: merged.slots.projectId,
        ...(merged.slots.name ? { name: merged.slots.name } : {}),
        ...(merged.slots.status ? { status: merged.slots.status } : {}),
        ...(merged.slots.description ? { description: merged.slots.description } : {}),
      });
    }

    logPendingCorrectionProgress({
      workspaceId: input.workspaceId,
      userId: input.userId,
      previous: pending,
      next: merged,
    });

    if (merged.missing.length > 0 || (merged.ambiguity?.length ?? 0) > 0) {
      return { kind: "respond", pendingAction: merged, content: questionForMissingSlot(merged) };
    }

    return buildDirectResolvedToolDecision(
      "update_project",
      JSON.parse(merged.slots.toolArgsJson as string),
      "The project update was fully resolved. Execute the exact update once and summarize the result clearly.",
    );
  }

  if (pending.action === "create_issue") {
    const project = await resolveProjectReference(input.message, input.workspaceId, input.userId, input.userRole, input.conversationMemory, "CREATE_ISSUE");
    const merged = {
      ...pending,
      slots: { ...pending.slots, ...(project.match ? { projectId: project.match.id } : {}) },
      updatedAt: new Date().toISOString(),
    };

    if (project.ambiguity) {
      merged.ambiguity = [{ field: "project", candidates: project.ambiguity }];
    } else {
      delete merged.ambiguity;
    }

    merged.missing = !merged.slots.projectId ? ["project"] : [];
    logPendingCorrectionProgress({
      workspaceId: input.workspaceId,
      userId: input.userId,
      previous: pending,
      next: merged,
    });
    if (merged.missing.length > 0) {
      return { kind: "respond", pendingAction: merged, content: questionForMissingSlot(merged) };
    }

    return continueWithResolvedAction(merged, "Issue creation project is resolved. Use the create_issue tool with the original user request and these slots.");
  }

  if (pending.action === "issue_action") {
    const merged = await buildIssueActionPendingAction(
      pending.intent as "ASSIGN_ISSUE" | "UPDATE_ISSUE_STATUS" | "ADD_COMMENT",
      [pending.prompt, input.message].filter(Boolean).join("\n"),
      input.workspaceId,
      input.userId,
      input.userRole,
      input.conversationMemory,
    );

    merged.prompt = pending.prompt;
    merged.slots = { ...pending.slots, ...merged.slots };
    merged.updatedAt = new Date().toISOString();
    logPendingCorrectionProgress({
      workspaceId: input.workspaceId,
      userId: input.userId,
      previous: pending,
      next: merged,
    });

    if (merged.missing.length > 0 || (merged.ambiguity?.length ?? 0) > 0) {
      return { kind: "respond", pendingAction: merged, content: questionForMissingSlot(merged) };
    }

    if (typeof merged.slots.toolName === "string" && typeof merged.slots.toolArgsJson === "string") {
      return buildDirectResolvedToolDecision(
        merged.slots.toolName,
        JSON.parse(merged.slots.toolArgsJson),
        "The issue action was deterministically resolved from the conversation state. Execute the exact tool call once and summarize the result naturally.",
      );
    }

    return continueWithPendingResolvedAction(
      merged,
      "The issue action now has enough context to continue through a deterministic multi-step plan. Resolve any remaining issue or member query safely before mutating.",
    );
  }

  if (pending.action === "create_document") {
    const merged = await buildCreateDocumentPendingAction(
      [pending.prompt, input.message].filter(Boolean).join("\n"),
      input.workspaceId,
      input.userId,
      input.userRole,
      input.conversationMemory,
    );

    merged.prompt = pending.prompt;
    merged.slots = { ...pending.slots, ...merged.slots };
    merged.updatedAt = new Date().toISOString();
    logPendingCorrectionProgress({
      workspaceId: input.workspaceId,
      userId: input.userId,
      previous: pending,
      next: merged,
    });

    if (merged.missing.length > 0 || (merged.ambiguity?.length ?? 0) > 0) {
      return { kind: "respond", pendingAction: merged, content: questionForMissingSlot(merged) };
    }

    return continueWithResolvedAction(
      merged,
      "Document creation context is resolved. Use the create_document tool only if a valid uploaded file reference is available. Do not invent file metadata.",
    );
  }

  if (pending.action === "analytics_report") {
    const merged = await buildAnalyticsPendingAction(
      [pending.prompt, input.message].filter(Boolean).join("\n"),
      input.workspaceId,
      input.userId,
      input.userRole,
      isAnalyticsScopeKind(pending.slots.scopeKind) ? pending.slots.scopeKind : undefined,
      input.conversationMemory,
    );

    merged.prompt = pending.prompt;
    merged.slots = { ...pending.slots, ...merged.slots };
    merged.updatedAt = new Date().toISOString();
    logPendingCorrectionProgress({
      workspaceId: input.workspaceId,
      userId: input.userId,
      previous: pending,
      next: merged,
    });

    if (merged.missing.length > 0 || (merged.ambiguity?.length ?? 0) > 0) {
      return { kind: "respond", pendingAction: merged, content: questionForMissingSlot(merged) };
    }

    return continueWithResolvedAnalytics(merged);
  }

  if (pending.action === "high_impact_action" && pending.slots.intent === "membership_removal") {
    const merged = await buildMembershipRemovalPendingAction(
      [pending.prompt, input.message].filter(Boolean).join("\n"),
      input.workspaceId,
      input.userId,
      input.userRole,
      input.conversationMemory,
    );

    if (!merged) {
      return {
        kind: "respond",
        pendingAction: pending,
        content: "I need one more detail before I can continue.",
      };
    }

    merged.prompt = pending.prompt;
    merged.updatedAt = new Date().toISOString();
    logPendingCorrectionProgress({
      workspaceId: input.workspaceId,
      userId: input.userId,
      previous: pending,
      next: merged,
    });

    if (merged.status === "awaiting_confirmation") {
      return {
        kind: "respond",
        pendingAction: merged,
        content: buildHighImpactConfirmationPrompt(merged),
      };
    }

    return {
      kind: "respond",
      pendingAction: merged,
      content: questionForMissingSlot(merged),
    };
  }

  return { kind: "continue", pendingAction: pending };
}

async function resolveDeleteBoundaryTurn(input: PreflightInput): Promise<AiPreflightDecision> {
  const pending = input.pendingAction;
  const message = input.message.trim();
  const lower = message.toLowerCase();
  const targetRef = extractIssueRef(message) ?? pending?.slots.targetRef;
  const updatedPending = pending
    ? {
        ...pending,
        slots: { ...pending.slots, ...(targetRef ? { targetRef } : {}) },
        updatedAt: new Date().toISOString(),
      }
    : createPendingAction(
        "delete_boundary",
        message,
        targetRef ? { targetRef } : {},
        [],
        "blocked_boundary",
      );

  if (/^\s*(cancel|stop|never mind|nevermind)\s*\.?\s*$/i.test(message)) {
    return {
      kind: "respond",
      pendingAction: null,
      content: "Cancelled.",
    };
  }

  if (isVagueRevertIntent(lower)) {
    return {
      kind: "respond",
      pendingAction: updatedPending,
      content: targetRef
        ? `I did not delete ${targetRef}. I also will not make substitute changes unless you explicitly ask for one, for example: \`set ${targetRef} back to todo\` or \`unassign ${targetRef}\`.`
        : "I did not delete anything. I also will not make substitute changes unless you explicitly ask for one with an issue ID and the exact value to restore.",
    };
  }

  if (isManualDeleteHelpIntent(lower)) {
    return {
      kind: "respond",
      pendingAction: updatedPending,
      content: [
        "Trussen AI cannot delete anything or perform a substitute action for a delete request.",
        "If your role allows deletion, do it manually from the issue detail page: open the issue, use the more/actions menu, choose delete, then confirm in the UI.",
      ].join("\n"),
    };
  }

  if (isExplicitAllowedAlternative(lower)) {
    return {
      kind: "continue",
      pendingAction: null,
      systemContext: [
        "Deterministic action state:",
        "The user previously asked for deletion, which is forbidden. They now gave an explicit non-delete instruction.",
        "Do not delete anything. Do not invent extra cleanup. Only perform the exact non-delete action in the latest user message if a supported tool and permissions allow it.",
      ].join("\n"),
    };
  }

  if (isUnrelatedTopLevelIntentAfterDeleteBoundary(lower)) {
    return resolveAiPreflight({ ...input, pendingAction: null });
  }

  if (isDeletePressureContinuation(lower) || !isTopLevelIntent(lower)) {
    return {
      kind: "respond",
      pendingAction: updatedPending,
      content: "Trussen AI cannot delete anything. I will not mark it done, unassign it, archive it, or make any other substitute change unless you explicitly ask for that exact allowed action.",
    };
  }

  return {
    kind: "respond",
    pendingAction: updatedPending,
    content: "Trussen AI cannot delete anything. Send a separate, explicit non-delete action if you want me to change something else.",
  };
}

function resolveConfirmationTurn(pending: PendingAiAction, message: string): AiPreflightDecision {
  if (/^\s*(confirm|yes|proceed|go ahead)\s*\.?\s*$/i.test(message)) {
    const decision = continueWithResolvedAction(
      pending,
      "The user confirmed this high-impact action. Proceed only if an exposed tool supports it and permissions allow it.",
    );

    return decision.kind === "continue"
      ? {
          ...decision,
          confirmedHighImpact: true,
          compactMode: "confirmation",
          historyLimit: 1,
          ...(pending.action === "high_impact_action" && pending.slots.toolName && pending.slots.toolArgsJson
            ? {
                confirmedHighImpactToolName: pending.slots.toolName,
                confirmedHighImpactToolArgsJson: pending.slots.toolArgsJson,
              }
            : {}),
        }
      : decision;
  }

  if (/^\s*(cancel|stop|no|never mind)\s*\.?\s*$/i.test(message)) {
    return {
      kind: "respond",
      pendingAction: null,
      content: "Cancelled.",
    };
  }

  return {
    kind: "respond",
    pendingAction: {
      ...pending,
      updatedAt: new Date().toISOString(),
    },
    content: "Reply `Confirm` to proceed, or `Cancel` to stop.",
  };
}

function continueWithResolvedAction(pending: PendingAiAction, instruction: string): AiPreflightDecision {
  const exactToolInstruction =
    pending.action === "high_impact_action" &&
    pending.slots.toolName &&
    pending.slots.toolArgsJson
      ? [
          `Confirmed tool: ${pending.slots.toolName}`,
          `Confirmed args JSON: ${pending.slots.toolArgsJson}`,
          "Execute exactly this confirmed tool call once.",
          "Do not change the tool name or arguments.",
          "After execution, summarize only the confirmed action and its result.",
        ].join("\n")
      : "";

  const resolvedPrompt = [
    pending.prompt,
    Object.keys(pending.slots).length > 0 ? `Resolved slots: ${JSON.stringify(pending.slots)}` : "",
  ].filter(Boolean).join("\n");

  return {
    kind: "continue",
    pendingAction: null,
    systemContext: [
      "Deterministic action state:",
      instruction,
      exactToolInstruction,
      `Action: ${pending.action}`,
      `Slots: ${JSON.stringify(pending.slots)}`,
      resolvedPrompt ? `Current resolved request:\n${resolvedPrompt}` : "",
    ].filter(Boolean).join("\n"),
  };
}

function continueWithPendingResolvedAction(pending: PendingAiAction, instruction: string): AiPreflightDecision {
  const resolvedPrompt = [
    pending.prompt,
    Object.keys(pending.slots).length > 0 ? `Resolved slots: ${JSON.stringify(pending.slots)}` : "",
  ].filter(Boolean).join("\n");

  return {
    kind: "continue",
    pendingAction: pending,
    systemContext: [
      "Deterministic action state:",
      instruction,
      `Action: ${pending.action}`,
      `Slots: ${JSON.stringify(pending.slots)}`,
      resolvedPrompt ? `Current resolved request:\n${resolvedPrompt}` : "",
    ].filter(Boolean).join("\n"),
  };
}

function questionForMissingSlot(pending: PendingAiAction) {
  const ambiguity = pending.ambiguity?.[0];
  if (ambiguity) {
    if (pending.action === "high_impact_action" && pending.slots.intent === "membership_removal") {
      if (ambiguity.field === "member") {
        return buildOptionQuestion(
          "Which member should I remove? Reply with the exact option.",
          "Available members:",
          ensureDistinctOptionLabels(ambiguity.candidates, "Member"),
        );
      }
      if (ambiguity.field === "team") {
        return buildOptionQuestion("Which team should I remove them from?", "Available teams:", ambiguity.candidates);
      }
      if (ambiguity.field === "project") {
        return buildOptionQuestion("Which project should I remove them from?", "Available projects:", ambiguity.candidates);
      }
      if (ambiguity.field === "department") {
        return buildOptionQuestion("Which department should I remove them from?", "Available departments:", ambiguity.candidates);
      }
    }

    if (ambiguity.field === "project") {
      return buildOptionQuestion("Which project would you like me to use?", "Available projects:", ambiguity.candidates);
    }
    if (ambiguity.field === "team") {
      return buildOptionQuestion("Which team do you mean?", "Available teams:", ambiguity.candidates);
    }
    if (ambiguity.field === "member") {
      return buildOptionQuestion("Which member should I report on?", "Available members:", ambiguity.candidates);
    }
    if (ambiguity.field === "issue") {
      return buildOptionQuestion("Which issue do you mean?", "Available issues:", ambiguity.candidates);
    }
    if (ambiguity.field === "department") {
      return buildOptionQuestion("Which department do you mean?", "Available departments:", ambiguity.candidates);
    }
    if (ambiguity.field === "cycle") {
      return buildOptionQuestion("Which cycle would you like me to check?", "Available cycles:", ambiguity.candidates);
    }
  }

  if (pending.action === "high_impact_action" && pending.slots.intent === "membership_removal") {
    if (pending.missing[0] === "member") return "Which member should I remove?";
    if (pending.missing[0] === "team") return "Which team should I remove them from?";
    if (pending.missing[0] === "project") return "Which project should I remove them from?";
    if (pending.missing[0] === "department") return "Which department should I remove them from?";
  }

  const next = pending.missing[0];

  if (pending.action === "invite_member") {
    if (next === "email") return "Who should I invite? Please send the email address.";
    if (next === "role") return "What role should they have: admin, member, or guest?";
    if (next === "team") return "Which team should they join?";
  }

  if (pending.action === "create_project") {
    if (next === "name") return "What should I call the new project?";
    if (next === "team") {
      const options = pending.ambiguity?.find((entry) => entry.field === "team")?.candidates;
      return options && options.length > 0
        ? buildOptionQuestion("Which team should own this project?", "Available teams:", options)
        : "Which team should own this project?";
    }
  }

  if (pending.action === "project_action") {
    if (next === "project") {
      const options = pending.ambiguity?.find((entry) => entry.field === "project")?.candidates;
      return options && options.length > 0
        ? buildOptionQuestion("Which project should I update?", "Available projects:", options)
        : "Which project should I update?";
    }
    if (next === "updateField") {
      if (pending.slots.updateFieldTarget === "description") {
        return `What would you like the new description for ${pending.slots.projectLabel ?? "this project"} to say?`;
      }
      if (pending.slots.updateFieldTarget === "status") {
        return `What status should I set for ${pending.slots.projectLabel ?? "this project"}: active, archived, or completed?`;
      }
      if (pending.slots.updateFieldTarget === "name") {
        return `What should I rename ${pending.slots.projectLabel ?? "this project"} to?`;
      }
      return "What should I change on this project? You can give me a new name, status, or description.";
    }
  }

  if (pending.action === "create_issue" && next === "project") {
    const options = pending.ambiguity?.find((entry) => entry.field === "project")?.candidates;
    if (options && options.length > 0) {
      return buildOptionQuestion("Which project should this issue belong to?", "Available projects:", options);
    }
    return "Which project should this issue belong to?";
  }

  if (pending.action === "issue_action") {
    if (next === "issue") return "Which issue should I use?";
    if (next === "member") return "Who should I assign it to?";
    if (next === "status") return "What status should I set: backlog, todo, in-progress, review, or done?";
    if (next === "body") return "What comment should I add?";
  }

  if (pending.action === "create_document") {
    if (next === "scope") {
      return "Where should I add this document: the workspace, a team, or a project?";
    }
    if (next === "file") {
      return "Please attach or upload the file first, then resend the request. If your client exposes file metadata, include file key, file name, content type, and size.";
    }
  }

  if (pending.action === "analytics_report") {
    if (next === "scope") {
      if (pending.capabilityCandidates && pending.capabilityCandidates.length > 0) {
        return buildOptionQuestion(
          "Which report should I prepare?",
          "Available report types:",
          pending.capabilityCandidates.map((candidate) => ({
            id: candidate.intent,
            label: `${candidate.label} (${Math.round(candidate.confidence * 100)}%)`,
          })),
        );
      }
      return "Which scope should I report on: workspace, a project, a team, a member, or a cycle?";
    }
    if (next === "project") {
      const options = pending.ambiguity?.find((entry) => entry.field === "project")?.candidates;
      return options && options.length > 0
        ? buildOptionQuestion("Which project would you like me to check?", "Available projects:", options)
        : "Which project would you like me to check?";
    }
    if (next === "team") {
      const options = pending.ambiguity?.find((entry) => entry.field === "team")?.candidates;
      return options && options.length > 0
        ? buildOptionQuestion("Which team would you like me to check?", "Available teams:", options)
        : "Which team would you like me to check?";
    }
    if (next === "cycle") {
      const options = pending.ambiguity?.find((entry) => entry.field === "cycle")?.candidates;
      return options && options.length > 0
        ? buildOptionQuestion("Which cycle would you like me to check?", "Available cycles:", options)
        : "Which cycle would you like me to check?";
    }
    if (next === "member") {
      const options = pending.ambiguity?.find((entry) => entry.field === "member")?.candidates;
      return options && options.length > 0
        ? buildOptionQuestion("Which member would you like me to report on?", "Available members:", options)
        : "Which member would you like me to report on?";
    }
  }

  return "I need one more detail before I can continue.";
}

function analyticsInstructionForPending(pending: PendingAiAction) {
  const scopeKind = pending.slots.scopeKind;
  const wantsExport = Boolean(pending.slots.exportFormat);
  const wantsComparison = pending.slots.compareMode === "previous_period";
  const periodContext = pending.slots.period === "custom"
    ? `Use from=${pending.slots.from ?? ""} and to=${pending.slots.to ?? ""}.`
    : pending.slots.period
      ? `Use period=${pending.slots.period}.`
      : "Use the default reporting period if the user did not specify one.";

  const toolInstruction = wantsExport
    ? "Use export_analytics_report with the resolved scope, scopeId, period or custom range, and format."
    : "Use the scoped analytics tool that matches the resolved scope.";

  const cycleInstruction = scopeKind === "cycle" && pending.slots.teamId && !pending.slots.cycleId
    ? "Resolve the current cycle for that team before loading cycle analytics."
    : "";

  const comparisonInstruction = wantsComparison
    ? "The user asked for a comparison. After loading analytics, compare the returned trend and previous-period fields explicitly."
    : "";

  return [toolInstruction, periodContext, cycleInstruction, comparisonInstruction]
    .filter(Boolean)
    .join(" ");
}

function analyticsToolResolutionForPending(pending: PendingAiAction): { toolName: string; toolArgs: Record<string, string> } | null {
  const scopeKind = pending.slots.scopeKind;
  const toolArgs = Object.fromEntries(
    Object.entries({
      period: pending.slots.period,
      from: pending.slots.from,
      to: pending.slots.to,
    }).filter(([, value]) => typeof value === "string" && value.length > 0),
  ) as Record<string, string>;

  if (pending.slots.exportFormat) {
    const exportArgs = {
      scope: scopeKind ?? "",
      ...(scopeKind === "project" && pending.slots.projectId ? { scopeId: pending.slots.projectId } : {}),
      ...(scopeKind === "team" && pending.slots.teamId ? { scopeId: pending.slots.teamId } : {}),
      ...(scopeKind === "member" && pending.slots.memberId ? { scopeId: pending.slots.memberId } : {}),
      ...(scopeKind === "cycle" && pending.slots.cycleId ? { scopeId: pending.slots.cycleId } : {}),
      ...toolArgs,
      format: pending.slots.exportFormat,
    };

    if (scopeKind === "workspace") return { toolName: "export_analytics_report", toolArgs: exportArgs };
    if (scopeKind === "project" && pending.slots.projectId) return { toolName: "export_analytics_report", toolArgs: exportArgs };
    if (scopeKind === "team" && pending.slots.teamId) return { toolName: "export_analytics_report", toolArgs: exportArgs };
    if (scopeKind === "member" && pending.slots.memberId) return { toolName: "export_analytics_report", toolArgs: exportArgs };
    if (scopeKind === "cycle" && pending.slots.cycleId) return { toolName: "export_analytics_report", toolArgs: exportArgs };
    return null;
  }

  if (scopeKind === "workspace") return { toolName: "get_workspace_analytics", toolArgs };
  if (scopeKind === "project" && pending.slots.projectId) return { toolName: "get_project_analytics", toolArgs: { ...toolArgs, projectId: pending.slots.projectId } };
  if (scopeKind === "team" && pending.slots.teamId) return { toolName: "get_team_analytics", toolArgs: { ...toolArgs, teamId: pending.slots.teamId } };
  if (scopeKind === "member" && pending.slots.memberId) return { toolName: "get_member_analytics", toolArgs: { ...toolArgs, memberId: pending.slots.memberId } };
  if (scopeKind === "cycle" && pending.slots.cycleId) return { toolName: "get_cycle_analytics", toolArgs: { ...toolArgs, cycleId: pending.slots.cycleId } };
  return null;
}

function continueWithResolvedAnalytics(pending: PendingAiAction): AiPreflightDecision {
  const toolResolution = analyticsToolResolutionForPending(pending);
  const instruction = analyticsInstructionForPending(pending);
  const base = continueWithResolvedAction(pending, instruction);

  if (base.kind !== "continue" || !toolResolution) {
    return base;
  }

  return {
    ...base,
    resolvedToolName: toolResolution.toolName,
    resolvedToolArgsJson: JSON.stringify(toolResolution.toolArgs),
    ...(isOverloadAnalyticsPrompt(pending.prompt) ? { resolvedResponseMode: "overloaded" as const } : {}),
  };
}

function logPendingCorrectionProgress(input: {
  workspaceId: string;
  userId: string;
  previous: PendingAiAction;
  next: PendingAiAction;
}) {
  const previousAmbiguity = input.previous.ambiguity?.length ?? 0;
  const nextAmbiguity = input.next.ambiguity?.length ?? 0;
  const improved = input.next.missing.length < input.previous.missing.length || nextAmbiguity < previousAmbiguity;
  if (!improved) return;

  logAiInfo("chat_pending_action_corrected", {
    workspaceId: input.workspaceId,
    userId: input.userId,
    feature: "chat",
    success: true,
    metadata: {
      action: input.next.action,
      previousMissing: input.previous.missing,
      nextMissing: input.next.missing,
      previousAmbiguity,
      nextAmbiguity,
    },
  });
  void incrementAiMetricCounter({
    workspaceId: input.workspaceId,
    feature: "chat",
    metric: "correction",
    dimensions: {
      action: input.next.action,
    },
  });
}

function capabilityLabelForIntent(intent: AiIntent) {
  if (intent === "WORKSPACE_SUMMARY") return "Workspace report";
  if (intent === "PROJECT_REPORT") return "Project report";
  if (intent === "TEAM_REPORT") return "Team report";
  if (intent === "INDIVIDUAL_REPORT") return "Member report";
  if (intent === "CYCLE_STATUS") return "Cycle report";
  return intent.replace(/_/g, " ").toLowerCase();
}

function isOverloadAnalyticsPrompt(message: string) {
  return /\b(overloaded|overload|too much work|heavy workload|who needs help)\b/i.test(message);
}

function buildOptionQuestion(prompt: string, heading: string, candidates: Array<{ id: string; label: string }>) {
  return [prompt, heading, ...candidates.map((candidate) => candidate.label)].join("\n");
}

function ensureDistinctOptionLabels(
  candidates: Array<{ id: string; label: string }>,
  fallbackPrefix: string,
) {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.label, (counts.get(candidate.label) ?? 0) + 1);
  }

  return candidates.map((candidate, index) => ({
    id: candidate.id,
    label: (counts.get(candidate.label) ?? 0) > 1
      ? `${candidate.label} [${candidate.id}]`
      : candidate.label.trim().length > 0
        ? candidate.label
        : `${fallbackPrefix} ${index + 1} [${candidate.id}]`,
  }));
}

function buildHighImpactConfirmationPrompt(pending: PendingAiAction) {
  if (pending.slots.intent === "membership_removal") {
    const memberLabel = pending.slots.memberLabel ?? "this member";
    const scopeKind = pending.slots.scopeKind;
    const scopeLabel = pending.slots.scopeLabel ?? (
      scopeKind === "workspace"
        ? "the workspace"
        : `this ${scopeKind ?? "scope"}`
    );
    return `This will remove ${memberLabel} from ${scopeLabel}. Reply \`Confirm\` to proceed, or \`Cancel\` to stop.`;
  }

  return "Reply `Confirm` to proceed, or `Cancel` to stop.";
}

function resolveMembershipRemovalScope(message: string): "team" | "project" | "department" | "workspace" | null {
  const lower = message.toLowerCase();
  if (/\bworkspace\b/.test(lower)) return "workspace";
  if (/\bdepartment\b/.test(lower)) return "department";
  if (/\b(project|app)\b/.test(lower)) return "project";
  if (/\bteam\b/.test(lower)) return "team";
  return null;
}

function membershipRemovalToolForScope(scopeKind: "team" | "project" | "department" | "workspace") {
  if (scopeKind === "team") return "remove_team_member";
  if (scopeKind === "project") return "remove_project_member";
  if (scopeKind === "department") return "remove_department_member";
  return "remove_workspace_member";
}

function membershipRemovalToolArgs(scopeKind: "team" | "project" | "department" | "workspace", slots: Record<string, string>) {
  if (scopeKind === "team") return { teamId: slots.teamId, userId: slots.userId };
  if (scopeKind === "project") return { projectId: slots.projectId, userId: slots.userId };
  if (scopeKind === "department") return { departmentId: slots.departmentId, userId: slots.userId };
  return { userId: slots.userId };
}

function resolveAnalyticsScopeKind(message: string): "workspace" | "project" | "team" | "member" | "cycle" | null {
  const lower = message.toLowerCase();
  if (/\bworkspace\b/.test(lower)) return "workspace";
  if (/\b(project|app)\b/.test(lower)) return "project";
  if (/\bteam\b/.test(lower)) return "team";
  if (/\b(member|employee|user|person)\b/.test(lower) || looksLikeExplicitSelfAnalyticsRequest(lower)) return "member";
  if (/\b(cycle|sprint)\b/.test(lower)) return "cycle";
  return null;
}

function looksLikeExplicitSelfAnalyticsRequest(lower: string) {
  return (
    /\bmy\b.*\b(report|performance|workload|progress|activity|analytics|tasks|issues)\b/.test(lower) ||
    /\b(report|performance|workload|progress|activity|analytics)\b.*\bfor me\b/.test(lower) ||
    /\b(report|performance|workload|progress|activity|analytics)\b.*\babout me\b/.test(lower) ||
    /\b(me|myself)\b.*\bperformance\b/.test(lower)
  );
}

function hasExplicitMemberAnalyticsCue(lower: string) {
  return (
    /\b(member|employee|user|person|assignee|individual)\b/.test(lower) ||
    looksLikeExplicitSelfAnalyticsRequest(lower) ||
    /@[\p{L}\p{N}_ .-]+/u.test(lower)
  );
}

function parseAnalyticsIntentDetails(message: string): Record<string, string> {
  const lower = message.toLowerCase();
  const slots: Record<string, string> = {};
  const now = new Date();

  const explicitDates = [...message.matchAll(ISO_DATE_PATTERN)].map((match) => match[0]);
  if (explicitDates.length >= 2) {
    const from = explicitDates[0]!;
    const to = explicitDates[1]!;
    slots.period = "custom";
    slots.from = from;
    slots.to = to;
  } else if (/\btoday\b/.test(lower)) {
    slots.period = "custom";
    slots.from = formatIsoDate(now);
    slots.to = formatIsoDate(now);
  } else if (/\byesterday\b/.test(lower)) {
    const day = addDaysSafe(now, -1);
    slots.period = "custom";
    slots.from = formatIsoDate(day);
    slots.to = formatIsoDate(day);
  } else if (/\bthis week\b/.test(lower)) {
    const { from, to } = getWeekRange(now, 0);
    slots.period = "custom";
    slots.from = formatIsoDate(from);
    slots.to = formatIsoDate(to);
  } else if (/\blast week\b/.test(lower)) {
    const { from, to } = getWeekRange(now, -1);
    slots.period = "custom";
    slots.from = formatIsoDate(from);
    slots.to = formatIsoDate(to);
  } else if (/\bthis month\b/.test(lower)) {
    const { from, to } = getMonthRange(now, 0);
    slots.period = "custom";
    slots.from = formatIsoDate(from);
    slots.to = formatIsoDate(to);
  } else if (/\blast month\b/.test(lower)) {
    const { from, to } = getMonthRange(now, -1);
    slots.period = "custom";
    slots.from = formatIsoDate(from);
    slots.to = formatIsoDate(to);
  } else {
    const dayCount = lower.match(/\b(?:last|past)\s+(\d{1,3})\s+days?\b/);
    if (dayCount) {
      const count = Math.max(1, Math.min(365, Number(dayCount[1] ?? "30")));
      if (count === 7 || count === 30 || count === 90) {
        slots.period = `${count}d`;
      } else {
        slots.period = "custom";
        slots.from = formatIsoDate(addDaysSafe(now, -(count - 1)));
        slots.to = formatIsoDate(now);
      }
    } else if (/\b(last|past)\s+7\s*d(ays?)?\b/.test(lower)) {
      slots.period = "7d";
    } else if (/\b(last|past)\s+30\s*d(ays?)?\b/.test(lower)) {
      slots.period = "30d";
    } else if (/\b(last|past)\s+90\s*d(ays?)?\b/.test(lower)) {
      slots.period = "90d";
    }
  }

  if (/\b(compare|comparison|versus|vs)\b/.test(lower)) {
    slots.compareMode = "previous_period";
  }

  if (/\b(export|download)\b/.test(lower) || /\b(csv|pdf|json)\b/.test(lower)) {
    if (/\bcsv\b|\bspreadsheet\b/.test(lower)) {
      slots.exportFormat = "csv";
    } else if (/\bjson\b/.test(lower)) {
      slots.exportFormat = "json";
    } else {
      slots.exportFormat = "pdf";
    }
  }

  return slots;
}

function formatIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDaysSafe(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function getWeekRange(anchor: Date, offsetWeeks: number) {
  const current = new Date(anchor);
  current.setHours(0, 0, 0, 0);
  current.setDate(current.getDate() + (offsetWeeks * 7));
  const day = current.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const from = addDaysSafe(current, diffToMonday);
  const to = addDaysSafe(from, 6);
  return { from, to };
}

function getMonthRange(anchor: Date, offsetMonths: number) {
  const from = new Date(anchor.getFullYear(), anchor.getMonth() + offsetMonths, 1);
  const to = new Date(anchor.getFullYear(), anchor.getMonth() + offsetMonths + 1, 0);
  return { from, to };
}

function isAnalyticsScopeKind(value: string | undefined): value is "workspace" | "project" | "team" | "member" | "cycle" {
  return value === "workspace" || value === "project" || value === "team" || value === "member" || value === "cycle";
}

async function resolveProjectReference(
  message: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  conversationMemory?: ConversationMemory | null,
  triggeringIntent?: AiIntent,
  explicitMention?: string,
): Promise<CandidateResolution> {
  return resolveEntityCandidateFromMessage(
    "project",
    message,
    { workspaceId, userId, userRole, conversationMemory },
    {
      accessMode: "read",
      actionRisk: "low",
      ...(triggeringIntent ? { triggeringIntent } : {}),
      ...(explicitMention ? { explicitMention } : {}),
      hintPattern: PROJECT_HINT_PATTERN,
      inlinePattern: PROJECT_INLINE_PATTERN,
      alternateHintPatterns: [PROJECT_FROM_PATTERN, PROJECT_TRAILING_PATTERN, PROJECT_SUBJECT_PATTERN, PROJECT_QUESTION_PATTERN, PROJECT_ABOUT_PATTERN],
    },
  );
}

async function resolveTeamReference(
  message: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  conversationMemory?: ConversationMemory | null,
  triggeringIntent?: AiIntent,
): Promise<CandidateResolution> {
  return resolveEntityCandidateFromMessage(
    "team",
    message,
    { workspaceId, userId, userRole, conversationMemory },
    {
      accessMode: "read",
      actionRisk: "low",
      ...(triggeringIntent ? { triggeringIntent } : {}),
      hintPattern: TEAM_HINT_PATTERN,
      inlinePattern: TEAM_INLINE_PATTERN,
      alternateHintPatterns: [TEAM_FROM_PATTERN, TEAM_TRAILING_PATTERN],
    },
  );
}

async function resolveDepartmentReference(
  message: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  conversationMemory?: ConversationMemory | null,
  triggeringIntent?: AiIntent,
): Promise<CandidateResolution> {
  return resolveEntityCandidateFromMessage(
    "department",
    message,
    { workspaceId, userId, userRole, conversationMemory },
    {
      accessMode: "read",
      actionRisk: "low",
      ...(triggeringIntent ? { triggeringIntent } : {}),
      hintPattern: DEPARTMENT_HINT_PATTERN,
      inlinePattern: DEPARTMENT_INLINE_PATTERN,
      alternateHintPatterns: [DEPARTMENT_FROM_PATTERN, DEPARTMENT_TRAILING_PATTERN],
    },
  );
}

async function resolveMemberReference(
  message: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  conversationMemory?: ConversationMemory | null,
  triggeringIntent?: AiIntent,
  explicitMention?: string,
): Promise<CandidateResolution> {
  return resolveEntityCandidateFromMessage(
    "member",
    message,
    { workspaceId, userId, userRole, conversationMemory },
    {
      accessMode: "read",
      actionRisk: "low",
      ...(triggeringIntent ? { triggeringIntent } : {}),
      ...(explicitMention ? { explicitMention } : {}),
      hintPattern: MEMBER_MENTION_PATTERN,
      inlinePattern: MEMBER_REMOVE_PATTERN,
    },
  );
}

async function resolveIssueReference(
  message: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  conversationMemory?: ConversationMemory | null,
  triggeringIntent?: AiIntent,
): Promise<CandidateResolution> {
  const issueRef = extractIssueRef(message);
  return resolveEntityCandidateFromMessage(
    "issue",
    message,
    { workspaceId, userId, userRole, conversationMemory },
    {
      accessMode: "read",
      actionRisk: "low",
      ...(triggeringIntent ? { triggeringIntent } : {}),
      ...(issueRef ? { hintPattern: new RegExp(`(${issueRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i") } : {}),
    },
  );
}

async function resolveCycleReference(
  message: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  conversationMemory?: ConversationMemory | null,
  triggeringIntent?: AiIntent,
): Promise<CandidateResolution> {
  const cycleId = message.match(UUID_PATTERN)?.[0];
  if (cycleId) {
    const direct = await (prisma as any).cycle.findFirst({
      where: {
        id: cycleId,
        workspaceId,
        ...(isAdminRole(userRole)
          ? {}
          : {
              OR: [
                { team: { leadId: userId } },
                { team: { memberships: { some: { userId } } } },
              ],
            }),
      },
      select: { id: true, name: true },
    });

    if (direct) {
      return { match: direct as { id: string; name: string } };
    }
  }

  return resolveEntityCandidateFromMessage(
    "cycle",
    message,
    { workspaceId, userId, userRole, conversationMemory },
    {
      accessMode: "read",
      actionRisk: "low",
      ...(triggeringIntent ? { triggeringIntent } : {}),
    },
  );
}

async function resolveEntityCandidateFromMessage(
  entityType: ResolvedEntityType,
  message: string,
  context: ResolverContext,
  options: {
    accessMode: "read" | "mutation";
    actionRisk: ResolutionRisk;
    triggeringIntent?: AiIntent;
    explicitMention?: string;
    hintPattern?: RegExp;
    inlinePattern?: RegExp;
    alternateHintPatterns?: RegExp[];
  },
) {
  const mention = options.explicitMention ?? extractEntityMention(message, options.hintPattern, options.inlinePattern, options.alternateHintPatterns);
  const attemptedMentions = new Set<string>();
  const resolveAttempt = async (nextMention?: string) => {
    const normalizedKey = (nextMention ?? "__raw__").trim().toLowerCase();
    if (attemptedMentions.has(normalizedKey)) return null;
    attemptedMentions.add(normalizedKey);
    return resolveEntityReference({
      workspaceId: context.workspaceId,
      userId: context.userId,
      userRole: context.userRole,
      rawMessage: message,
      mention: nextMention,
      expectedEntityTypes: [entityType],
      accessMode: options.accessMode,
      actionRisk: options.actionRisk,
      triggeringIntent: options.triggeringIntent,
      currentContext: buildResolverContextFromMemory(context.conversationMemory),
    });
  };

  let resolution = await resolveAttempt(mention) ?? await resolveAttempt(undefined);
  if (!resolution) {
    return { match: null };
  }

  if (mention && resolution.status === "not_found") {
    resolution = await resolveAttempt(undefined) ?? resolution;
  }

  if (resolution.status === "not_found") {
    const semanticMention = await extractEntityMentionWithModel({
      message,
      entityType,
      workspaceId: context.workspaceId,
      userId: context.userId,
      ...(options.triggeringIntent ? { triggeringIntent: options.triggeringIntent } : {}),
    });
    if (semanticMention?.mention) {
      const semanticResolution = await resolveAttempt(semanticMention.mention);
      if (semanticResolution && semanticResolution.status !== "not_found") {
        resolution = semanticResolution;
      }
    }
  }

  return mapEntityResolutionToCandidateResolution(resolution);
}

function sanitizeJsonEnvelope(value: string) {
  const trimmed = value.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  return jsonStart >= 0 && jsonEnd > jsonStart ? trimmed.slice(jsonStart, jsonEnd + 1) : trimmed;
}

async function extractEntityMentionWithModel(input: {
  message: string;
  entityType: ResolvedEntityType;
  triggeringIntent?: AiIntent;
  workspaceId: string;
  userId: string;
}): Promise<ExtractedEntityMention | null> {
  try {
    const result = await callAI([
      {
        role: "system",
        content: [
          "You extract one explicit workspace entity mention from a user message.",
          "The message may use any language, mixed language, typos, slang, or broken grammar.",
          `Target entity type: ${input.entityType}.`,
          "Return strict JSON only: {\"mention\":string|null,\"confidence\":0.0-1.0,\"reason\":string}.",
          "Do not translate the entity name.",
          "Do not invent an entity if the message contains no explicit mention.",
          "If the user only says 'it', 'that', or another indirect reference, return mention=null.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          message: input.message,
          entityType: input.entityType,
          intent: input.triggeringIntent ?? "UNKNOWN",
        }),
      },
    ], {
      model: ENTITY_EXTRACTION_MODEL,
      taskType: "chat_response",
      maxTokens: 140,
      temperature: 0.1,
    });

    const parsed = JSON.parse(sanitizeJsonEnvelope(result.content)) as {
      mention?: string | null;
      confidence?: number;
      reason?: string;
    };

    const mention = typeof parsed.mention === "string" ? parsed.mention.trim() : "";
    if (!mention || mention.length < 2 || mention.length > 120) return null;
    const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.65;

    logAiInfo("entity_mention_model_used", {
      workspaceId: input.workspaceId,
      userId: input.userId,
      feature: "entity-resolution",
      success: true,
      metadata: {
        entityType: input.entityType,
        intent: input.triggeringIntent ?? "UNKNOWN",
        extractedMention: mention,
        confidence,
      },
    });
    void incrementAiMetricCounter({
      workspaceId: input.workspaceId,
      feature: "entity-resolution",
      metric: "model_mention_extraction",
      dimensions: {
        entityType: input.entityType,
        intent: input.triggeringIntent ?? "UNKNOWN",
      },
    });

    return {
      mention,
      confidence,
      reason: typeof parsed.reason === "string" && parsed.reason.trim().length > 0
        ? parsed.reason.trim()
        : "Model-assisted entity extraction.",
    };
  } catch {
    return null;
  }
}

function extractEntityMention(
  message: string,
  hintPattern?: RegExp,
  inlinePattern?: RegExp,
  alternateHintPatterns?: RegExp[],
) {
  const genericTail = message.match(/\b(?:for|about|regarding|on|of)\s+([\p{L}\p{N}][\p{L}\p{N} _.-]{1,80})\s*[\?.!]*$/u)?.[1];
  const alternateHint = (alternateHintPatterns ?? [])
    .map((pattern) => pattern.exec(message)?.[1])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);

  const hinted = hintPattern?.exec(message)?.[1] ?? inlinePattern?.exec(message)?.[1] ?? alternateHint ?? genericTail;
  const trimmedHint = hinted?.trim();
  return trimmedHint && trimmedHint.length > 0 ? trimmedHint : undefined;
}

function mapEntityResolutionToCandidateResolution(resolution: EntityResolutionResult): CandidateResolution {
  if (resolution.status === "resolved" && resolution.match) {
    return { match: resolution.match };
  }

  const candidateOptions = resolution.candidates
    ?.map((candidate) => ({
      id: candidate.id,
      label: candidate.name,
    }))
    .slice(0, 5);

  if (resolution.status === "confirm" && resolution.match) {
    return {
      match: null,
      ambiguity: ensureDistinctOptionLabels(
        candidateOptions && candidateOptions.length > 0
          ? candidateOptions
          : [{ id: resolution.match.id, label: resolution.match.name }],
        capitalizeEntityType(resolution.entityType),
      ),
    };
  }

  if (resolution.status === "ambiguous" && candidateOptions && candidateOptions.length > 0) {
    return {
      match: null,
      ambiguity: ensureDistinctOptionLabels(candidateOptions, capitalizeEntityType(resolution.entityType)),
    };
  }

  return { match: null };
}

function extractStatusSlot(message: string) {
  const normalized = message.toLowerCase();
  if (/\bin[- ]progress|start working|begin\b/.test(normalized)) return "in-progress";
  if (/\breview|ready for review|needs review\b/.test(normalized)) return "review";
  if (/\bdone|complete|completed|finished\b/.test(normalized)) return "done";
  if (/\bbacklog\b/.test(normalized)) return "backlog";
  if (/\btodo|to do\b/.test(normalized)) return "todo";
  return undefined;
}

function extractCommentBody(message: string) {
  const quoted = message.match(/["“](.+?)["”]/);
  if (quoted?.[1]) return quoted[1].trim();
  const afterComment = message.match(/\b(?:comment|note|reply)\b.*?\b(?:saying|that says|saying that|with)\b(.+)$/i)?.[1];
  return afterComment?.trim();
}

function extractAssignmentMemberMention(message: string) {
  const explicitTarget = message.match(/\b(?:assign|reassign)\b.*?\bto\b\s+(.+)$/i)?.[1]?.trim();
  if (explicitTarget) return explicitTarget;

  const implicitTarget = message.match(
    /\b(?:assign|reassign)\b(?:\s+(?:it|that|this|issue|task|bug|[A-Z][A-Z0-9]{1,9}-\d+))*\s+(.+)$/i,
  )?.[1]?.trim();
  if (!implicitTarget) return undefined;

  if (/^(?:it|that|this|issue|task|bug)$/i.test(implicitTarget)) return undefined;
  return implicitTarget;
}

function buildDirectResolvedToolDecision(toolName: string, toolArgs: Record<string, unknown>, systemContext: string): AiPreflightDecision {
  return {
    kind: "continue",
    pendingAction: null,
    resolvedToolName: toolName,
    resolvedToolArgsJson: JSON.stringify(toolArgs),
    systemContext,
  };
}

async function buildIssueActionPendingAction(
  intent: "ASSIGN_ISSUE" | "UPDATE_ISSUE_STATUS" | "ADD_COMMENT",
  message: string,
  workspaceId: string,
  userId: string,
  userRole: string,
  conversationMemory?: ConversationMemory | null,
) {
  const slots: Record<string, string> = { intent };
  const ambiguity: PendingAmbiguity[] = [];

  const issue = await resolveIssueReference(message, workspaceId, userId, userRole, conversationMemory, intent);
  if (issue.match) {
    slots.issueId = issue.match.id;
    slots.issueLabel = issue.match.name;
  } else {
    slots.issueQuery = message;
  }
  if (issue.ambiguity) ambiguity.push({ field: "issue", candidates: issue.ambiguity });

  if (intent === "ASSIGN_ISSUE") {
    const memberMention = extractAssignmentMemberMention(message);
    const member = /\bto me\b/i.test(message)
      ? { match: { id: userId, name: "You" }, ambiguity: undefined }
      : await resolveMemberReference(memberMention ?? message, workspaceId, userId, userRole, conversationMemory, intent, memberMention);
    if (member.match) {
      slots.assigneeId = member.match.id;
      slots.memberLabel = member.match.name;
    } else if (memberMention ?? message) {
      slots.assigneeQuery = memberMention ?? message;
    }
    if (member.ambiguity) ambiguity.push({ field: "member", candidates: member.ambiguity });
  }

  if (intent === "UPDATE_ISSUE_STATUS") {
    const status = extractStatusSlot(message);
    if (status) slots.status = status;
  }

  if (intent === "ADD_COMMENT") {
    const body = extractCommentBody(message);
    if (body) slots.body = body;
  }

  if (/\boverdue\b/i.test(message)) {
    slots.overdueOnly = "true";
  }
  if (/\bblocked|stuck|waiting on\b/i.test(message)) {
    slots.blockedOnly = "true";
  }
  if (/\bhigh priority|urgent|critical\b/i.test(message)) {
    slots.highPriorityOnly = "true";
  }

  const missing = [
    ...(!slots.issueId && !slots.issueQuery ? ["issue"] : []),
    ...(intent === "ASSIGN_ISSUE" && !slots.assigneeId && !slots.assigneeQuery ? ["member"] : []),
    ...(intent === "UPDATE_ISSUE_STATUS" && !slots.status ? ["status"] : []),
    ...(intent === "ADD_COMMENT" && !slots.body ? ["body"] : []),
  ];

  const toolName = intent === "ASSIGN_ISSUE"
    ? "assign_issue"
    : intent === "UPDATE_ISSUE_STATUS"
      ? "update_issue_status"
      : "add_comment";

  const toolArgs = {
    ...(slots.issueId ? { issueId: slots.issueId } : {}),
    ...(slots.assigneeId ? { assigneeId: slots.assigneeId } : {}),
    ...(slots.status ? { status: slots.status } : {}),
    ...(slots.body ? { body: slots.body } : {}),
  };

  const directExecutable = (
    intent === "ASSIGN_ISSUE"
      ? Boolean(slots.issueId && slots.assigneeId)
      : intent === "UPDATE_ISSUE_STATUS"
        ? Boolean(slots.issueId && slots.status)
        : Boolean(slots.issueId && slots.body)
  );

  return {
    ...createPendingAction("issue_action", message, {
      ...slots,
      ...(directExecutable ? { toolName, toolArgsJson: JSON.stringify(toolArgs) } : {}),
    }, missing, "collecting_slots", false, {
      intent,
      riskLevel: intent === "ADD_COMMENT" ? "low" : "medium",
      ...(!missing.length ? { executor: toolName } : {}),
    }),
    ...(ambiguity.length > 0 ? { ambiguity } : {}),
  };
}

function capitalizeEntityType(value: ResolvedEntityType) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
