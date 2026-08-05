/**
 * Per-turn tool scoping (Phase 20K)
 *
 * Tool schemas are ~95% of input tokens, and 62% of that is JSON scaffolding
 * rather than prose — so trimming descriptions barely moves it. The only lever
 * that does is sending fewer schemas, and because the whole tool list is re-sent
 * on every round-trip, the saving multiplies by the number of model calls.
 *
 * The obvious danger is under-provisioning: if the model isn't offered a tool it
 * needs, it reports the capability as missing. Three things guard against that:
 *
 *   1. A core set is always present, covering the large majority of traffic.
 *   2. Detection reads the whole recent conversation, not just the latest
 *      message, so a bare follow-up ("do that for the backend team") still
 *      resolves the domain established earlier.
 *   3. A miss is recoverable, not fatal — `expandToFullToolset` lets the agent
 *      loop retry the turn with everything once a tool comes back unavailable.
 *
 * That last point is what makes this a cost optimization rather than a
 * correctness gamble: the worst case is one extra round-trip, not a wrong answer.
 */

import type { ToolDefinition } from "../tool-definitions.js";
import { toDefinition, type ConsolidatedTool, type ToolDomain } from "./types.js";

/**
 * Domains always offered, regardless of what the message looks like.
 *
 * `issues` and `meta` are the bulk of panel traffic, and dropping `meta` would
 * lose ask_user_to_clarify and push the model back toward guessing.
 *
 * `analytics` and `members` are here for a different reason: they are the two
 * domains most often reached by phrasing that names nothing detectable — "who is
 * drowning", "how are we doing", "who needs help", "add Sara to backend". Trying
 * to catch those with more keywords is the whack-a-mole this redesign exists to
 * escape, so they are simply always loaded. That costs ~600 tokens per call and
 * removes the largest class of scoping miss.
 */
const CORE_DOMAINS: ToolDomain[] = ["issues", "meta", "analytics", "members"];

/**
 * Signals for pulling in a domain. Generous by design: a false positive costs a
 * few hundred tokens, a false negative costs a failed request.
 */
const DOMAIN_SIGNALS: Array<{ domain: ToolDomain; pattern: RegExp }> = [
  { domain: "projects", pattern: /\bprojects?\b/i },
  { domain: "teams", pattern: /\bteams?\b/i },
  { domain: "departments", pattern: /\bdepartments?\b/i },
  {
    domain: "members",
    pattern: /\b(members?|people|users?|assign|unassign|invite|role|access|who)\b/i,
  },
  {
    domain: "workspace",
    pattern: /\b(workspace|invite|invitation|label|activity|recent|changed|permission|role)\b/i,
  },
  { domain: "cycles", pattern: /\b(cycles?|sprints?|iteration)\b/i },
  { domain: "templates", pattern: /\btemplates?\b/i },
  { domain: "documents", pattern: /\b(docs?|documents?|folders?|notes?)\b/i },
  { domain: "roadmap", pattern: /\b(roadmap|milestones?|timeline|schedule|depend)\b/i },
  {
    domain: "analytics",
    // Deliberately broad: performance questions rarely name a metric explicitly,
    // and this is the domain most often reached by indirect phrasing
    // ("who's drowning", "how are we doing", "is X on track").
    pattern:
      /\b(analytic|report|metric|performance|velocity|workload|overload|stress|burn|capacity|progress|health|trend|compare|export|stat|how (is|are|much|many)|on track)/i,
  },
  { domain: "notifications", pattern: /\b(notifications?|unread|inbox|alerts?)\b/i },
  { domain: "integrations", pattern: /\b(api keys?|integrations?|slack|github|discord|figma|connected)\b/i },
];

export interface ToolScopeResult {
  tools: ConsolidatedTool[];
  definitions: ToolDefinition[];
  domains: ToolDomain[];
  /** True when nothing was excluded, so callers can skip a pointless expansion retry. */
  isFullToolset: boolean;
}

/**
 * Picks the tools to offer for a turn, based on the conversation so far.
 *
 * `conversationText` should include recent turns, not just the current message —
 * scoping on the latest message alone breaks exactly the follow-ups this
 * redesign set out to fix.
 */
export function selectToolsForTurn(
  availableTools: ConsolidatedTool[],
  conversationText: string,
): ToolScopeResult {
  const detected = new Set<ToolDomain>(CORE_DOMAINS);

  for (const { domain, pattern } of DOMAIN_SIGNALS) {
    if (pattern.test(conversationText)) detected.add(domain);
  }

  const tools = availableTools.filter((tool) => detected.has(tool.domain));

  // If scoping kept nearly everything, the bookkeeping is not worth it — hand
  // back the full set so the loop never bothers with an expansion path.
  const isFullToolset = tools.length >= availableTools.length * 0.85;
  const finalTools = isFullToolset ? availableTools : tools;

  return {
    tools: finalTools,
    definitions: finalTools.map(toDefinition),
    domains: [...detected],
    isFullToolset,
  };
}

/** Marker the executor returns when a tool exists but was not offered this turn. */
export const TOOL_NOT_IN_SCOPE = "TOOL_NOT_IN_SCOPE";

export function isOutOfScopeError(error: string | undefined): boolean {
  return typeof error === "string" && error.includes(TOOL_NOT_IN_SCOPE);
}
