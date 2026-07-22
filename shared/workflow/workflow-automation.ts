export type WorkspaceStatusCategory =
  | "backlog"
  | "unstarted"
  | "active"
  | "review"
  | "done"
  | "cancelled";

export type WorkspaceStatusVisibility = {
  board: boolean;
  list: boolean;
  filters: boolean;
  create: boolean;
  cycleBoard: boolean;
  cycleList: boolean;
};

export type WorkspaceStatusCycleConfig = {
  allowedInCycle: boolean;
  countsAsCompleted: boolean;
  countsAsCarryOver: boolean;
  planIntoThisStatus: boolean;
};

export type WorkflowTransitionRole = "OWNER" | "ADMIN" | "MEMBER" | "GUEST";

export type WorkspaceStatusTransitionConfig = {
  mode: "free" | "restricted";
  to: string[];
  allowRollback: boolean;
  allowedRoles: WorkflowTransitionRole[];
  allowedUserIds: string[];
  assigneeOnly: boolean;
  creatorOnly: boolean;
};

export type WorkspaceStatusRuleConfig = {
  requireAssignee: boolean;
  requireDueDate: boolean;
  requireAllSubtasksComplete: boolean;
  requireAcceptanceCriteria: boolean;
  requireParentIssue: boolean;
  requireIntegrationRef: boolean;
};

export type WorkflowApprovalReviewerSource = "project_members" | "team_lead" | "department_head" | "manual";

export type WorkspaceStatusApprovalConfig = {
  required: boolean;
  requiredCount: number;
  reviewerSource: WorkflowApprovalReviewerSource;
  reviewerUserIds: string[];
};

export type WorkspaceStatusRecord = {
  key: string;
  label: string;
  color: string;
  order: number;
  category: WorkspaceStatusCategory;
  isActive: boolean;
  isFinal: boolean;
  showOnBoard: boolean;
  visibility: WorkspaceStatusVisibility;
  cycle: WorkspaceStatusCycleConfig;
  transitions: WorkspaceStatusTransitionConfig;
  rules: WorkspaceStatusRuleConfig;
  approval: WorkspaceStatusApprovalConfig;
};

export type WorkflowAutomationConfig = {
  subtaskCompletion: {
    enabled: boolean;
    mode: "suggest" | "move";
    targetStatusKey: string | null;
  };
  cycleStart: {
    enabled: boolean;
    fromStatusKey: string | null;
    targetStatusKey: string | null;
  };
  overdue: {
    enabled: boolean;
    action: "notify";
  };
  githubPullRequest: {
    opened: {
      enabled: boolean;
      targetStatusKey: string | null;
    };
    merged: {
      enabled: boolean;
      targetStatusKey: string | null;
    };
  };
};

const STATUS_CATEGORIES: WorkspaceStatusCategory[] = [
  "backlog",
  "unstarted",
  "active",
  "review",
  "done",
  "cancelled",
];

const WORKFLOW_TRANSITION_ROLES: WorkflowTransitionRole[] = ["OWNER", "ADMIN", "MEMBER", "GUEST"];
const WORKFLOW_APPROVAL_REVIEWER_SOURCES: WorkflowApprovalReviewerSource[] = [
  "project_members",
  "team_lead",
  "department_head",
  "manual",
];

function isApprovalReviewerSource(value: unknown): value is WorkflowApprovalReviewerSource {
  return typeof value === "string" && WORKFLOW_APPROVAL_REVIEWER_SOURCES.includes(value as WorkflowApprovalReviewerSource);
}

function isStatusCategory(value: unknown): value is WorkspaceStatusCategory {
  return typeof value === "string" && STATUS_CATEGORIES.includes(value as WorkspaceStatusCategory);
}

function inferCategory(key: string, isFinal: boolean): WorkspaceStatusCategory {
  switch (key) {
    case "backlog":
    case "triage":
    case "groomed":
      return "backlog";
    case "todo":
    case "planned":
    case "ready":
      return "unstarted";
    case "in-progress":
    case "active":
    case "building":
      return "active";
    case "review":
    case "qa":
    case "verification":
      return "review";
    case "cancelled":
    case "canceled":
    case "archive":
    case "archived":
      return "cancelled";
    case "done":
    case "closed":
    case "released":
      return "done";
    default:
      return isFinal ? "done" : "active";
  }
}

