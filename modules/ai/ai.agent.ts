/**
 * Trussen AI Agent Runtime — Phase 20K
 *
 * Replaces the keyword-router + slot-filling architecture with a single
 * model-first tool-calling loop.
 *
 * Why: the previous design classified intent with ~21 hardcoded regex rules and
 * resolved missing details with a hand-written state machine. Both only handled
 * phrasings someone had thought of in advance, which is why unlisted wording
 * failed, corrections mid-conversation were ignored, and the same request could
 * behave differently on different attempts. Rasa — who originated the intent+slot
 * pattern — replaced it in their own product for the same reasons.
 *
 * Design rules this file enforces:
 *   - Single-threaded loop. No sub-agents, no handoffs; the model sees the whole
 *     trace, which is what lets it revise an earlier wrong guess.
 *   - The model decides which tools to call. Code decides what is *allowed*
 *     (see ai.boundary.ts and the per-call authorization in the tool executor).
 *   - Clarification is a tool, not a state machine. Models reliably recognize
 *     ambiguity but rarely volunteer a question, so asking has to be an action
 *     they can select.
 *   - Every step is interruptible. The loop checks the abort signal between
 *     phases and passes it into the provider call.
 */

import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import {
  assertWithinBlastRadius,
  delimitUntrustedContent,
  MAX_BULK_MUTATION_TARGETS,
} from "./ai.boundary.js";
import { logAiInfo, logAiWarn } from "./ai.observability.js";
import { isOutOfScopeError } from "./tools/registry/scope.js";
import { AiCallAbortedError, callAIWithTools, type AiToolRuntimeMessage } from "./ai.tool-runtime.js";
import { recordAiMutation } from "./ai.mutations.js";
import type { ToolDefinition } from "./tools/tool-definitions.js";

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * Iteration ceiling per turn. High enough for genuine multi-step work
 * (resolve an entity, read it, act on it, confirm), low enough that a
 * pathological loop terminates in bounded time and cost.
 */
export const MAX_AGENT_ITERATIONS = 10;

/** Tool calls per turn, across all iterations. */
export const MAX_TOOL_CALLS_PER_TURN = 12;

/** Combined input+output tokens per turn before the loop stops taking new steps. */
export const MAX_TOKENS_PER_TURN = 40_000;

/** Tool result payload cap before truncation, in characters. */
const MAX_TOOL_RESULT_LENGTH = 6_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentToolContext {
  workspaceId: string;
  userId: string;
  userRole: string;
  conversationId?: string | undefined;
}

export interface AgentToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  success: boolean;
  error?: string | undefined;
  /** Set when the call produced a reviewable workspace change. */
  mutationId?: string | undefined;
}

export type AgentEvent =
  | { type: "tool_call"; data: { id: string; tool: string; args: Record<string, unknown> } }
  | { type: "tool_result"; data: { id: string; tool: string; success: boolean; error?: string | undefined } }
  | { type: "mutation"; data: { mutationId: string; targetLabel: string; summary: string } }
  | { type: "message"; data: { content: string; model: string; tokensUsed: number } }
  | { type: "interrupted"; data: { reason: string; completedToolCalls: number } };

export interface AgentTurnResult {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider cache — the gap between raw and billed usage. */
  cachedInputTokens: number;
  /** Provider-reported cost for the whole turn, when available. */
  costUsd: number | null;
  /** Number of provider round-trips. The dominant cost driver, since tools re-send each time. */
  modelCalls: number;
  toolCalls: AgentToolCallRecord[];
  mutationIds: string[];
  interrupted: boolean;
  stopReason: "completed" | "interrupted" | "iteration_limit" | "tool_limit" | "token_limit";
}

/**
 * Executes one tool call. Supplied by the caller so this runtime stays decoupled
 * from the executor implementation — which is also what makes it testable
 * without a database.
 */
export type AgentToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: AgentToolContext,
) => Promise<AgentToolExecutionResult>;

export interface AgentToolExecutionResult {
  success: boolean;
  payload: unknown;
  error?: string | undefined;
  meta?: Record<string, unknown> | undefined;
  /** Present when the call changed workspace state and should be reviewable. */
  mutation?:
    | {
        kind: "CREATE" | "UPDATE";
        targetType: string;
        targetId: string;
        targetLabel: string;
        summary: string;
        beforeState?: Record<string, unknown> | undefined;
        afterState?: Record<string, unknown> | undefined;
      }
    | undefined;
}

/** Provider call. Injected so the loop can be tested without network access. */
export type AgentModelCaller = (
  messages: AiToolRuntimeMessage[],
  model: string,
  tools: ToolDefinition[],
  options: { signal?: AbortSignal | undefined },
) => Promise<{
  content: string | null;
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number | undefined;
    costUsd?: number | null | undefined;
  };
}>;

