import { callAI, CHAT_MODEL_DEFAULT } from "./ai.provider.js";
import { buildCapabilityCandidate, getCapabilityForIntent, type AiEntityType, type AiIntent, type CapabilityCandidate } from "./ai.capabilities.js";
import { incrementAiMetricCounter, logAiInfo, logAiWarn } from "./ai.observability.js";
import { normalizeUnicodeText } from "./ai.text-normalization.js";
import type { ToolDomain } from "./tools/tool-definitions.js";

export type IntentClassifierSource = "deterministic" | "model" | "fallback";
export type AnalyticsScopeKind = "workspace" | "project" | "team" | "member" | "cycle";

export type IntentClassification = {
  intent: AiIntent;
  confidence: number;
  expectedEntityTypes: AiEntityType[];
  reason: string;
  source: IntentClassifierSource;
  overlappingBusinessIntent?: boolean | undefined;
  preferredScopeKind?: AnalyticsScopeKind | undefined;
  capabilityCandidates?: CapabilityCandidate[] | undefined;
};

type HybridClassifierOptions = {
  workspaceId?: string | undefined;
  userId?: string | undefined;
  conversationId?: string | undefined;
  allowModel?: boolean | undefined;
  modelClassifier?: ((message: string, normalized: string) => Promise<Partial<IntentClassification> | null>) | undefined;
};

// Mirrors ai.memory.ts's REFERENCE_PRONOUN_PATTERN. Not imported directly — ai.memory.ts pulls
// in ai.action-state.ts, which imports this module, so importing across that edge would create
// a circular dependency for what is otherwise a one-line regex literal.
const BACK_REFERENCE_PATTERN = /\b(it|that|this|them|those|these)\b/i;

const ROLE_VARIANTS = ["role", "rle", "roles", "permission", "permissions", "access", "allowed"];
const REPORT_VARIANTS = ["report", "status", "progress", "health", "shape", "track", "risk", "doing", "summary", "performance"];
const OVERLOAD_VARIANTS = ["overloaded", "overload", "heavy workload", "too much work", "who needs help", "blocked", "bottleneck", "stressed", "stress", "burned out", "burnt out", "burnout", "under pressure", "swamped"];
const GREETING_VARIANTS = ["hi", "hello", "hey", "salam", "how are you", "thanks", "thank you"];
const BUSINESS_INTENTS = new Set<AiIntent>([
  "PROJECT_HEALTH",
  "PROJECT_PROGRESS",
  "PROJECT_RISK",
  "PROJECT_SUMMARY",
  "PROJECT_REPORT",
  "COMPARE_PROJECTS",
  "TEAM_WORKLOAD",
  "TEAM_REPORT",
  "INDIVIDUAL_REPORT",
  "USER_WORKLOAD",
  "WHO_IS_OVERLOADED",
  "WHO_IS_BLOCKED",
  "CYCLE_STATUS",
  "SPRINT_PROGRESS",
  "WORKSPACE_SUMMARY",
  "ACTIVITY_SUMMARY",
  "PERFORMANCE_REPORT",
  "TEAM_PERFORMANCE",
  "PRODUCTIVITY_TRENDS",
  "UPCOMING_DEADLINES",
  "PRIORITIZE_TASKS",
  "LIST_PROJECTS",
  "MY_TASKS",
  "SEARCH_ISSUES",
  "OVERDUE_TASKS",
  "BLOCKED_TASKS",
]);
const MODEL_INTENTS: AiIntent[] = [
  "PROJECT_REPORT",
  "PROJECT_HEALTH",
  "PROJECT_PROGRESS",
  "PROJECT_RISK",
  "COMPARE_PROJECTS",
  "TEAM_REPORT",
  "TEAM_WORKLOAD",
  "INDIVIDUAL_REPORT",
  "USER_WORKLOAD",
  "WHO_IS_OVERLOADED",
  "WHO_IS_BLOCKED",
  "CYCLE_STATUS",
  "SPRINT_PROGRESS",
  "WORKSPACE_SUMMARY",
  "ACTIVITY_SUMMARY",
  "PERFORMANCE_REPORT",
  "TEAM_PERFORMANCE",
  "PRODUCTIVITY_TRENDS",
  "UPCOMING_DEADLINES",
  "PRIORITIZE_TASKS",
  "LIST_PROJECTS",
  "MY_TASKS",
  "SEARCH_ISSUES",
  "OVERDUE_TASKS",
  "BLOCKED_TASKS",
  "UNKNOWN",
];
const MODEL_CLASSIFIER = CHAT_MODEL_DEFAULT;

