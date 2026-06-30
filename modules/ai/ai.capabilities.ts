export type AiIntent =
  | "CREATE_PROJECT"
  | "CREATE_TEAM"
  | "CREATE_DEPARTMENT"
  | "UPDATE_PROJECT"
  | "PROJECT_HEALTH"
  | "PROJECT_PROGRESS"
  | "PROJECT_RISK"
  | "PROJECT_SUMMARY"
  | "PROJECT_REPORT"
  | "COMPARE_PROJECTS"
  | "LIST_PROJECTS"
  | "CREATE_ISSUE"
  | "UPDATE_ISSUE"
  | "UPDATE_ISSUE_STATUS"
  | "ASSIGN_ISSUE"
  | "SEARCH_ISSUES"
  | "MY_TASKS"
  | "USER_TASKS"
  | "OVERDUE_TASKS"
  | "BLOCKED_TASKS"
  | "PRIORITIZE_TASKS"
  | "ADD_COMMENT"
  | "CREATE_CHECKLIST"
  | "TEAM_WORKLOAD"
  | "USER_WORKLOAD"
  | "INDIVIDUAL_REPORT"
  | "TEAM_REPORT"
  | "WHO_IS_OVERLOADED"
  | "WHO_IS_BLOCKED"
  | "ROLE_OR_ACCESS_QUESTION"
  | "INVITE_MEMBER"
  | "REMOVE_MEMBER"
  | "CREATE_CYCLE"
  | "UPDATE_CYCLE"
  | "CYCLE_STATUS"
  | "SPRINT_PROGRESS"
  | "UPCOMING_DEADLINES"
  | "WORKSPACE_SUMMARY"
  | "ACTIVITY_SUMMARY"
  | "PERFORMANCE_REPORT"
  | "TEAM_PERFORMANCE"
  | "PRODUCTIVITY_TRENDS"
  | "GENERAL_APP_HELP"
  | "HOW_TO_USE_FEATURE"
  | "APP_NAVIGATION_HELP"
  | "DELETE_REQUEST_BLOCKED"
  | "IRREVERSIBLE_ACTION_BLOCKED"
  | "UNKNOWN";

export type AiActionRisk = "low" | "medium" | "high" | "blocked";
export type AiExecutionMode = "query" | "mutation" | "blocked";
export type AiEntityType = "project" | "team" | "department" | "member" | "cycle" | "issue" | "workspace";

export type CapabilityToolMetadata = {
  requires: string[];
  optional: string[];
  supportsStreaming: boolean;
  supportsPagination: boolean;
  risk: AiActionRisk;
};

export type CapabilityCandidate = {
  intent: AiIntent;
  executor: string;
  confidence: number;
  reason: string;
  riskLevel: AiActionRisk;
  executionMode: AiExecutionMode;
};

export type CapabilityRegistryEntry = {
  intent: AiIntent;
  requiredEntityTypes: AiEntityType[];
  requiredSlots: string[];
  riskLevel: AiActionRisk;
  executionMode: AiExecutionMode;
  executor: string;
  metadata: CapabilityToolMetadata;
};

const DEFAULT_TOOL_METADATA: CapabilityToolMetadata = {
  requires: [],
  optional: [],
  supportsStreaming: false,
  supportsPagination: false,
  risk: "low",
};