function getDefaultVisibility(
  key: string,
  category: WorkspaceStatusCategory,
  isFinal: boolean,
  legacyShowOnBoard: boolean,
): WorkspaceStatusVisibility {
  const isBacklog = category === "backlog";
  const isCancelled = category === "cancelled";

  return {
    board: legacyShowOnBoard,
    list: true,
    filters: true,
    create: !isFinal && !isCancelled,
    cycleBoard: legacyShowOnBoard && !isBacklog && !isCancelled,
    cycleList: !isCancelled,
  };
}

function getDefaultCycleConfig(
  key: string,
  category: WorkspaceStatusCategory,
  isFinal: boolean,
): WorkspaceStatusCycleConfig {
  const allowedInCycle = category !== "cancelled";
  const countsAsCompleted = category === "done" || isFinal;
  const countsAsCarryOver = allowedInCycle && !countsAsCompleted;

  return {
    allowedInCycle,
    countsAsCompleted,
    countsAsCarryOver,
    planIntoThisStatus: key === "todo",
  };
}

function getDefaultTransitionConfig(): WorkspaceStatusTransitionConfig {
  return {
    mode: "free",
    to: [],
    allowRollback: false,
    allowedRoles: ["OWNER", "ADMIN", "MEMBER"],
    allowedUserIds: [],
    assigneeOnly: false,
    creatorOnly: false,
  };
}

function getDefaultRulesConfig(): WorkspaceStatusRuleConfig {
  return {
    requireAssignee: false,
    requireDueDate: false,
    requireAllSubtasksComplete: false,
    requireAcceptanceCriteria: false,
    requireParentIssue: false,
    requireIntegrationRef: false,
  };
}

function getDefaultApprovalConfig(): WorkspaceStatusApprovalConfig {
  return {
    required: false,
    requiredCount: 1,
    reviewerSource: "project_members",
    reviewerUserIds: [],
  };
}