/** Mutation recorder. Injected for the same reason. Returns the record id, or null if recording failed. */
export type AgentMutationRecorder = (input: {
  workspaceId: string;
  userId: string;
  conversationId?: string | undefined;
  toolName: string;
  kind: "CREATE" | "UPDATE";
  targetType: string;
  targetId: string;
  targetLabel: string;
  summary: string;
  beforeState?: Record<string, unknown> | undefined;
  afterState?: Record<string, unknown> | undefined;
}) => Promise<string | null>;

export interface RunAgentTurnInput {
  messages: AiToolRuntimeMessage[];
  tools: ToolDefinition[];
  models: string[];
  ctx: AgentToolContext;
  executeTool: AgentToolExecutor;
  signal?: AbortSignal | undefined;
  maxIterations?: number | undefined;
  maxToolCalls?: number | undefined;
  /** Defaults to the real OpenRouter call. */
  callModel?: AgentModelCaller | undefined;
  /** Defaults to persisting an AiMutationRecord. */
  recordMutation?: AgentMutationRecorder | undefined;
  /**
   * Supplies the complete toolset when a scoped-out tool is requested. Scoping
   * trades tokens for a small chance of under-provisioning; this makes that
   * trade safe by turning a miss into one extra round-trip instead of a wrong
   * "that isn't possible" answer.
   */
  expandToolset?: (() => ToolDefinition[]) | undefined;
}

// ─── Runtime ────────────────────────────────────────────────────────────────

/**
 * Runs one conversational turn to completion, yielding events as it goes.
 *
 * Streams rather than returns-then-renders because perceived latency dominates
 * actual latency for agentic work: showing which tool is running turns a long
 * silence into visible progress.
 */
