/**
 * Shared executor adapter for the consolidated registry (Phase 20K).
 *
 * All registry handlers reach the existing executor through here, so context
 * translation and the "never throw at the model" contract live in one place.
 */

import { executeTool as executeLegacyTool } from "../tool-executor.js";
import type { AgentToolExecutionResult } from "../../ai.agent.js";
import type { RegistryContext } from "./types.js";

export function legacyCtx(ctx: RegistryContext) {
  return {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    userRole: ctx.userRole,
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    ...(ctx.confirmedHighImpact !== undefined ? { confirmedHighImpact: ctx.confirmedHighImpact } : {}),
    ...(ctx.approvedHighImpactToolName ? { approvedHighImpactToolName: ctx.approvedHighImpactToolName } : {}),
    ...(ctx.approvedHighImpactArgsHash ? { approvedHighImpactArgsHash: ctx.approvedHighImpactArgsHash } : {}),
  };
}

export async function callLegacy(
  name: string,
  args: Record<string, unknown>,
  ctx: RegistryContext,
): Promise<AgentToolExecutionResult> {
  const result = await executeLegacyTool(name, args, legacyCtx(ctx));
  return {
    success: result.success,
    payload: result.payload,
    ...(result.error ? { error: result.error } : {}),
    ...(result.meta ? { meta: result.meta } : {}),
  };
}

/**
 * Thin passthrough for tools whose consolidated form is a rename plus optional
 * argument mapping. Keeps the per-domain files declarative.
 */
export function passthrough(legacyName: string, mapArgs?: (args: Record<string, unknown>) => Record<string, unknown>) {
  return async (args: Record<string, unknown>, ctx: RegistryContext): Promise<AgentToolExecutionResult> => {
    const mapped = mapArgs ? mapArgs(args) : args;
    return callLegacy(legacyName, mapped, ctx);
  };
}