function asStatusRecord(status: any, index: number): WorkspaceStatusRecord | null {
  if (!status || typeof status !== "object" || typeof status.key !== "string") {
    return null;
  }

  const key = status.key;
  const isFinal = status.isFinal === true;
  const isActive = status.isActive !== false;
  const legacyShowOnBoard = status.showOnBoard !== false;
  const category = isStatusCategory(status.category) ? status.category : inferCategory(key, isFinal);
  const defaultVisibility = getDefaultVisibility(key, category, isFinal, legacyShowOnBoard);
  const visibility = status.visibility && typeof status.visibility === "object"
    ? {
        board: isActive ? (status.visibility.board ?? defaultVisibility.board) : false,
        list: status.visibility.list ?? defaultVisibility.list,
        filters: status.visibility.filters ?? defaultVisibility.filters,
        create: isActive ? (status.visibility.create ?? defaultVisibility.create) : false,
        cycleBoard: isActive ? (status.visibility.cycleBoard ?? defaultVisibility.cycleBoard) : false,
        cycleList: isActive ? (status.visibility.cycleList ?? defaultVisibility.cycleList) : false,
      }
    : {
        ...defaultVisibility,
        board: isActive ? defaultVisibility.board : false,
        create: isActive ? defaultVisibility.create : false,
        cycleBoard: isActive ? defaultVisibility.cycleBoard : false,
        cycleList: isActive ? defaultVisibility.cycleList : false,
      };
  const defaultCycle = getDefaultCycleConfig(key, category, isFinal);
  const cycle = status.cycle && typeof status.cycle === "object"
    ? {
        allowedInCycle: status.cycle.allowedInCycle ?? defaultCycle.allowedInCycle,
        countsAsCompleted: status.cycle.countsAsCompleted ?? defaultCycle.countsAsCompleted,
        countsAsCarryOver: status.cycle.countsAsCarryOver ?? defaultCycle.countsAsCarryOver,
        planIntoThisStatus: status.cycle.planIntoThisStatus ?? defaultCycle.planIntoThisStatus,
      }
    : defaultCycle;
  const defaultTransitions = getDefaultTransitionConfig();
  const transitions = status.transitions && typeof status.transitions === "object"
    ? {
        mode: status.transitions.mode === "restricted" ? "restricted" : defaultTransitions.mode,
        to: Array.isArray(status.transitions.to)
          ? status.transitions.to.filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
          : defaultTransitions.to,
        allowRollback: status.transitions.allowRollback ?? defaultTransitions.allowRollback,
        allowedRoles: Array.isArray(status.transitions.allowedRoles)
          ? status.transitions.allowedRoles.filter((value: unknown): value is WorkflowTransitionRole =>
              typeof value === "string" && WORKFLOW_TRANSITION_ROLES.includes(value as WorkflowTransitionRole))
          : defaultTransitions.allowedRoles,
        allowedUserIds: Array.isArray(status.transitions.allowedUserIds)
          ? status.transitions.allowedUserIds.filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
          : defaultTransitions.allowedUserIds,
        assigneeOnly: status.transitions.assigneeOnly ?? defaultTransitions.assigneeOnly,
        creatorOnly: status.transitions.creatorOnly ?? defaultTransitions.creatorOnly,
      }
    : defaultTransitions;
  const defaultRules = getDefaultRulesConfig();
  const rules = status.rules && typeof status.rules === "object"
    ? {
        requireAssignee: status.rules.requireAssignee ?? defaultRules.requireAssignee,
        requireDueDate: status.rules.requireDueDate ?? defaultRules.requireDueDate,
        requireAllSubtasksComplete: status.rules.requireAllSubtasksComplete ?? defaultRules.requireAllSubtasksComplete,
        requireAcceptanceCriteria: status.rules.requireAcceptanceCriteria ?? defaultRules.requireAcceptanceCriteria,
        requireParentIssue: status.rules.requireParentIssue ?? defaultRules.requireParentIssue,
        requireIntegrationRef: status.rules.requireIntegrationRef ?? defaultRules.requireIntegrationRef,
      }
    : defaultRules;
  const defaultApproval = getDefaultApprovalConfig();
  const approval = status.approval && typeof status.approval === "object"
    ? {
        required: status.approval.required ?? defaultApproval.required,
        requiredCount: typeof status.approval.requiredCount === "number" && status.approval.requiredCount >= 1
          ? Math.floor(status.approval.requiredCount)
          : defaultApproval.requiredCount,
        reviewerSource: isApprovalReviewerSource(status.approval.reviewerSource)
          ? status.approval.reviewerSource
          : defaultApproval.reviewerSource,
        reviewerUserIds: Array.isArray(status.approval.reviewerUserIds)
          ? status.approval.reviewerUserIds.filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
          : defaultApproval.reviewerUserIds,
      }
    : defaultApproval;
  return {
    key,
    label: typeof status.label === "string" ? status.label : key,
    color: typeof status.color === "string" ? status.color : "#6b7280",
    order: typeof status.order === "number" ? status.order : index,
    category,
    isActive,
    isFinal,
    showOnBoard: visibility.board,
    visibility,
    cycle,
    transitions,
    rules,
    approval,
  };
}

export function normalizeWorkspaceStatuses(statuses: any[] | null | undefined): WorkspaceStatusRecord[] {
  const normalized = ((statuses as any[]) ?? [])
    .map(asStatusRecord)
    .filter((status): status is WorkspaceStatusRecord => Boolean(status))
    .sort((a, b) => a.order - b.order)
    .map((status, index) => ({
      ...status,
      order: index,
      showOnBoard: status.visibility.board,
      isActive: status.isActive !== false,
      visibility: {
        ...status.visibility,
        board: status.isActive === false ? false : status.visibility.board !== false,
        list: status.visibility.list !== false,
        filters: status.visibility.filters !== false,
        create: status.isActive === false ? false : status.visibility.create !== false,
        cycleBoard: status.isActive === false ? false : status.visibility.cycleBoard !== false,
        cycleList: status.isActive === false ? false : status.visibility.cycleList !== false,
      },
      transitions: {
        ...status.transitions,
        to: [...new Set(status.transitions.to.filter((target) => target !== status.key))],
        allowedRoles:
          status.transitions.allowedRoles.length > 0
            ? [...new Set(status.transitions.allowedRoles)]
            : [...WORKFLOW_TRANSITION_ROLES],
        allowedUserIds: [...new Set(status.transitions.allowedUserIds)],
      },
      rules: {
        ...status.rules,
      },
      approval: {
        ...status.approval,
        requiredCount: Math.max(1, status.approval.requiredCount),
        reviewerUserIds: [...new Set(status.approval.reviewerUserIds)],
      },
    }));

  const planDefaults = normalized.filter((status) => status.cycle.planIntoThisStatus);
  if (planDefaults.length === 0) {
    const fallback = normalized.find(
      (status) =>
        status.cycle.allowedInCycle &&
        status.visibility.cycleBoard &&
        !status.isFinal &&
        status.category !== "backlog",
    );
    if (fallback) {
      fallback.cycle.planIntoThisStatus = true;
    }
  } else if (planDefaults.length > 1) {
    const [first, ...rest] = planDefaults.sort((a, b) => a.order - b.order);
    if (first) {
      first.cycle.planIntoThisStatus = true;
    }
    rest.forEach((status) => {
      status.cycle.planIntoThisStatus = false;
    });
  }

  return normalized;
}