export async function* runAgentTurn(
  input: RunAgentTurnInput,
): AsyncGenerator<AgentEvent, AgentTurnResult> {
  const messages = [...input.messages];
  const maxIterations = input.maxIterations ?? MAX_AGENT_ITERATIONS;
  const maxToolCalls = input.maxToolCalls ?? MAX_TOOL_CALLS_PER_TURN;
  const callModel = input.callModel ?? callAIWithTools;
  const recordMutation = input.recordMutation ?? recordAiMutation;

  let activeTools = input.tools;
  let toolsExpanded = false;

  const toolCalls: AgentToolCallRecord[] = [];
  const mutationIds: string[] = [];

  let currentModel = input.models[0] ?? "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let costUsd: number | null = null;
  let modelCalls = 0;
  let finalContent = "";
  let stopReason: AgentTurnResult["stopReason"] = "completed";

  const accrueUsage = (usage: Awaited<ReturnType<AgentModelCaller>>["usage"]) => {
    modelCalls += 1;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cachedInputTokens += usage.cachedInputTokens ?? 0;
    if (typeof usage.costUsd === "number") costUsd = (costUsd ?? 0) + usage.costUsd;
  };

  const buildResult = (): AgentTurnResult => ({
    content: finalContent,
    model: currentModel,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    costUsd,
    modelCalls,
    toolCalls,
    mutationIds,
    interrupted: stopReason === "interrupted",
    stopReason,
  });

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (input.signal?.aborted) {
      stopReason = "interrupted";
      yield { type: "interrupted", data: { reason: "user_stopped", completedToolCalls: toolCalls.length } };
      return buildResult();
    }

    let response: Awaited<ReturnType<AgentModelCaller>>;
    try {
      const call = await callModelWithFallback({
        messages,
        tools: activeTools,
        models: input.models,
        ...(input.signal ? { signal: input.signal } : {}),
        ctx: input.ctx,
        callModel,
      });
      response = call.result;
      currentModel = call.model;
    } catch (error) {
      if (error instanceof AiCallAbortedError) {
        stopReason = "interrupted";
        yield { type: "interrupted", data: { reason: "user_stopped", completedToolCalls: toolCalls.length } };
        return buildResult();
      }
      throw error;
    }

    accrueUsage(response.usage);

    const requestedCalls = response.toolCalls ?? [];

    // No tool calls means the model is answering — the turn is done.
    if (requestedCalls.length === 0) {
      finalContent = response.content?.trim() ?? "";
      stopReason = "completed";
      if (finalContent) {
        yield {
          type: "message",
          data: { content: finalContent, model: currentModel, tokensUsed: inputTokens + outputTokens },
        };
      }
      return buildResult();
    }

    // Record the model's tool-call turn so the next iteration sees its own decision.
    messages.push({ role: "assistant", content: response.content ?? "", tool_calls: requestedCalls });

    for (const call of requestedCalls) {
      if (input.signal?.aborted) {
        stopReason = "interrupted";
        yield { type: "interrupted", data: { reason: "user_stopped", completedToolCalls: toolCalls.length } };
        return buildResult();
      }

      if (toolCalls.length >= maxToolCalls) {
        stopReason = "tool_limit";
        break;
      }

      const args = parseToolArgs(call.function.arguments);
      yield { type: "tool_call", data: { id: call.id, tool: call.function.name, args } };

      let execution = await runSingleTool({
        toolName: call.function.name,
        args,
        ctx: input.ctx,
        executeTool: input.executeTool,
      });

      // The model asked for a real tool that scoping withheld. Load the full
      // set and let it try again on the next iteration, rather than reporting a
      // capability as unavailable when it exists.
      if (!execution.success && isOutOfScopeError(execution.error) && !toolsExpanded && input.expandToolset) {
        activeTools = input.expandToolset();
        toolsExpanded = true;

        logAiInfo("agent_toolset_expanded", {
          workspaceId: input.ctx.workspaceId,
          userId: input.ctx.userId,
          conversationId: input.ctx.conversationId,
          feature: "chat",
          toolName: call.function.name,
          success: true,
          metadata: { toolCount: activeTools.length },
        });

        execution = {
          success: false,
          payload: null,
          error: `${call.function.name} is now available. Call it again to continue.`,
        };
      }

      const record: AgentToolCallRecord = {
        id: call.id,
        name: call.function.name,
        args,
        success: execution.success,
        ...(execution.error ? { error: execution.error } : {}),
      };

      // Persist a reviewable record before telling the model it worked, so an
      // applied change is never left unreviewable.
      if (execution.success && execution.mutation) {
        const mutationId = await recordMutation({
          workspaceId: input.ctx.workspaceId,
          userId: input.ctx.userId,
          conversationId: input.ctx.conversationId,
          toolName: call.function.name,
          kind: execution.mutation.kind,
          targetType: execution.mutation.targetType,
          targetId: execution.mutation.targetId,
          targetLabel: execution.mutation.targetLabel,
          summary: execution.mutation.summary,
          beforeState: execution.mutation.beforeState,
          afterState: execution.mutation.afterState,
        });

        if (mutationId) {
          record.mutationId = mutationId;
          mutationIds.push(mutationId);
          yield {
            type: "mutation",
            data: {
              mutationId,
              targetLabel: execution.mutation.targetLabel,
              summary: execution.mutation.summary,
            },
          };
        }
      }

      toolCalls.push(record);

      yield {
        type: "tool_result",
        data: {
          id: call.id,
          tool: call.function.name,
          success: execution.success,
          ...(execution.error ? { error: execution.error } : {}),
        },
      };

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: serializeToolResult(call.function.name, execution),
      });
    }

    if (stopReason === "tool_limit") break;

    if (inputTokens + outputTokens >= MAX_TOKENS_PER_TURN) {
      stopReason = "token_limit";
      break;
    }

    if (iteration === maxIterations - 1) {
      stopReason = "iteration_limit";
    }
  }

  // Loop exhausted without the model producing prose. Ask it once more, with no
  // tools available, so the user gets a real answer grounded in what already ran
  // rather than a bare "I hit a limit".
  if (!finalContent) {
    const summary = await summarizeWithoutTools({
      messages,
      models: input.models,
      ...(input.signal ? { signal: input.signal } : {}),
      ctx: input.ctx,
      stopReason,
      callModel,
    }).catch(() => null);

    if (summary) {
      finalContent = summary.content;
      currentModel = summary.model;
      accrueUsage(summary.usage);
      yield {
        type: "message",
        data: { content: finalContent, model: currentModel, tokensUsed: inputTokens + outputTokens },
      };
    }
  }

  logAiInfo("agent_turn_finished", {
    workspaceId: input.ctx.workspaceId,
    userId: input.ctx.userId,
    conversationId: input.ctx.conversationId,
    feature: "chat",
    model: currentModel,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    success: true,
    toolCount: toolCalls.length,
    metadata: {
      stopReason,
      mutationCount: mutationIds.length,
      modelCalls,
      toolsOffered: activeTools.length,
      toolsExpanded,
      cachedInputTokens,
      // Share of prompt tokens served from cache. Low values here mean the
      // stable prefix is being invalidated and the tool schemas are being
      // re-billed in full on every round-trip.
      cacheHitRate: inputTokens > 0 ? Number((cachedInputTokens / inputTokens).toFixed(3)) : 0,
      costUsd,
    },
  });

  return buildResult();
}

// ─── Internals ──────────────────────────────────────────────────────────────

