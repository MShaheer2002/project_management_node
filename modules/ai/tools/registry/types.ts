/**
 * Consolidated Tool Registry — shared types (Phase 20K)
 *
 * The registry replaces ~107 endpoint-shaped tools with ~49 workflow-shaped
 * ones. Tool-selection accuracy degrades measurably as the candidate set grows,
 * and the old surface mirrored REST routes rather than things users ask for —
 * five separate analytics tools meant picking a scope was an unrecoverable fork
 * the model could not back out of, which is what produced the "Which team?"
 * loops.
 *
 * Each tool colocates its schema with its handler so the two cannot drift.
 * Handlers adapt onto the existing executor rather than reimplementing it: the
 * permission checks, idempotency guard and confirmation binding there are
 * already correct, and re-deriving them would be the exact mistake that caused
 * the service-layer bypass bugs.
 */

import type { AgentToolExecutionResult } from "../../ai.agent.js";
import type { ToolDefinition } from "../tool-definitions.js";

/** Execution context, mirroring the executor's ToolContext. */
export interface RegistryContext {
  workspaceId: string;
  userId: string;
  userRole: string;
  conversationId?: string | undefined;
  confirmedHighImpact?: boolean | undefined;
  approvedHighImpactToolName?: string | undefined;
  approvedHighImpactArgsHash?: string | undefined;
}

export type RegistryHandler = (
  args: Record<string, unknown>,
  ctx: RegistryContext,
) => Promise<AgentToolExecutionResult>;

export interface ConsolidatedTool {
  name: string;
  description: string;
  parameters: ToolDefinition["function"]["parameters"];
  handler: RegistryHandler;
  /** Domain grouping, used for per-surface allowlists and observability. */
  domain: ToolDomain;
  /** Read-only tools are safe for the assistance bubble and background AI. */
  readOnly: boolean;
}

export type ToolDomain =
  | "issues"
  | "projects"
  | "teams"
  | "departments"
  | "members"
  | "workspace"
  | "cycles"
  | "templates"
  | "documents"
  | "roadmap"
  | "analytics"
  | "notifications"
  | "integrations"
  | "meta";

// ─── Shared parameter fragments ─────────────────────────────────────────────

/**
 * Every canonical value is a hard enum rather than free text. Multilingual
 * tool-calling fails predominantly on parameter *values*, not comprehension —
 * models emit arguments in the user's language ("erledigt" for done). A schema
 * enum makes that decoding-impossible rather than something we validate after.
 */
export const ISSUE_PRIORITY_ENUM = ["low", "medium", "high", "urgent"] as const;
export const ISSUE_TYPE_ENUM = ["task", "bug", "issue"] as const;
export const RESPONSE_FORMAT_ENUM = ["concise", "detailed"] as const;

type ParamSchema = { type: string; description: string; enum?: string[] };

export const responseFormatParam: ParamSchema = {
  type: "string",
  description: "How much detail to return. Use concise unless the user asked for specifics.",
  enum: [...RESPONSE_FORMAT_ENUM],
};

export const limitParam: ParamSchema = {
  type: "number",
  description: "Maximum results to return (default 20, max 50).",
};

// ─── Result helpers ─────────────────────────────────────────────────────────

export function ok(payload: unknown, meta?: Record<string, unknown>): AgentToolExecutionResult {
  return { success: true, payload, ...(meta ? { meta } : {}) };
}

export function fail(error: string): AgentToolExecutionResult {
  return { success: false, payload: null, error };
}

/** Success plus a reviewable change, which surfaces accept/reject in the panel. */
export function okWithMutation(
  payload: unknown,
  mutation: NonNullable<AgentToolExecutionResult["mutation"]>,
  meta?: Record<string, unknown>,
): AgentToolExecutionResult {
  return { success: true, payload, mutation, ...(meta ? { meta } : {}) };
}

// ─── Argument coercion ──────────────────────────────────────────────────────
//
// Model-supplied arguments are untrusted in *shape* (not just content): a model
// may send a number where a string is expected, or omit an optional field
// entirely. These normalize without throwing, so a malformed argument produces a
// tool-level error the model can correct rather than a 500.

export function str(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

export function optionalStr(value: unknown): string | undefined {
  const result = str(value);
  return result.length > 0 ? result : undefined;
}

export function num(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function bool(value: unknown): boolean {
  return value === true || value === "true";
}

export function strArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => str(entry)).filter((entry) => entry.length > 0);
  }
  // Models sometimes serialize arrays as JSON strings when a schema is ambiguous.
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((entry) => str(entry)).filter(Boolean);
    } catch {
      // fall through
    }
  }
  const single = optionalStr(value);
  return single ? [single] : [];
}

/** Builds the OpenAI-format definition the provider actually receives. */
export function toDefinition(tool: ConsolidatedTool): ToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