export function statusCountsAsCompleted(status: WorkspaceStatusRecord) {
  return status.cycle.countsAsCompleted || status.category === "done" || status.isFinal;
}

export function statusCountsAsCarryOver(status: WorkspaceStatusRecord) {
  return status.cycle.allowedInCycle && status.cycle.countsAsCarryOver;
}

export function statusVisibleOnBoard(status: WorkspaceStatusRecord) {
  return status.isActive !== false && status.visibility.board !== false;
}

export function statusVisibleInCycleBoard(status: WorkspaceStatusRecord) {
  return status.isActive !== false && status.visibility.cycleBoard !== false;
}

export function statusVisibleInCycleList(status: WorkspaceStatusRecord) {
  return status.isActive !== false && status.visibility.cycleList !== false;
}

export function statusVisibleInCreate(status: WorkspaceStatusRecord) {
  return status.isActive !== false && status.visibility.create !== false;
}

export function statusVisibleInFilters(status: WorkspaceStatusRecord) {
  return status.visibility.filters !== false;
}

export function statusAllowedInCycle(status: WorkspaceStatusRecord) {
  return status.cycle.allowedInCycle !== false;
}

export function getStatusRecord(
  statuses: WorkspaceStatusRecord[],
  statusKey: string | null | undefined,
) {
  return statuses.find((status) => status.key === statusKey) ?? null;
}

export function getDefaultCreateStatus(statusesInput: any[] | null | undefined) {
  const statuses = normalizeWorkspaceStatuses(statusesInput);
  const fallback = statuses.find((status) => statusVisibleInCreate(status) && !status.isFinal && status.category !== "cancelled");
  return fallback?.key ?? statuses[0]?.key ?? "todo";
}

function findStatusKey(
  statuses: WorkspaceStatusRecord[],
  preferredKeys: string[],
  matcher?: (status: WorkspaceStatusRecord) => boolean,
): string | null {
  for (const preferredKey of preferredKeys) {
    const found = statuses.find((status) => status.key === preferredKey && (!matcher || matcher(status)));
    if (found) {
      return found.key;
    }
  }

  const fallback = statuses.find((status) => !matcher || matcher(status));
  return fallback?.key ?? null;
}

function getDefaultSubtaskTarget(statuses: WorkspaceStatusRecord[]) {
  return findStatusKey(statuses, ["done"], (status) => status.isFinal === true);
}

function getDefaultReviewTarget(statuses: WorkspaceStatusRecord[]) {
  return findStatusKey(
    statuses,
    ["review", "qa", "verification"],
    (status) => status.isFinal !== true && statusVisibleOnBoard(status),
  );
}

function getDefaultCycleStartFrom(statuses: WorkspaceStatusRecord[]) {
  return findStatusKey(
    statuses,
    ["backlog"],
    (status) => status.isFinal !== true && statusAllowedInCycle(status),
  );
}

function getDefaultCycleStartTarget(statuses: WorkspaceStatusRecord[]) {
  return findStatusKey(
    statuses,
    ["todo", "in-progress", "review"],
    (status) =>
      status.isFinal !== true &&
      statusAllowedInCycle(status) &&
      statusVisibleInCycleBoard(status) &&
      status.key !== "backlog",
  );
}