async function runSingleTool(input: {
  toolName: string;
  args: Record<string, unknown>;
  ctx: AgentToolContext;
  executeTool: AgentToolExecutor;
}): Promise<AgentToolExecutionResult> {
  try {
    enforceBlastRadius(input.toolName, input.args);
    return await input.executeTool(input.toolName, input.args, input.ctx);
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Tool execution failed";

    logAiWarn("agent_tool_failed", {
      workspaceId: input.ctx.workspaceId,
      userId: input.ctx.userId,
      conversationId: input.ctx.conversationId,
      feature: "chat",
      toolName: input.toolName,
      success: false,
      errorCode: error instanceof AppError ? error.code : ERROR_CODES.INTERNAL_ERROR,
      errorMessage: message,
    });

    // Failures are returned to the model, not thrown, so it can adapt — ask for
    // clarification, try a different approach, or explain the limit to the user.
    return { success: false, payload: null, error: message };
  }
}

/**
 * Applies the bulk-mutation cap to any array-valued argument that names targets.
 * Checked here rather than per-tool so a new tool cannot forget it.
 */
function enforceBlastRadius(toolName: string, args: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(args)) {
    if (!Array.isArray(value)) continue;
    if (!/id|ids|refs|targets|items/i.test(key)) continue;
    assertWithinBlastRadius(toolName, value.length);
  }
}

async function callModelWithFallback(input: {
  messages: AiToolRuntimeMessage[];
  tools: ToolDefinition[];
  models: string[];
  signal?: AbortSignal | undefined;
  ctx: AgentToolContext;
  callModel: AgentModelCaller;
}) {
  let lastError: unknown = null;

  for (const model of input.models) {
    try {
      const result = await input.callModel(input.messages, model, input.tools, {
        ...(input.signal ? { signal: input.signal } : {}),
      });

      // A null/null response means the provider rate-limited us; try the next model.
      if (result.content === null && result.toolCalls === null) {
        logAiWarn("agent_model_unavailable", {
          workspaceId: input.ctx.workspaceId,
          userId: input.ctx.userId,
          conversationId: input.ctx.conversationId,
          feature: "chat",
          model,
          success: false,
          errorCode: ERROR_CODES.AI_RATE_LIMITED,
        });
        continue;
      }

      return { result, model };
    } catch (error) {
      // A user-initiated stop must not be retried against the next model.
      if (error instanceof AiCallAbortedError) throw error;
      lastError = error;
    }
  }

  throw lastError instanceof AppError
    ? lastError
    : new AppError(502, ERROR_CODES.AI_PROVIDER_ERROR, "No AI model was available to handle this request.");
}

async function summarizeWithoutTools(input: {
  messages: AiToolRuntimeMessage[];
  models: string[];
  signal?: AbortSignal | undefined;
  ctx: AgentToolContext;
  stopReason: AgentTurnResult["stopReason"];
  callModel: AgentModelCaller;
}) {
  const guidance =
    input.stopReason === "tool_limit" || input.stopReason === "iteration_limit"
      ? "You have gathered as much as you can this turn. Answer with what you already know, and say plainly what is still unresolved."
      : "Answer using only what the tool results above already contain.";

  const { result, model } = await callModelWithFallback({
    messages: [...input.messages, { role: "system", content: guidance }],
    tools: [],
    models: input.models,
    ...(input.signal ? { signal: input.signal } : {}),
    ctx: input.ctx,
    callModel: input.callModel,
  });

  return { content: result.content?.trim() ?? "", model, usage: result.usage };
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Serializes a tool result for the model. Workspace-derived content is wrapped
 * in untrusted-data markers so an injection payload sitting in an issue title
 * or comment cannot be read as an instruction.
 */
function serializeToolResult(toolName: string, execution: AgentToolExecutionResult): string {
  const body: Record<string, unknown> = {
    tool: toolName,
    success: execution.success,
  };

  if (execution.error) body.error = execution.error;
  if (execution.payload !== undefined && execution.payload !== null) body.data = execution.payload;
  if (execution.meta) body.meta = execution.meta;

  let serialized = JSON.stringify(body);
  if (serialized.length > MAX_TOOL_RESULT_LENGTH) {
    serialized = `${serialized.slice(0, MAX_TOOL_RESULT_LENGTH)}…","truncated":true}`;
  }

  return execution.success ? delimitUntrustedContent(serialized) : serialized;
}

export const AGENT_LIMITS = {
  maxIterations: MAX_AGENT_ITERATIONS,
  maxToolCalls: MAX_TOOL_CALLS_PER_TURN,
  maxTokensPerTurn: MAX_TOKENS_PER_TURN,
  maxBulkTargets: MAX_BULK_MUTATION_TARGETS,
} as const;