const EXECUTOR_METADATA: Record<string, Partial<CapabilityToolMetadata>> = {
  list_projects: { requires: ["workspace"], supportsPagination: true },
  list_issues: { requires: ["workspace"], optional: ["project", "team", "assignee", "status", "priority"], supportsPagination: true },
  search_issues: { requires: ["workspace"], optional: ["project", "team"], supportsPagination: true },
  create_issue: { requires: ["workspace", "project", "title"], optional: ["assignee", "priority", "dueDate", "status"], risk: "low" },
  update_issue: { requires: ["workspace", "issue"], optional: ["title", "description", "priority", "status", "dueDate"], risk: "medium" },
  update_issue_status: { requires: ["workspace", "issue", "status"], risk: "medium" },
  assign_issue: { requires: ["workspace", "issue", "assignee"], risk: "medium" },
  add_comment: { requires: ["workspace", "issue", "body"], risk: "low" },
  create_subtask: { requires: ["workspace", "issue", "title"], risk: "low" },
  get_project_analytics: { requires: ["workspace", "project"], optional: ["period", "from", "to"] },
  get_project_summary: { requires: ["workspace", "project"] },
  compare_projects: { requires: ["workspace", "project", "comparisonTarget"] },
  get_team_workload: { requires: ["workspace", "team"] },
  get_team_analytics: { requires: ["workspace", "team"], optional: ["period", "from", "to"] },
  get_member_analytics: { requires: ["workspace", "member"], optional: ["period", "from", "to"] },
  get_cycle_analytics: { requires: ["workspace", "cycle"], optional: ["period", "from", "to"] },
  get_workspace_analytics: { requires: ["workspace"], optional: ["period", "from", "to"] },
  export_analytics_report: { requires: ["workspace", "scope"], optional: ["scopeId", "period", "from", "to", "format"] },
  activity_summary: { requires: ["workspace"], optional: ["period", "from", "to"] },
  prioritize_tasks: { requires: ["workspace"], optional: ["project", "team", "assignee"] },
  invite_member: { requires: ["workspace", "team", "email", "role"], risk: "medium" },
  remove_member: { requires: ["workspace", "member"], risk: "high" },
  remove_team_member: { requires: ["workspace", "team", "member"], risk: "high" },
  remove_project_member: { requires: ["workspace", "project", "member"], risk: "high" },
  remove_department_member: { requires: ["workspace", "department", "member"], risk: "high" },
  remove_workspace_member: { requires: ["workspace", "member"], risk: "high" },
  create_project: { requires: ["workspace", "name"], optional: ["team"], risk: "low" },
  update_project: { requires: ["workspace", "project"], optional: ["name", "status", "team"], risk: "medium" },
  create_team: { requires: ["workspace", "name", "leadId"], risk: "low" },
  create_department: { requires: ["workspace", "name"], risk: "low" },
  create_cycle: { requires: ["workspace", "team", "name", "startsAt", "endsAt"], risk: "medium" },
  update_cycle: { requires: ["workspace", "cycle"], optional: ["name", "status", "startsAt", "endsAt"], risk: "medium" },
  app_help: { requires: ["workspace"], optional: ["query"], supportsStreaming: true },
  get_workspace_access_summary: { requires: ["workspace"] },
  upcoming_deadlines: { requires: ["workspace"], optional: ["project", "team", "member"] },
  policy_block: { requires: [], risk: "blocked" },
  unknown: { requires: [], optional: ["prompt"] },
};

function metadataForExecutor(executor: string, riskLevel: AiActionRisk): CapabilityToolMetadata {
  const metadata = EXECUTOR_METADATA[executor] ?? {};
  return {
    ...DEFAULT_TOOL_METADATA,
    ...metadata,
    risk: metadata.risk ?? riskLevel,
  };
}

function capability(
  intent: AiIntent,
  requiredEntityTypes: AiEntityType[],
  requiredSlots: string[],
  riskLevel: AiActionRisk,
  executionMode: AiExecutionMode,
  executor: string,
): CapabilityRegistryEntry {
  return {
    intent,
    requiredEntityTypes,
    requiredSlots,
    riskLevel,
    executionMode,
    executor,
    metadata: metadataForExecutor(executor, riskLevel),
  };
}

