/**
 * Consolidated Tool Registry — assembly and per-surface views (Phase 20K)
 *
 * One registry, several surfaces. The side panel, assistance bubble, background
 * AI and MCP server all draw from this list and differ only in which tools they
 * are allowed to call — not in which agent runs them.
 *
 * The tool list handed to the model is deliberately NOT filtered by the caller's
 * role. Tool schemas render at the very start of the prompt, so a per-user tool
 * list would mean no prompt prefix is ever shared between users and nothing
 * caches. Authorization is enforced per call inside the executor instead, which
 * is where it belongs anyway — that check sees resolved arguments, a schema
 * filter does not. The model is told about the user's role in the system prompt
 * so it explains a limit rather than claiming a feature does not exist.
 */

import type { ToolDefinition } from "../tool-definitions.js";
import { issueTools } from "./issues.tools.js";
import { orgTools } from "./org.tools.js";
import { planningTools } from "./planning.tools.js";
import { TOOL_NOT_IN_SCOPE } from "./scope.js";
import { toDefinition, type ConsolidatedTool, type RegistryContext, type ToolDomain } from "./types.js";
import { workspaceTools } from "./workspace.tools.js";

export const CONSOLIDATED_TOOLS: ConsolidatedTool[] = [
  ...issueTools,
  ...orgTools,
  ...planningTools,
  ...workspaceTools,
];

const TOOL_BY_NAME = new Map(CONSOLIDATED_TOOLS.map((tool) => [tool.name, tool]));

// A duplicate name silently shadows a capability, and the failure only shows up
// as "the model can't do X anymore". Fail at import time instead.
if (TOOL_BY_NAME.size !== CONSOLIDATED_TOOLS.length) {
  const seen = new Set<string>();
  const duplicates = CONSOLIDATED_TOOLS.map((t) => t.name).filter((name) => !seen.add(name));
  throw new Error(`Duplicate tool names in registry: ${[...new Set(duplicates)].join(", ")}`);
}

export type AgentSurface = "panel" | "assistant" | "background" | "mcp";

/**
 * Per-surface capability boundaries. These are structural, not advisory: the
 * background AI has no write tools at all beyond proposing suggestions, so
 * "background AI never mutates silently" is guaranteed by what it can call
 * rather than by what its prompt says.
 */
const SURFACE_RULES: Record<AgentSurface, (tool: ConsolidatedTool) => boolean> = {
  panel: () => true,
  assistant: (tool) => tool.readOnly,
  background: (tool) => tool.readOnly,
  mcp: (tool) => tool.domain !== "meta" && tool.domain !== "integrations",
};

export function getToolsForSurface(surface: AgentSurface): ConsolidatedTool[] {
  return CONSOLIDATED_TOOLS.filter(SURFACE_RULES[surface]);
}

export function getToolDefinitionsForSurface(surface: AgentSurface): ToolDefinition[] {
  return getToolsForSurface(surface).map(toDefinition);
}

export function getConsolidatedTool(name: string): ConsolidatedTool | undefined {
  return TOOL_BY_NAME.get(name);
}

/**
 * Builds the executor the agent runtime calls. Unknown names are returned as a
 * tool-level failure rather than thrown, so a model hallucinating a tool gets a
 * correctable error instead of crashing the turn.
 *
 * `offeredTools` narrows the callable set to what was actually sent to the model
 * this turn (see selectToolsForTurn). That case is reported distinctly from a
 * genuinely unknown tool, because it is recoverable: the agent loop retries with
 * the full toolset rather than telling the user a capability does not exist.
 */
export function createRegistryExecutor(surface: AgentSurface, offeredTools?: Set<string>) {
  const permitted = new Set(getToolsForSurface(surface).map((tool) => tool.name));

  return async (toolName: string, args: Record<string, unknown>, ctx: RegistryContext) => {
    const tool = TOOL_BY_NAME.get(toolName);

    if (!tool || !permitted.has(toolName)) {
      return { success: false, payload: null, error: `Unknown or unavailable tool: ${toolName}` };
    }

    if (offeredTools && !offeredTools.has(toolName)) {
      return {
        success: false,
        payload: null,
        error: `${TOOL_NOT_IN_SCOPE}: ${toolName} was not loaded for this turn.`,
      };
    }

    return tool.handler(args, ctx);
  };
}

export function getRegistryStats() {
  const byDomain = new Map<ToolDomain, number>();
  for (const tool of CONSOLIDATED_TOOLS) {
    byDomain.set(tool.domain, (byDomain.get(tool.domain) ?? 0) + 1);
  }

  return {
    total: CONSOLIDATED_TOOLS.length,
    readOnly: CONSOLIDATED_TOOLS.filter((tool) => tool.readOnly).length,
    byDomain: Object.fromEntries(byDomain),
  };
}

export { selectToolsForTurn, isOutOfScopeError, TOOL_NOT_IN_SCOPE, type ToolScopeResult } from "./scope.js";
export type { ConsolidatedTool, RegistryContext, ToolDomain } from "./types.js";