function normalizeInput(value: string) {
  return normalizeUnicodeText(value);
}

function looksLikeEntityBriefingRequest(normalized: string) {
  return /\b(?:tell me about|what about|describe|brief me on|summarize|summary of)\b\s+.+/.test(normalized);
}

function editDistance(a: string, b: string) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) matrix[i]![0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0]![j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      );
    }
  }

  return matrix[a.length]![b.length]!;
}

function tokenLooksLike(token: string, target: string) {
  if (token === target) return true;
  if (token.length < 3 || target.length < 3) return false;
  return editDistance(token, target) <= 1;
}

function hasVariant(normalized: string, variants: string[]) {
  const tokens = normalized.split(" ");
  return variants.some((variant) => {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`, "i").test(normalized)) return true;
    if (variant.includes(" ")) return false;
    return tokens.some((token) => tokenLooksLike(token, variant));
  });
}

function looksLikeDeleteRequest(normalized: string) {
  return /\b(delete|destroy|wipe|hard remove|permanently remove|delte)\b/.test(normalized);
}

function looksLikeIrreversiblePolicyRequest(normalized: string) {
  return (
    /\b(cancel|delete|remove|destroy|revoke|disconnect)\b/.test(normalized) &&
    (
      /\b(billing|subscription|plan|payment method)\b/.test(normalized) ||
      /\b(api key|access token|credential|secret|integration connection)\b/.test(normalized)
    )
  );
}

function hasAnyScopeWord(normalized: string) {
  return /\b(workspace|project|app|team|member|employee|user|person|cycle|sprint)\b/.test(normalized);
}

function inferPreferredScope(normalized: string): AnalyticsScopeKind | undefined {
  if (/\bworkspace\b/.test(normalized)) return "workspace";
  if (/\b(project|app)\b/.test(normalized)) return "project";
  if (/\bteam\b/.test(normalized)) return "team";
  if (/\b(member|employee|user|person)\b/.test(normalized)) return "member";
  if (/\b(my|me)\b/.test(normalized) && /\b(report|performance|workload|progress|activity|analytics|tasks|issues)\b/.test(normalized)) return "member";
  if (/\b(cycle|sprint)\b/.test(normalized)) return "cycle";
  return undefined;
}

const TOOL_DOMAIN_PATTERNS: Array<{ domain: ToolDomain; pattern: RegExp }> = [
  { domain: "issues", pattern: /\b(issue(s)?|task(s)?|bug(s)?|subtask(s)?|watcher(s)?|dependenc(y|ies)|label(s)?)\b/ },
  { domain: "projects", pattern: /\bproject(s)?\b/ },
  { domain: "teams", pattern: /\bteam(s)?\b/ },
  { domain: "departments", pattern: /\bdepartment(s)?\b/ },
  { domain: "workspace", pattern: /\b(workspace(s)?|member(s)?|role(s)?|invite(s)?|invitation(s)?)\b/ },
  { domain: "cycles", pattern: /\b(cycle(s)?|sprint(s)?)\b/ },
  { domain: "templates", pattern: /\btemplate(s)?\b/ },
  { domain: "notifications", pattern: /\bnotification(s)?\b/ },
  { domain: "documents", pattern: /\b(document(s)?|doc(s)?|folder(s)?)\b/ },
  { domain: "roadmap", pattern: /\b(roadmap(s)?|milestone(s)?)\b/ },
  { domain: "integrations", pattern: /\b(api key|integration(s)?|slack|github|discord|figma)\b/ },
  { domain: "analytics", pattern: /\b(analytics?|report(s)?|performance|workload|velocity|overloaded|progress|health|burndown|priorit\w*)\b/ },
];

/**
 * Keyword-based domain detection used to scope which tool schemas get sent to the model
 * (see getScopedToolDefinitions). Scans the current message plus recent conversation text
 * so a bare follow-up like "yes" still inherits the domain of what it's confirming — the
 * current message alone often has no domain keywords at all.
 */
export function detectToolDomains(...texts: string[]): ToolDomain[] {
  const normalized = normalizeInput(texts.join(" "));
  return TOOL_DOMAIN_PATTERNS.filter(({ pattern }) => pattern.test(normalized)).map(({ domain }) => domain);
}

function capability(intent: AiIntent, confidence: number, reason: string, source: IntentClassifierSource, extras?: {
  overlappingBusinessIntent?: boolean | undefined;
  preferredScopeKind?: AnalyticsScopeKind | undefined;
  capabilityCandidates?: CapabilityCandidate[] | undefined;
}): IntentClassification {
  return {
    intent,
    confidence,
    expectedEntityTypes: getCapabilityForIntent(intent)?.requiredEntityTypes ?? [],
    reason,
    source,
    ...(extras?.overlappingBusinessIntent !== undefined ? { overlappingBusinessIntent: extras.overlappingBusinessIntent } : {}),
    ...(extras?.preferredScopeKind ? { preferredScopeKind: extras.preferredScopeKind } : {}),
    ...(extras?.capabilityCandidates?.length ? { capabilityCandidates: extras.capabilityCandidates } : {}),
  };
}

function buildCapabilityCandidates(entries: Array<{ intent: AiIntent; confidence: number; reason: string }>) {
  return entries
    .map((entry) => buildCapabilityCandidate(entry.intent, entry.confidence, entry.reason))
    .filter((entry): entry is CapabilityCandidate => entry !== null)
    .sort((left, right) => right.confidence - left.confidence);
}

function classifyDeterministicObvious(normalized: string, rawMessage: string): IntentClassification | null {
  if (!normalized) return capability("UNKNOWN", 0.2, "Empty input.", "deterministic");
  if (looksLikeDeleteRequest(normalized)) return capability("DELETE_REQUEST_BLOCKED", 0.99, "Delete-style wording detected.", "deterministic");
  if (looksLikeIrreversiblePolicyRequest(normalized)) return capability("IRREVERSIBLE_ACTION_BLOCKED", 0.99, "Irreversible credential or billing change detected.", "deterministic");
  if (/\b(remove|kick)\b/.test(normalized) && /\bfrom\b/.test(normalized)) return capability("REMOVE_MEMBER", 0.97, "Membership removal phrasing detected.", "deterministic");
  if (/\b(invite|send invite|add someone)\b/.test(normalized) || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(rawMessage)) return capability("INVITE_MEMBER", 0.96, "Invite wording detected.", "deterministic");
  if (/\b(create|new|open|file)\b/.test(normalized) && /\b(issue|task|bug)\b/.test(normalized)) return capability("CREATE_ISSUE", 0.98, "Issue creation wording detected.", "deterministic");
  if (/\b(assign|reassign)\b/.test(normalized) && (/\b(issue|task|bug|[a-z]{2,10}-\d+)\b/.test(normalized) || /\b(it|that|this)\b/.test(normalized))) {
    return capability("ASSIGN_ISSUE", 0.96, "Issue assignment wording detected.", "deterministic");
  }
  if (
    (
      /\b(rename|retitle)\b/.test(normalized) ||
      (
        /\bproject\b/.test(normalized) &&
        /\b(change|update|set)\b/.test(normalized) &&
        /\b(name|description|desc|status)\b/.test(normalized)
      )
    ) &&
    !/\b(issue|task|bug|team|department|cycle|sprint)\b/.test(normalized)
  ) {
    return capability("UPDATE_PROJECT", 0.95, "Project update wording detected.", "deterministic");
  }
  if (/\b(comment|reply|note)\b/.test(normalized) && /\b(issue|task|bug|[a-z]{2,10}-\d+)\b/.test(normalized)) return capability("ADD_COMMENT", 0.95, "Issue comment wording detected.", "deterministic");
  if (/\b(set|move|mark|change|update)\b/.test(normalized) && /\b(todo|in progress|in-progress|review|done|backlog)\b/.test(normalized) && (/\b(issue|task|bug|[a-z]{2,10}-\d+)\b/.test(normalized) || /\b(it|that|this)\b/.test(normalized))) {
    return capability("UPDATE_ISSUE_STATUS", 0.95, "Issue status update wording detected.", "deterministic");
  }
  if (/\b(create|new)\b/.test(normalized) && /\bproject\b/.test(normalized)) return capability("CREATE_PROJECT", 0.98, "Project creation wording detected.", "deterministic");
  if (/\b(create|new)\b/.test(normalized) && /\bteam\b/.test(normalized)) return capability("CREATE_TEAM", 0.98, "Team creation wording detected.", "deterministic");
  if (/\b(create|new)\b/.test(normalized) && /\bdepartment\b/.test(normalized)) return capability("CREATE_DEPARTMENT", 0.98, "Department creation wording detected.", "deterministic");
  if (/\b(create|new)\b/.test(normalized) && /\b(cycle|sprint)\b/.test(normalized)) return capability("CREATE_CYCLE", 0.98, "Cycle creation wording detected.", "deterministic");
  if (/\b(list|show|what are|which are)\b/.test(normalized) && /\bprojects\b/.test(normalized)) return capability("LIST_PROJECTS", 0.95, "Project listing wording detected.", "deterministic");
  if ((/\b(my|me)\b/.test(normalized) && /\b(tasks|issues)\b/.test(normalized)) || /\bshow my issues\b/.test(normalized)) return capability("MY_TASKS", 0.95, "My tasks wording detected.", "deterministic");
  if (/\b(search|find|look up)\b/.test(normalized) && /\b(issue|task|bug)\b/.test(normalized)) return capability("SEARCH_ISSUES", 0.93, "Issue search wording detected.", "deterministic");
  if (/\b(overdue|late|missed deadline)\b/.test(normalized)) return capability("OVERDUE_TASKS", 0.94, "Overdue task wording detected.", "deterministic");
  if (/\b(blocked|stuck|waiting on)\b/.test(normalized) && /\b(issue|task|bug)?\b/.test(normalized)) return capability("BLOCKED_TASKS", 0.94, "Blocked task wording detected.", "deterministic");
  if (/\b(where is|how do i open|navigate|go to|where can i find)\b/.test(normalized)) return capability("APP_NAVIGATION_HELP", 0.9, "Navigation help wording detected.", "deterministic");
  if (hasVariant(normalized, ROLE_VARIANTS) && /\b(my|me|i)\b/.test(normalized)) return capability("ROLE_OR_ACCESS_QUESTION", 0.96, "Role/access wording detected.", "deterministic");
  if (/^(hi|hello|hey|salam|how are you|thanks|thank you)\b/.test(normalized) || hasVariant(normalized, GREETING_VARIANTS)) return capability("GENERAL_APP_HELP", 0.82, "Greeting/help wording detected.", "deterministic");
  return null;
}

function classifyDeterministicBusiness(normalized: string): IntentClassification {
  const preferredScopeKind = inferPreferredScope(normalized);
  const business = (intent: AiIntent, confidence: number, reason: string) =>
    capability(intent, confidence, reason, "deterministic", { overlappingBusinessIntent: BUSINESS_INTENTS.has(intent), preferredScopeKind });
  const ambiguousBusinessForScope = (scopeKind: AnalyticsScopeKind, reason: string) =>
    capability("UNKNOWN", 0.44, reason, "deterministic", {
      preferredScopeKind: scopeKind,
      capabilityCandidates: buildCapabilityCandidates([
        { intent: scopeKind === "workspace" ? "WORKSPACE_SUMMARY" : "PROJECT_REPORT", confidence: 0.66, reason: "This broad question most likely targets the primary scoped report." },
        { intent: scopeKind === "team" ? "TEAM_REPORT" : "PROJECT_HEALTH", confidence: 0.55, reason: "This could also be a health-style business question." },
      ]),
    });
  const ambiguousBusiness = (reason: string) =>
    capability("UNKNOWN", 0.42, reason, "deterministic", {
      preferredScopeKind,
      capabilityCandidates: buildCapabilityCandidates([
        { intent: "WORKSPACE_SUMMARY", confidence: preferredScopeKind === "workspace" ? 0.64 : 0.48, reason: "Workspace-wide reporting is a plausible interpretation." },
        { intent: "PROJECT_REPORT", confidence: preferredScopeKind === "project" ? 0.63 : 0.46, reason: "Project-level reporting is a plausible interpretation." },
        { intent: "TEAM_REPORT", confidence: preferredScopeKind === "team" ? 0.61 : 0.43, reason: "Team-level reporting is a plausible interpretation." },
        { intent: "INDIVIDUAL_REPORT", confidence: preferredScopeKind === "member" ? 0.6 : 0.4, reason: "Member-level reporting is a plausible interpretation." },
        { intent: "CYCLE_STATUS", confidence: preferredScopeKind === "cycle" ? 0.59 : 0.37, reason: "Cycle-level reporting is a plausible interpretation." },
      ]),
    });

  if (/\b(compare|comparison|versus|vs)\b/.test(normalized) && /\b(project|app)\b/.test(normalized)) {
    return business("COMPARE_PROJECTS", 0.83, "Project comparison wording detected.");
  }
  if (hasVariant(normalized, OVERLOAD_VARIANTS)) {
    return business("WHO_IS_OVERLOADED", 0.84, "Workload or overload wording detected.");
  }
  if (/\b(activity|recent activity|updates)\b/.test(normalized)) {
    return business("ACTIVITY_SUMMARY", 0.78, "Activity summary wording detected.");
  }
  if (/\b(prioritize|priority order|what should i work on next|next task)\b/.test(normalized)) {
    return business("PRIORITIZE_TASKS", 0.78, "Task prioritization wording detected.");
  }
  if (/\b(my work|my queue|my items)\b/.test(normalized)) {
    return business("MY_TASKS", 0.78, "Personal task queue wording detected.");
  }
  if (/\b(show.*projects|projects list|available projects)\b/.test(normalized)) {
    return business("LIST_PROJECTS", 0.78, "Project listing wording detected.");
  }
  if (/\b(find.*issue|search.*issue)\b/.test(normalized)) {
    return business("SEARCH_ISSUES", 0.76, "Issue search wording detected.");
  }
  if (/\b(deadline|due soon|upcoming due)\b/.test(normalized)) {
    return business("UPCOMING_DEADLINES", 0.78, "Upcoming deadlines wording detected.");
  }
  if (/\boverdue\b/.test(normalized)) {
    return business("OVERDUE_TASKS", 0.8, "Overdue task wording detected.");
  }
  if (/\bblocked|stuck|waiting on\b/.test(normalized)) {
    return business("BLOCKED_TASKS", 0.8, "Blocked task wording detected.");
  }
  if (
    !preferredScopeKind &&
    /\b(?:how\s+(?:is|s)\s+.+\s+doing|is\s+.+\s+(?:healthy|at\s+risk)|.+\s+(?:in\s+bad\s+shape|doing\s+well|doing\s+badly))\b/.test(normalized)
  ) {
    return ambiguousBusinessForScope("project", "A broad entity-health question likely refers to a project and needs semantic classification before execution.");
  }
  // A bare back-reference ("tell me about them/it/that/detail") with no explicit scope keyword
  // and no report-ish wording is much more likely a conversational follow-up pointing at
  // something already surfaced this conversation (e.g. issues just listed) than a fresh
  // analytics/report request. Forcing these into a report-scope clarification produced
  // out-of-nowhere "which report?" replies on plain follow-ups — defer to the free-form loop
  // instead, which already has full conversation history (including prior tool results) to
  // resolve the reference correctly.
  const isBareBackReference =
    BACK_REFERENCE_PATTERN.test(normalized) &&
    !preferredScopeKind &&
    !hasVariant(normalized, REPORT_VARIANTS) &&
    !/\banalytics?\b/.test(normalized);

  if (looksLikeEntityBriefingRequest(normalized) && !isBareBackReference) {
    return ambiguousBusinessForScope(preferredScopeKind ?? "project", "A broad entity summary request likely refers to a scoped business report and needs semantic classification before execution.");
  }
  if (
    preferredScopeKind === "workspace" ||
    preferredScopeKind === "team" ||
    preferredScopeKind === "cycle" ||
    preferredScopeKind === "member" ||
    preferredScopeKind === "project"
  ) {
    if (hasVariant(normalized, REPORT_VARIANTS) || /\banalytics?\b/.test(normalized) || /\b(risk|healthy|health|progress|status|shape|performance|workload)\b/.test(normalized)) {
      return ambiguousBusiness("Business-intelligence request needs semantic classification before execution.");
    }
  }
  if (hasVariant(normalized, REPORT_VARIANTS) || /\banalytics?\b/.test(normalized) || /\b(risk|healthy|health|progress|status|shape|performance|workload)\b/.test(normalized)) {
    return ambiguousBusiness("A report or analytics request needs semantic classification before execution.");
  }
  return business("UNKNOWN", 0.35, "No strong semantic intent classification.");
}

function shouldUseModelPrimary(normalized: string) {
  if (!normalized) return false;
  if (classifyDeterministicObvious(normalized, normalized)) return false;
  return (
    hasAnyScopeWord(normalized) ||
    hasVariant(normalized, REPORT_VARIANTS) ||
    hasVariant(normalized, OVERLOAD_VARIANTS) ||
    looksLikeEntityBriefingRequest(normalized) ||
    /\b(compare|versus|vs|blocked|bottleneck|shape|risk|healthy)\b/.test(normalized)
  );
}

function sanitizeModelJson(value: string) {
  const trimmed = value.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  return jsonStart >= 0 && jsonEnd > jsonStart ? trimmed.slice(jsonStart, jsonEnd + 1) : trimmed;
}

async function classifyBusinessIntentWithModel(message: string, normalized: string) {
  const scopeHint = inferPreferredScope(normalized);
  const result = await callAI([
    {
      role: "system",
      content: [
        "You classify Trussen AI user requests into one semantic intent.",
        "Only choose from this enum:",
        MODEL_INTENTS.join(", "),
        "Prefer semantic meaning, not exact wording.",
        "Project health/progress/risk/report all map to the closest project business intent.",
        "Return strict JSON only: {\"intent\":\"...\",\"confidence\":0.0-1.0,\"reason\":\"...\",\"preferredScopeKind\":\"workspace|project|team|member|cycle|null\"}",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        message,
        normalized,
        scopeHint: scopeHint ?? null,
      }),
    },
  ], {
    model: MODEL_CLASSIFIER,
    taskType: "chat_response",
    maxTokens: 180,
    temperature: 0.1,
  });

  const parsed = JSON.parse(sanitizeModelJson(result.content)) as {
    intent?: string;
    confidence?: number;
    reason?: string;
    preferredScopeKind?: string | null;
  };

  if (!parsed.intent || !MODEL_INTENTS.includes(parsed.intent as AiIntent)) {
    return null;
  }

  const intent = parsed.intent as AiIntent;
  const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.72;
  const preferredScopeKind = parsed.preferredScopeKind === "workspace" || parsed.preferredScopeKind === "project" || parsed.preferredScopeKind === "team" || parsed.preferredScopeKind === "member" || parsed.preferredScopeKind === "cycle"
    ? parsed.preferredScopeKind
    : undefined;

  return capability(intent, confidence, parsed.reason?.trim() || "Model-primary semantic classification.", "model", {
    overlappingBusinessIntent: BUSINESS_INTENTS.has(intent),
    ...(preferredScopeKind ? { preferredScopeKind } : {}),
  });
}

export function classifyAiIntent(message: string): IntentClassification {
  const normalized = normalizeInput(message);
  const obvious = classifyDeterministicObvious(normalized, message);
  if (obvious) return obvious;
  return classifyDeterministicBusiness(normalized);
}

export async function classifyAiIntentHybrid(message: string, options: HybridClassifierOptions = {}): Promise<IntentClassification> {
  const normalized = normalizeInput(message);
  const obvious = classifyDeterministicObvious(normalized, message);
  if (obvious) {
    return obvious;
  }

  const deterministic = classifyDeterministicBusiness(normalized);
  const allowModel = options.allowModel !== false;
  if (!allowModel || !shouldUseModelPrimary(normalized)) {
    return deterministic;
  }

  try {
    const classified = options.modelClassifier
      ? await options.modelClassifier(message, normalized)
      : await classifyBusinessIntentWithModel(message, normalized);

    if (!classified?.intent) {
      throw new Error("Model classifier returned no usable intent.");
    }

    const finalResult = capability(
      classified.intent as AiIntent,
      typeof classified.confidence === "number" ? classified.confidence : deterministic.confidence,
      typeof classified.reason === "string" ? classified.reason : deterministic.reason,
      "model",
      {
        overlappingBusinessIntent: BUSINESS_INTENTS.has(classified.intent as AiIntent),
        ...(classified.preferredScopeKind ? { preferredScopeKind: classified.preferredScopeKind } : {}),
        ...(deterministic.capabilityCandidates?.length ? { capabilityCandidates: deterministic.capabilityCandidates } : {}),
      },
    );

    if (options.workspaceId) {
      logAiInfo("intent_classifier_model_used", {
        workspaceId: options.workspaceId,
        userId: options.userId,
        conversationId: options.conversationId,
        feature: "chat",
        success: true,
        metadata: {
          message,
          normalized,
          classifiedIntent: finalResult.intent,
          confidence: finalResult.confidence,
          fallbackIntent: deterministic.intent,
        },
      });
      void incrementAiMetricCounter({
        workspaceId: options.workspaceId,
        feature: "chat",
        metric: "intent_model_primary",
        dimensions: {
          classifiedIntent: finalResult.intent,
          fallbackIntent: deterministic.intent,
        },
      });
    }

    return finalResult;
  } catch (error) {
    if (options.workspaceId) {
      logAiWarn("intent_classifier_fallback", {
        workspaceId: options.workspaceId,
        userId: options.userId,
        conversationId: options.conversationId,
        feature: "chat",
        success: false,
        errorMessage: error instanceof Error ? error.message : "Intent classifier fallback",
        metadata: {
          message,
          normalized,
          deterministicIntent: deterministic.intent,
        },
      });
      void incrementAiMetricCounter({
        workspaceId: options.workspaceId,
        feature: "chat",
        metric: "intent_fallback",
        dimensions: {
          deterministicIntent: deterministic.intent,
        },
      });
    }

    return {
      ...deterministic,
      source: "fallback",
    };
  }
}
