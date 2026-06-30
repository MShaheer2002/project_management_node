import type {
  EntityResolutionRequest,
  EntityResolutionResult,
  ResolvedEntityType,
} from "./ai.entity-resolution.js";

const ENTITY_TYPES: ResolvedEntityType[] = ["project", "team", "department", "member", "cycle", "issue"];

export function parseEntityResolutionRequest(input: unknown): EntityResolutionRequest {
  if (!input || typeof input !== "object") {
    throw new Error("Entity resolution request must be an object.");
  }

  const record = input as Record<string, unknown>;
  const expectedEntityTypes = Array.isArray(record.expectedEntityTypes)
    ? record.expectedEntityTypes.filter((value): value is ResolvedEntityType => typeof value === "string" && ENTITY_TYPES.includes(value as ResolvedEntityType))
    : [];
  const entityType = typeof record.entityType === "string" && ENTITY_TYPES.includes(record.entityType as ResolvedEntityType)
    ? record.entityType as ResolvedEntityType
    : undefined;

  if (!entityType && expectedEntityTypes.length === 0) {
    throw new Error("Entity resolution request requires entityType or expectedEntityTypes.");
  }

  if (typeof record.workspaceId !== "string" || typeof record.userId !== "string" || typeof record.userRole !== "string" || typeof record.rawMessage !== "string") {
    throw new Error("Entity resolution request is missing required fields.");
  }

  return {
    workspaceId: record.workspaceId,
    userId: record.userId,
    userRole: record.userRole,
    rawMessage: record.rawMessage,
    ...(typeof record.mention === "string" ? { mention: record.mention } : {}),
    ...(entityType ? { entityType } : {}),
    ...(expectedEntityTypes.length > 0 ? { expectedEntityTypes } : {}),
    accessMode: record.accessMode === "mutation" ? "mutation" : "read",
    actionRisk: record.actionRisk === "high" || record.actionRisk === "medium" ? record.actionRisk : "low",
    ...(record.currentContext && typeof record.currentContext === "object"
      ? { currentContext: record.currentContext as EntityResolutionRequest["currentContext"] }
      : {}),
    ...(typeof record.enableEmbeddings === "boolean" ? { enableEmbeddings: record.enableEmbeddings } : {}),
  };
}

export function isEntityResolutionResult(value: unknown): value is EntityResolutionResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.status === "string" &&
    typeof record.entityType === "string" &&
    typeof record.reason === "string";
}