export const AI_CAPABILITY_REGISTRY: CapabilityRegistryEntry[] = [
  capability("CREATE_PROJECT", [], ["name"], "low", "mutation", "create_project"),
  capability("CREATE_TEAM", [], ["name", "leadId"], "low", "mutation", "create_team"),
  capability("CREATE_DEPARTMENT", [], ["name"], "low", "mutation", "create_department"),
  capability("UPDATE_PROJECT", ["project"], ["updateField"], "medium", "mutation", "update_project"),
  capability("PROJECT_HEALTH", ["project"], [], "low", "query", "get_project_analytics"),
  capability("PROJECT_PROGRESS", ["project"], [], "low", "query", "get_project_analytics"),
  capability("PROJECT_RISK", ["project"], [], "low", "query", "get_project_analytics"),
  capability("PROJECT_SUMMARY", ["project"], [], "low", "query", "get_project_summary"),
  capability("PROJECT_REPORT", ["project"], [], "low", "query", "get_project_analytics"),
  capability("COMPARE_PROJECTS", ["project"], ["comparisonTarget"], "low", "query", "compare_projects"),
  capability("LIST_PROJECTS", [], [], "low", "query", "list_projects"),
  capability("CREATE_ISSUE", ["project"], ["title"], "low", "mutation", "create_issue"),
  capability("UPDATE_ISSUE", ["issue"], ["updateField"], "medium", "mutation", "update_issue"),
  capability("UPDATE_ISSUE_STATUS", ["issue"], ["status"], "medium", "mutation", "update_issue_status"),
  capability("ASSIGN_ISSUE", ["issue", "member"], [], "medium", "mutation", "assign_issue"),
  capability("SEARCH_ISSUES", [], [], "low", "query", "search_issues"),
  capability("MY_TASKS", [], [], "low", "query", "list_issues"),
  capability("USER_TASKS", ["member"], [], "low", "query", "list_issues"),
  capability("OVERDUE_TASKS", [], [], "low", "query", "list_issues"),
  capability("BLOCKED_TASKS", [], [], "low", "query", "list_issues"),
  capability("PRIORITIZE_TASKS", [], [], "low", "query", "prioritize_tasks"),
  capability("ADD_COMMENT", ["issue"], ["body"], "low", "mutation", "add_comment"),
  capability("CREATE_CHECKLIST", ["issue"], ["title"], "low", "mutation", "create_subtask"),
  capability("TEAM_WORKLOAD", ["team"], [], "low", "query", "get_team_workload"),
  capability("USER_WORKLOAD", ["member"], [], "low", "query", "get_member_analytics"),
  capability("INDIVIDUAL_REPORT", ["member"], [], "low", "query", "get_member_analytics"),
  capability("TEAM_REPORT", ["team"], [], "low", "query", "get_team_analytics"),
  capability("WHO_IS_OVERLOADED", [], [], "low", "query", "get_workspace_analytics"),
  capability("WHO_IS_BLOCKED", [], [], "low", "query", "list_issues"),
  capability("ROLE_OR_ACCESS_QUESTION", ["workspace"], [], "low", "query", "get_workspace_access_summary"),
  capability("INVITE_MEMBER", ["team"], ["email", "role"], "medium", "mutation", "invite_member"),
  capability("REMOVE_MEMBER", ["member"], [], "high", "mutation", "remove_member"),
  capability("CREATE_CYCLE", ["team"], ["name", "startsAt", "endsAt"], "medium", "mutation", "create_cycle"),
  capability("UPDATE_CYCLE", ["cycle"], [], "medium", "mutation", "update_cycle"),
  capability("CYCLE_STATUS", ["cycle"], [], "low", "query", "get_cycle_analytics"),
  capability("SPRINT_PROGRESS", ["cycle"], [], "low", "query", "get_cycle_analytics"),
  capability("UPCOMING_DEADLINES", [], [], "low", "query", "upcoming_deadlines"),
  capability("WORKSPACE_SUMMARY", ["workspace"], [], "low", "query", "get_workspace_analytics"),
  capability("ACTIVITY_SUMMARY", ["workspace"], [], "low", "query", "activity_summary"),
  capability("PERFORMANCE_REPORT", ["workspace"], [], "low", "query", "get_workspace_analytics"),
  capability("TEAM_PERFORMANCE", ["team"], [], "low", "query", "get_team_analytics"),
  capability("PRODUCTIVITY_TRENDS", ["workspace"], [], "low", "query", "get_workspace_analytics"),
  capability("GENERAL_APP_HELP", [], [], "low", "query", "app_help"),
  capability("HOW_TO_USE_FEATURE", [], [], "low", "query", "app_help"),
  capability("APP_NAVIGATION_HELP", [], [], "low", "query", "app_help"),
  capability("DELETE_REQUEST_BLOCKED", [], [], "blocked", "blocked", "policy_block"),
  capability("IRREVERSIBLE_ACTION_BLOCKED", [], [], "blocked", "blocked", "policy_block"),
  capability("UNKNOWN", [], [], "low", "query", "unknown"),
];

export function getCapabilityForIntent(intent: AiIntent): CapabilityRegistryEntry | null {
  return AI_CAPABILITY_REGISTRY.find((entry) => entry.intent === intent) ?? null;
}

export function buildCapabilityCandidate(intent: AiIntent, confidence: number, reason: string): CapabilityCandidate | null {
  const capabilityEntry = getCapabilityForIntent(intent);
  if (!capabilityEntry) return null;
  return {
    intent,
    executor: capabilityEntry.executor,
    confidence,
    reason,
    riskLevel: capabilityEntry.riskLevel,
    executionMode: capabilityEntry.executionMode,
  };
}