export function getDefaultWorkflowAutomation(statusesInput: any[] | null | undefined): WorkflowAutomationConfig {
  const statuses = normalizeWorkspaceStatuses(statusesInput);

  return {
    subtaskCompletion: {
      enabled: true,
      mode: "suggest",
      targetStatusKey: getDefaultSubtaskTarget(statuses),
    },
    cycleStart: {
      enabled: false,
      fromStatusKey: getDefaultCycleStartFrom(statuses),
      targetStatusKey: getDefaultCycleStartTarget(statuses),
    },
    overdue: {
      enabled: false,
      action: "notify",
    },
    githubPullRequest: {
      opened: {
        enabled: true,
        targetStatusKey: getDefaultReviewTarget(statuses),
      },
      merged: {
        enabled: true,
        targetStatusKey: getDefaultSubtaskTarget(statuses),
      },
    },
  };
}

function normalizeTargetStatusKey(
  statuses: WorkspaceStatusRecord[],
  value: unknown,
  fallback: string | null,
  matcher?: (status: WorkspaceStatusRecord) => boolean,
): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }

  const found = statuses.find((status) => status.key === value && (!matcher || matcher(status)));
  return found?.key ?? fallback;
}

export function normalizeWorkflowAutomation(
  value: unknown,
  statusesInput: any[] | null | undefined,
): WorkflowAutomationConfig {
  const statuses = normalizeWorkspaceStatuses(statusesInput);
  const defaults = getDefaultWorkflowAutomation(statuses);
  const raw = value && typeof value === "object" ? (value as Record<string, any>) : {};

  const subtaskTarget = normalizeTargetStatusKey(
    statuses,
    raw.subtaskCompletion?.targetStatusKey,
    defaults.subtaskCompletion.targetStatusKey,
    (status) => status.isFinal === true,
  );

  const cycleFrom = normalizeTargetStatusKey(
    statuses,
    raw.cycleStart?.fromStatusKey,
    defaults.cycleStart.fromStatusKey,
    (status) => status.isFinal !== true && statusAllowedInCycle(status),
  );

  const cycleTarget = normalizeTargetStatusKey(
    statuses,
    raw.cycleStart?.targetStatusKey,
    defaults.cycleStart.targetStatusKey,
    (status) => status.isFinal !== true && statusVisibleInCycleBoard(status) && statusAllowedInCycle(status),
  );

  const reviewTarget = normalizeTargetStatusKey(
    statuses,
    raw.githubPullRequest?.opened?.targetStatusKey,
    defaults.githubPullRequest.opened.targetStatusKey,
    (status) => status.isFinal !== true && statusVisibleOnBoard(status),
  );

  const mergedTarget = normalizeTargetStatusKey(
    statuses,
    raw.githubPullRequest?.merged?.targetStatusKey,
    defaults.githubPullRequest.merged.targetStatusKey,
    (status) => status.isFinal === true,
  );

  return {
    subtaskCompletion: {
      enabled: raw.subtaskCompletion?.enabled ?? defaults.subtaskCompletion.enabled,
      mode: raw.subtaskCompletion?.mode === "move" ? "move" : defaults.subtaskCompletion.mode,
      targetStatusKey: subtaskTarget,
    },
    cycleStart: {
      enabled: raw.cycleStart?.enabled ?? defaults.cycleStart.enabled,
      fromStatusKey: cycleFrom,
      targetStatusKey: cycleTarget && cycleTarget !== cycleFrom ? cycleTarget : defaults.cycleStart.targetStatusKey,
    },
    overdue: {
      enabled: raw.overdue?.enabled ?? defaults.overdue.enabled,
      action: "notify",
    },
    githubPullRequest: {
      opened: {
        enabled: raw.githubPullRequest?.opened?.enabled ?? defaults.githubPullRequest.opened.enabled,
        targetStatusKey: reviewTarget,
      },
      merged: {
        enabled: raw.githubPullRequest?.merged?.enabled ?? defaults.githubPullRequest.merged.enabled,
        targetStatusKey: mergedTarget,
      },
    },
  };
}
