/**
 * Trussen AI Chat Service — Phase 20B (Hardened)
 *
 * Handles multi-turn conversations with tool execution.
 *
 * SECURITY:
 *   - Conversation ownership verified on every operation
 *   - Tool execution checks user permissions + workspace isolation
 *   - Max 5 tool calls per turn, max 10K tokens per turn
 *   - All messages saved atomically (no orphans on failure)
 *   - Prompt injection defense via delimiters + system rules
 *   - Private team/project visibility enforced in tools
 *   - No delete operations exposed
 *   - Tool results sanitized before feeding back to AI
 */

import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { assertAiAccess } from "./ai.access.js";
import { callAI, CHAT_MODEL_DEFAULT, fallbackChainForPrimary } from "./ai.provider.js";
import { incrementAiMetricCounter, logAiError, logAiInfo, logAiWarn } from "./ai.observability.js";
import { callAIWithTools } from "./ai.tool-runtime.js";
import { recordAiDailyUsage } from "./ai.usage.js";
import { getToolDefinitions } from "./tools/tool-definitions.js";
import { buildHighImpactApprovalHash, executeTool } from "./tools/tool-executor.js";
import { parsePendingAiAction, resolveAiPreflight, type PendingAiAction } from "./ai.action-state.js";
import { classifyAiIntentHybrid } from "./ai.intent.js";
import { parseConversationMemory, rememberResolvedEntity, updateConversationMemoryFromPendingAction, updateConversationMemoryFromUserMessage, type ConversationMemory } from "./ai.memory.js";
import { buildExecutionPlan, getPendingPlanSteps, observeAndReplanExecution, shouldUseDeterministicPlanLoop, type ExecutionPlan, type ExecutionPlanContinuation, type ExecutionPlanObservation, type ExecutorResult } from "./ai.planner.js";

const MAX_TOOL_CALLS_PER_TURN = 5;
const MAX_RECENT_HISTORY_MESSAGES = 30;
const MAX_TOKENS_PER_TURN = 10000;
const MAX_TOOL_RESULT_LENGTH = 5000; // Truncate large tool results
const SUMMARY_TRIGGER_MESSAGE_COUNT = 36;
const SUMMARY_REFRESH_BATCH_SIZE = 12;
const SUMMARY_MAX_OUTPUT_TOKENS = 550;

// ─── Types ──────────────────────────────────────────────────────────────────

interface ChatInput {
  conversationId?: string | undefined;
  message: string;
  userId: string;
  workspaceId: string;
  userRole: string;
}

interface ChatEvent {
  type: "message" | "tool_call" | "tool_result" | "done" | "error";
  data: unknown;
}

type ToolRunAudit = {
  tool: string;
  success: boolean;
  confirmationRequired: boolean;
  replayed: boolean;
  error?: string;
};

const SUMMARY_MODEL = CHAT_MODEL_DEFAULT;

// ─── System Prompt ──────────────────────────────────────────────────────────

async function buildChatSystemPrompt(workspaceId: string, userId: string, userRole: string): Promise<string> {
  const [currentUser, labels] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId }, select: { name: true } }),
    prisma.label.findMany({ where: { workspaceId }, select: { name: true }, orderBy: { name: "asc" }, take: 50 }),
  ]);

  return [
    "You are Trussen AI — the intelligent assistant for the Trussen project management platform.",
    "You are a production-grade enterprise AI. Be professional, precise, and proactive.",
    "",
    "CORE BEHAVIOR:",
    "- Be concise and direct. No fluff, no filler, no apologies.",
    "- NEVER use emojis. This is an enterprise tool.",
    "- ALWAYS call tools to get real data. NEVER guess, assume, or make up information.",
    "- You CAN chain multiple tool calls in sequence. If the user asks something that needs 2-3 steps, do all of them.",
    "- When you create or update something, confirm exactly what you did with the issue ID and key details.",
    "- When displaying lists, use markdown tables with columns: ID | Title | Status | Priority | Assignee.",
    "- When something is optional and the user didn't specify it, use sensible defaults — don't ask unless truly ambiguous.",
    "",
    "HANDLING ANY REQUEST:",
    "- If the user's request maps to a tool, use it immediately. Don't explain what you're going to do — just do it.",
    "- If the request needs multiple tools (e.g., 'create a task and assign it'), chain them in sequence.",
    "- If a field is optional and not mentioned, skip it. Don't ask 'do you want to add a description?' — just proceed.",
    "- If the request is unclear, ask ONE focused clarifying question. Don't ask multiple questions at once.",
    "- If a tool call fails, explain the error briefly and suggest what the user can do.",
    "- If the user provides a link/URL, include it in the description.",
    "- If the user says 'due tomorrow', 'due in 3 days', 'due next week' — pass it to the dueDate field.",
    "- If the user mentions priority words like 'urgent', 'critical', 'low priority' — set the priority accordingly.",
    "",
    "RESOLUTION AND SAFETY:",
    "- Entity resolution is handled by deterministic workspace-scoped services before tool execution. Do not invent IDs or targets.",
    "- If system context provides a resolved tool call or resolved slots, trust that deterministic state over guessing from names.",
    "- If a name is still unresolved, ask one focused clarification question rather than guessing.",
    "",
    "STATUS VALUES (use lowercase kebab-case):",
    "- backlog, todo, in-progress, review, done",
    "- When user says 'start working on' or 'begin' → in-progress",
    "- When user says 'done', 'complete', 'finished' → done",
    "- When user says 'needs review', 'ready for review' → review",
    "",
    "WHAT YOU CANNOT DO (be honest about it):",
    "- You cannot delete anything (issues, projects, members, comments).",
    "- If the user asks to delete something, refuse only. Do not mark it done, unassign it, archive it, deactivate it, or perform any substitute mutation unless the user later asks for that exact non-delete action explicitly.",
    "- You cannot change workspace settings, billing, or user roles.",
    "- You cannot access external URLs, files, or services.",
    "- If asked to do something outside your tools, explain what you can do instead.",
    "",
    `CURRENT USER: ${currentUser?.name ?? "Unknown"} (ID: ${userId})`,
    "",
    labels.length > 0 ? `Available labels: ${JSON.stringify(labels.map((l) => l.name))}` : "",
    "",
    `Today: ${new Date().toISOString().slice(0, 10)}`,
  ].filter(Boolean).join("\n");
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function updateMemoryFromResolvedTool(memory: ConversationMemory, toolName: string, toolArgs: Record<string, unknown>) {
  let nextMemory = memory;

  const entityMappings: Array<{ key: string; entityType: "project" | "issue" | "team" | "department" | "member" | "cycle" }> = [
    { key: "projectId", entityType: "project" },
    { key: "issueId", entityType: "issue" },
    { key: "teamId", entityType: "team" },
    { key: "departmentId", entityType: "department" },
    { key: "userId", entityType: "member" },
    { key: "memberId", entityType: "member" },
    { key: "cycleId", entityType: "cycle" },
  ];

  for (const mapping of entityMappings) {
    const value = toolArgs[mapping.key];
    if (typeof value === "string" && value.trim().length > 0) {
      nextMemory = rememberResolvedEntity(nextMemory, {
        entityType: mapping.entityType,
        entityId: value,
        name: value,
      });
    }
  }

  return nextMemory;
}

function compactJson(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return truncate(value.replace(/\s+/g, " ").trim(), 280);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    const compacted = value.slice(0, 8).map((entry) => compactJson(entry, depth + 1));
    if (value.length > 8) {
      compacted.push({ truncated: value.length - 8 });
    }
    return compacted;
  }

  if (typeof value === "object") {
    if (depth >= 3) {
      return "[truncated object]";
    }

    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined && entry !== null && entry !== "")
      .slice(0, 12)
      .map(([key, entry]) => [key, compactJson(entry, depth + 1)] as const);

    const result = Object.fromEntries(entries);
    const totalKeys = Object.keys(value as Record<string, unknown>).length;
    if (totalKeys > 12) {
      (result as Record<string, unknown>).truncatedKeys = totalKeys - 12;
    }
    return result;
  }

  return String(value);
}

function shapeToolResult(toolName: string, result: ExecutorResult) {
  const safeMeta = result.meta
    ? Object.fromEntries(
        Object.entries(result.meta).filter(([key]) => key !== "artifact"),
      )
    : undefined;
  const compactData = compactJson(result.payload);
  const payload: Record<string, unknown> = {
    success: result.success,
    tool: toolName,
    payload: compactData,
  };

  if (result.error) {
    payload.error = truncate(result.error, 300);
  }

  if (safeMeta && Object.keys(safeMeta).length > 0) {
    payload.meta = compactJson(safeMeta);
  }

  const serialized = JSON.stringify(payload);
  if (serialized.length <= MAX_TOOL_RESULT_LENGTH) {
    return serialized;
  }

  return JSON.stringify({
    success: result.success,
    tool: toolName,
    payload: "Result too large — showing compact summary only",
    error: result.error ? truncate(result.error, 200) : undefined,
    meta: safeMeta && Object.keys(safeMeta).length > 0 ? compactJson(safeMeta) : undefined,
  });
}

function formatMessageForSummary(message: {
  role: string;
  content: string;
  toolCalls: unknown;
  toolResults: unknown;
}) {
  if (message.role === "USER" || message.role === "ASSISTANT") {
    return `${message.role}: ${truncate(message.content, 600)}`;
  }

  if (message.role === "TOOL_RESULT") {
    return `TOOL_RESULT: ${truncate(JSON.stringify(compactJson(message.toolResults)), 800)}`;
  }

  return `${message.role}: ${truncate(message.content, 400)}`;
}

async function buildSafeChatSystemPrompt(workspaceId: string, userId: string, userRole: string, preferredLanguage?: string) {
  try {
    const base = await buildChatSystemPrompt(workspaceId, userId, userRole);
    return preferredLanguage
      ? `${base}\nPreferred reply language: ${preferredLanguage}.`
      : base;
  } catch (error) {
    logAiWarn("chat_prompt_context_degraded", {
      workspaceId,
      userId,
      feature: "chat",
      success: false,
      errorMessage: error instanceof Error ? error.message : "Failed to build full chat context",
    });

    return [
      "You are Trussen AI — the workspace assistant for the Trussen project management platform.",
      "Be concise, professional, and direct.",
      "Use tools whenever the user asks for workspace data or mutations.",
      "If a tool fails, explain the failure briefly and continue when possible.",
      ...(preferredLanguage ? [`Prefer replying in: ${preferredLanguage}.`] : []),
      `Today: ${new Date().toISOString().slice(0, 10)}`,
    ].join("\n");
  }
}

function buildCompactConfirmationSystemPrompt(preferredLanguage?: string) {
  return [
    "You are Trussen AI — the workspace assistant for the Trussen project management platform.",
    "This turn is a confirmed high-impact action continuation.",
    "Be concise and deterministic.",
    "If the system context includes a confirmed tool call, execute exactly that tool once.",
    "Do not reinterpret the request, expand scope, or ask follow-up questions unless the tool fails.",
    "After execution, reply with a short confirmation of what changed.",
    ...(preferredLanguage ? [`Reply in ${preferredLanguage} when possible.`] : []),
    "You cannot delete anything.",
  ].join("\n");
}

async function refreshConversationSummary(input: {
  conversationId: string;
  workspaceId: string;
  userId: string;
  currentSummary: string | null;
  summaryMessageCount: number;
}) {
  const totalMessages = await prisma.aiMessage.count({
    where: { conversationId: input.conversationId },
  });

  if (totalMessages < SUMMARY_TRIGGER_MESSAGE_COUNT) {
    return {
      summary: input.currentSummary,
      summaryMessageCount: input.summaryMessageCount,
    };
  }

  const cutoff = totalMessages - MAX_RECENT_HISTORY_MESSAGES;
  const pendingMessageCount = cutoff - input.summaryMessageCount;

  if (pendingMessageCount <= 0) {
    return {
      summary: input.currentSummary,
      summaryMessageCount: input.summaryMessageCount,
    };
  }

  if (input.currentSummary && pendingMessageCount < SUMMARY_REFRESH_BATCH_SIZE) {
    return {
      summary: input.currentSummary,
      summaryMessageCount: input.summaryMessageCount,
    };
  }

  const messagesToSummarize = await prisma.aiMessage.findMany({
    where: { conversationId: input.conversationId },
    orderBy: { createdAt: "asc" },
    skip: input.summaryMessageCount,
    take: pendingMessageCount,
    select: {
      role: true,
      content: true,
      toolCalls: true,
      toolResults: true,
    },
  });

  if (messagesToSummarize.length === 0) {
    return {
      summary: input.currentSummary,
      summaryMessageCount: input.summaryMessageCount,
    };
  }

  const summaryPrompt = messagesToSummarize
    .map(formatMessageForSummary)
    .join("\n");

  try {
    const summaryResult = await callAI(
      [
        {
          role: "system",
          content: [
            "You maintain a rolling memory for a workspace AI assistant.",
            "Summarize the conversation accurately using these sections:",
            "Goals",
            "Decisions",
            "Named Entities",
            "Open Threads",
            "Constraints",
            "Keep IDs, owners, project names, dates, and unresolved tasks.",
            "Do not invent facts.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            input.currentSummary ? `Existing summary:\n${input.currentSummary}` : "Existing summary: none",
            "",
            "New messages to fold into memory:",
            summaryPrompt,
          ].join("\n"),
        },
      ],
      {
        model: SUMMARY_MODEL,
        taskType: "weekly_report",
        maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
        temperature: 0.2,
      },
    );

    await prisma.$transaction(async (tx) => {
      await tx.aiConversation.update({
        where: { id: input.conversationId },
        data: {
          summary: summaryResult.content,
          summaryMessageCount: input.summaryMessageCount + messagesToSummarize.length,
          summaryUpdatedAt: new Date(),
          totalInputTokens: { increment: summaryResult.usage.inputTokens },
          totalOutputTokens: { increment: summaryResult.usage.outputTokens },
          totalTokens: { increment: summaryResult.usage.totalTokens },
        },
      });

      await recordAiDailyUsage(tx, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        feature: "chat",
        inputTokens: summaryResult.usage.inputTokens,
        outputTokens: summaryResult.usage.outputTokens,
        requestCountIncrement: 0,
        chatTurnCountIncrement: 0,
      });
    });

    logAiInfo("chat_summary_refreshed", {
      workspaceId: input.workspaceId,
      userId: input.userId,
      conversationId: input.conversationId,
      feature: "chat",
      model: summaryResult.model,
      inputTokens: summaryResult.usage.inputTokens,
      outputTokens: summaryResult.usage.outputTokens,
      totalTokens: summaryResult.usage.totalTokens,
      success: true,
      metadata: {
        summarizedMessages: messagesToSummarize.length,
        summaryMessageCount: input.summaryMessageCount + messagesToSummarize.length,
      },
    });

    return {
      summary: summaryResult.content,
      summaryMessageCount: input.summaryMessageCount + messagesToSummarize.length,
    };
  } catch (error) {
    logAiWarn("chat_summary_refresh_failed", {
      workspaceId: input.workspaceId,
      userId: input.userId,
      conversationId: input.conversationId,
      feature: "chat",
      success: false,
      errorMessage: error instanceof Error ? error.message : "Conversation summary refresh failed",
    });

    return {
      summary: input.currentSummary,
      summaryMessageCount: input.summaryMessageCount,
    };
  }
}

async function persistConversationTurn(input: {
  conversationId: string;
  finalContent: string;
  isNewConversation: boolean;
  titleSource: string;
  currentModel: string;
  inputTokens: number;
  outputTokens: number;
  workspaceId: string;
  userId: string;
}) {
  const totalTokens = input.inputTokens + input.outputTokens;
  const titleText = input.titleSource
    .replace(/[@#]\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

  await prisma.$transaction(async (tx) => {
    await tx.aiMessage.create({
      data: {
        conversationId: input.conversationId,
        role: "ASSISTANT",
        content: input.finalContent,
        tokenCount: totalTokens,
      },
    });

    await tx.aiConversation.update({
      where: { id: input.conversationId },
      data: {
        updatedAt: new Date(),
        requestCount: { increment: 1 },
        totalInputTokens: { increment: input.inputTokens },
        totalOutputTokens: { increment: input.outputTokens },
        totalTokens: { increment: totalTokens },
        lastModelUsed: input.currentModel,
        ...(input.isNewConversation ? { title: titleText || "New conversation" } : {}),
      },
    });

    await recordAiDailyUsage(tx, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      feature: "chat",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
    });
  });
}

async function updateConversationState(conversationId: string, input: {
  pendingAction: PendingAiAction | null;
  memory: ConversationMemory;
}) {
  await prisma.aiConversation.update({
    where: { id: conversationId },
    data: {
      pendingAction: input.pendingAction ? JSON.parse(JSON.stringify(input.pendingAction)) : null,
      pendingActionUpdatedAt: input.pendingAction ? new Date() : null,
      memory: JSON.parse(JSON.stringify(input.memory)),
      memoryUpdatedAt: new Date(),
    },
  });
}

function buildToolConfirmationPendingAction(input: {
  message: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  explanation: string;
  completedTools: ToolRunAudit[];
}): PendingAiAction {
  const now = new Date().toISOString();
  return {
    action: "high_impact_action",
    status: "awaiting_confirmation",
    slots: {
      toolName: input.toolName,
      toolArgsJson: JSON.stringify(input.toolArgs),
      explanation: input.explanation,
      completedToolsJson: JSON.stringify(input.completedTools),
    },
    missing: [],
    prompt: input.message,
    createdAt: now,
    updatedAt: now,
    confirmationRequired: true,
  };
}

function buildConfirmationResponse(input: {
  explanation: string;
  completedTools: ToolRunAudit[];
}) {
  const completed = input.completedTools.filter((entry) => entry.success && !entry.confirmationRequired);
  const completedLine = completed.length > 0
    ? `Already completed in this request: ${completed.map((entry) => entry.tool).join(", ")}.`
    : "";

  return [
    input.explanation,
    completedLine,
    "Reply `Confirm` to proceed, or `Cancel` to stop.",
  ].filter(Boolean).join(" ");
}

function buildDeterministicToolCompletionResponse(input: {
  toolRuns: Array<{
    tool: string;
    success: boolean;
    error?: string | undefined;
    result: ExecutorResult;
  }>;
}) {
  if (input.toolRuns.length === 0) {
    return "The requested action finished, but no tool result was available to summarize.";
  }

  const lines = input.toolRuns.map(({ tool, success, error, result }) => {
    const data = result.payload && typeof result.payload === "object" ? (result.payload as Record<string, unknown>) : null;
    const meta = result.meta && typeof result.meta === "object" ? result.meta : null;
    const message =
      typeof meta?.report === "string" && meta.report.trim().length > 0
        ? meta.report.trim()
        : typeof data?.message === "string" && data.message.trim().length > 0
          ? data.message.trim()
          : typeof result.error === "string" && result.error.trim().length > 0
            ? result.error.trim()
            : error?.trim();

    if (success) {
      return message ? message : `Completed ${tool.replace(/_/g, " ")}.`;
    }

    return message ? `Could not complete ${tool.replace(/_/g, " ")}: ${message}` : `Could not complete ${tool.replace(/_/g, " ")}.`;
  });

  return lines.join("\n");
}

function shouldExecuteToolBatch(aiResponse: { toolCalls?: Array<unknown> | null }, toolCallCount: number) {
  return Boolean(aiResponse.toolCalls && aiResponse.toolCalls.length > 0 && toolCallCount < MAX_TOOL_CALLS_PER_TURN);
}

async function persistToolResultMessage(input: {
  conversationId: string;
  toolCallId: string;
  content: string;
}) {
  await prisma.aiMessage.create({
    data: {
      conversationId: input.conversationId,
      role: "TOOL_RESULT",
      content: "",
      toolResults: JSON.parse(JSON.stringify([{ tool_call_id: input.toolCallId, content: input.content }])),
    },
  });
}

async function executeResolvedToolTurn(input: {
  conversationId: string;
  isNewConversation: boolean;
  titleSource: string;
  userPrompt: string;
  workspaceId: string;
  userId: string;
  userRole: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  responseMode?: "overloaded";
}) {
  const syntheticToolCallId = `resolved_${Date.now()}`;

    await prisma.aiMessage.create({
      data: {
        conversationId: input.conversationId,
        role: "ASSISTANT",
        content: "",
        toolCalls: JSON.parse(JSON.stringify([
          {
            id: syntheticToolCallId,
          type: "function",
          function: {
            name: input.toolName,
            arguments: JSON.stringify(input.toolArgs),
          },
        },
      ])),
      tokenCount: 0,
    },
  });

  let result: Awaited<ReturnType<typeof executeTool>>;
  try {
    result = await executeTool(input.toolName, input.toolArgs, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      userRole: input.userRole,
      conversationId: input.conversationId,
      confirmedHighImpact: false,
    });
  } catch (error) {
    result = { success: false, payload: null, warnings: [], nextSuggestions: [], error: error instanceof Error ? error.message : "Tool failed" };
  }

  const resultContent = shapeToolResult(input.toolName, result);
  await persistToolResultMessage({
    conversationId: input.conversationId,
    toolCallId: syntheticToolCallId,
    content: resultContent,
  });

  const deterministicFallback = input.responseMode === "overloaded"
    ? buildOverloadedResponse(input.toolName, result)
    : buildDeterministicToolCompletionResponse({
        toolRuns: [{
          tool: input.toolName,
          success: result.success,
          ...(result.error ? { error: result.error } : {}),
          result,
        }],
      });

  const finalContent = await formatResolvedToolReply({
    userPrompt: input.userPrompt,
    toolName: input.toolName,
    result,
    deterministicFallback,
    ...(input.responseMode ? { responseMode: input.responseMode } : {}),
  });

  await persistConversationTurn({
    conversationId: input.conversationId,
    finalContent,
    isNewConversation: input.isNewConversation,
    titleSource: input.titleSource,
    currentModel: "deterministic",
    inputTokens: 0,
    outputTokens: 0,
    workspaceId: input.workspaceId,
    userId: input.userId,
  });

  return {
    finalContent,
    result,
  };
}

function buildDeterministicPlanCompletionResponse(observations: ExecutionPlanObservation[]) {
  return buildDeterministicToolCompletionResponse({
    toolRuns: observations.map((observation) => ({
      tool: observation.executor,
      success: observation.result.success,
      ...(observation.result.error ? { error: observation.result.error } : {}),
      result: observation.result,
    })),
  });
}

async function formatPlannedExecutionReply(input: {
  userPrompt: string;
  observations: ExecutionPlanObservation[];
  deterministicFallback: string;
}) {
  try {
    const response = await callAI(
      [
        {
          role: "system",
          content: [
            "You are Trussen AI.",
            "A bounded deterministic execution plan has already been executed.",
            "Summarize the grounded results naturally.",
            "Do not mention internal tool names, planning, orchestration, or execution loops.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `User request: ${input.userPrompt}`,
            `Deterministic summary: ${input.deterministicFallback}`,
            `Observed plan results: ${JSON.stringify(compactJson(input.observations.map((observation) => ({
              stepId: observation.stepId,
              executor: observation.executor,
              success: observation.result.success,
              payload: observation.result.payload,
              error: observation.result.error,
              meta: observation.result.meta,
            }))))}`,
          ].join("\n\n"),
        },
      ],
      {
        model: CHAT_MODEL_DEFAULT,
        taskType: "chat_response",
        maxTokens: 360,
        temperature: 0.2,
      },
    );

    return response.content?.trim() || input.deterministicFallback;
  } catch {
    return input.deterministicFallback;
  }
}

async function executeDeterministicPlanTurn(input: {
  conversationId: string;
  isNewConversation: boolean;
  titleSource: string;
  userPrompt: string;
  workspaceId: string;
  userId: string;
  userRole: string;
  plan: ExecutionPlan;
  memory: ConversationMemory;
  responseMode?: "overloaded";
}) {
  const observations: ExecutionPlanObservation[] = [];
  let plan = input.plan;
  const maxPlanPasses = 4;

  for (let iteration = 0; iteration < maxPlanPasses; iteration += 1) {
    const nextSteps = getPendingPlanSteps(plan, observations);
    if (nextSteps.length === 0) break;

    const step = nextSteps[0]!;
    const syntheticToolCallId = `${step.id}_${Date.now()}`;

    await prisma.aiMessage.create({
      data: {
        conversationId: input.conversationId,
        role: "ASSISTANT",
        content: "",
        toolCalls: JSON.parse(JSON.stringify([{
          id: syntheticToolCallId,
          type: "function",
          function: {
            name: step.executor,
            arguments: JSON.stringify(step.args),
          },
        }])),
        tokenCount: 0,
      },
    });

    let result: Awaited<ReturnType<typeof executeTool>>;
    try {
      result = await executeTool(step.executor, step.args, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        userRole: input.userRole,
        conversationId: input.conversationId,
        confirmedHighImpact: false,
      });
    } catch (error) {
      result = { success: false, payload: null, warnings: [], nextSuggestions: [], error: error instanceof Error ? error.message : "Tool failed" };
    }

    await persistToolResultMessage({
      conversationId: input.conversationId,
      toolCallId: syntheticToolCallId,
      content: shapeToolResult(step.executor, result),
    });

    observations.push({
      stepId: step.id,
      executor: step.executor,
      result,
    });

    if (result.warnings.length > 0) {
      logAiWarn("chat_executor_warning", {
        workspaceId: input.workspaceId,
        userId: input.userId,
        conversationId: input.conversationId,
        feature: "chat",
        toolName: step.executor,
        success: result.success,
        metadata: {
          stepId: step.id,
          warnings: result.warnings,
        },
      });
      void incrementAiMetricCounter({
        workspaceId: input.workspaceId,
        feature: "chat",
        metric: "executor_warning",
        dimensions: {
          toolName: step.executor,
        },
      });
    }

    logAiInfo("chat_plan_step_executed", {
      workspaceId: input.workspaceId,
      userId: input.userId,
      conversationId: input.conversationId,
      feature: "chat",
      toolName: step.executor,
      success: result.success,
      metadata: {
        stepId: step.id,
        iteration,
        intent: plan.intent,
      },
    });

    const observed = observeAndReplanExecution({
      plan,
      observations,
    });

    if (observed.continuation) {
      const pendingAction = buildPlanContinuationPendingAction(observed.continuation, input.userPrompt);
      await updateConversationState(input.conversationId, {
        pendingAction,
        memory: input.memory,
      });
      const finalContent = [
        observed.continuation.prompt,
        "Available options:",
        ...observed.continuation.candidates.map((candidate) => candidate.label),
      ].join("\n");
      await persistConversationTurn({
        conversationId: input.conversationId,
        finalContent,
        isNewConversation: input.isNewConversation,
        titleSource: input.titleSource,
        currentModel: "deterministic",
        inputTokens: 0,
        outputTokens: 0,
        workspaceId: input.workspaceId,
        userId: input.userId,
      });
      return {
        finalContent,
        observations,
      };
    }

    if (observed.replanned) {
      logAiInfo("chat_plan_replanned", {
        workspaceId: input.workspaceId,
        userId: input.userId,
        conversationId: input.conversationId,
        feature: "chat",
        success: true,
        metadata: {
          intent: plan.intent,
          iteration,
          completedSteps: observations.map((observation) => observation.stepId),
        },
      });
      void incrementAiMetricCounter({
        workspaceId: input.workspaceId,
        feature: "chat",
        metric: "replanning",
        dimensions: {
          intent: plan.intent,
        },
      });
    }

    plan = observed.plan;
    if (observed.shouldStop) break;
  }

  if (observations.length === 0) {
    return null;
  }

  const deterministicFallback =
    input.responseMode === "overloaded" && observations.length === 1
      ? buildOverloadedResponse(observations[0]!.executor, observations[0]!.result)
      : buildDeterministicPlanCompletionResponse(observations);
  const finalContent =
    observations.length === 1
      ? await formatResolvedToolReply({
          userPrompt: input.userPrompt,
          toolName: observations[0]!.executor,
          result: observations[0]!.result,
          deterministicFallback,
          ...(input.responseMode ? { responseMode: input.responseMode } : {}),
        })
      : await formatPlannedExecutionReply({
          userPrompt: input.userPrompt,
          observations,
          deterministicFallback,
        });

  await persistConversationTurn({
    conversationId: input.conversationId,
    finalContent,
    isNewConversation: input.isNewConversation,
    titleSource: input.titleSource,
    currentModel: "deterministic",
    inputTokens: 0,
    outputTokens: 0,
    workspaceId: input.workspaceId,
    userId: input.userId,
  });

  return {
    finalContent,
    observations,
  };
}

function buildPlanContinuationPendingAction(continuation: ExecutionPlanContinuation, prompt: string): PendingAiAction {
  return {
    action: "issue_action",
    intent: continuation.intent,
    status: "collecting_slots",
    slots: {
      ...continuation.slots,
      intent: continuation.intent,
    },
    missing: [continuation.field],
    ambiguity: [
      {
        field: continuation.field,
        candidates: continuation.candidates.map((candidate) => ({
          id: candidate.id,
          label: candidate.label,
        })),
      },
    ],
    prompt,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    riskLevel: continuation.intent === "ADD_COMMENT" ? "low" : "medium",
  };
}

async function formatResolvedToolReply(input: {
  userPrompt: string;
  toolName: string;
  responseMode?: "overloaded";
  result: ExecutorResult;
  deterministicFallback: string;
}) {
  try {
    const modeInstruction = input.responseMode === "overloaded"
      ? [
          "Decide who is actually overloaded from the workload data.",
          "Do not just restate raw rankings unless they support your conclusion.",
          "If nobody clearly appears overloaded, say that directly.",
          "Keep the answer concise but useful.",
        ].join("\n")
      : [
          "Answer the user's exact request using the tool result.",
          "Do not mention internal tool names, tool execution, or routing.",
          "Be concise, but answer naturally as Trussen AI.",
        ].join("\n");

    const response = await callAI(
      [
        {
          role: "system",
          content: [
            "You are Trussen AI.",
            "A backend tool has already been executed successfully or failed.",
            "Your job is only to answer the user's request from the tool result.",
            modeInstruction,
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `User request: ${input.userPrompt}`,
            `Tool result summary: ${input.deterministicFallback}`,
            `Tool result payload: ${JSON.stringify(compactJson({ payload: input.result.payload, error: input.result.error, meta: input.result.meta }))}`,
          ].join("\n\n"),
        },
      ],
      {
        model: CHAT_MODEL_DEFAULT,
        taskType: "chat_response",
        maxTokens: 320,
        temperature: input.responseMode === "overloaded" ? 0.2 : 0.3,
      },
    );

    return response.content?.trim() || input.deterministicFallback;
  } catch {
    return input.deterministicFallback;
  }
}

function buildOverloadedResponse(
  toolName: string,
  result: ExecutorResult,
) {
  if (!result.success) {
    return buildDeterministicToolCompletionResponse({
      toolRuns: [{ tool: toolName, success: false, ...(result.error ? { error: result.error } : {}), result }],
    });
  }

  const data = result.payload && typeof result.payload === "object" ? (result.payload as Record<string, any>) : {};
  const overloadedSummary = (rows: any[], emptyMessage: string, heading: string) => {
    const candidates = selectOverloadedRows(rows);
    if (candidates.length === 0) {
      return emptyMessage;
    }

    return `${heading} ${candidates
      .map((row: any) => `${row.name} (${row.open ?? 0} open, ${row.overdue ?? 0} overdue, ${row.assigned ?? 0} assigned)`)
      .join("; ")}.`;
  };

  if (toolName === "get_workspace_analytics") {
    const members = Array.isArray(data?.tables?.memberWorkload)
      ? data.tables.memberWorkload
      : Array.isArray(data?.tables?.topContributors)
        ? data.tables.topContributors
        : [];
    return overloadedSummary(members, "No one looks overloaded across the workspace right now.", "Most overloaded people in the workspace:");
  }

  if (toolName === "get_team_analytics") {
    const members = Array.isArray(data?.tables?.memberPerformance) ? data.tables.memberPerformance : [];
    return overloadedSummary(members, "No one on this team looks overloaded right now.", "Most overloaded team members:");
  }

  if (toolName === "get_project_analytics") {
    const members = Array.isArray(data?.tables?.memberWorkload) ? data.tables.memberWorkload : [];
    return overloadedSummary(members, "No one on this project looks overloaded right now.", "Most overloaded project members:");
  }

  if (toolName === "get_member_analytics") {
    const summary = data?.summary ?? {};
    return `${data?.member?.name ?? "This member"} has ${summary.assigned ?? 0} assigned, ${summary.inProgress ?? 0} in progress, and ${summary.overdue ?? 0} overdue.`;
  }

  return buildDeterministicToolCompletionResponse({
    toolRuns: [{ tool: toolName, success: true, result }],
  });
}

function selectOverloadedRows(rows: any[]) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const normalized = rows
    .map((row) => ({
      ...row,
      assigned: Number(row?.assigned ?? 0),
      open: Number(row?.open ?? 0),
      overdue: Number(row?.overdue ?? 0),
      completionRate: Number(row?.completionRate ?? 0),
    }))
    .filter((row) => row.assigned > 0 || row.open > 0 || row.overdue > 0);

  if (normalized.length === 0) return [];

  const scored = normalized.map((row) => ({
    ...row,
    loadScore: (row.overdue * 6) + (row.open * 2) + row.assigned + Math.max(0, Math.round((60 - row.completionRate) / 10)),
  }));

  const mean = scored.reduce((sum, row) => sum + row.loadScore, 0) / scored.length;
  const variance = scored.reduce((sum, row) => sum + ((row.loadScore - mean) ** 2), 0) / scored.length;
  const stddev = Math.sqrt(variance);
  const maxScore = Math.max(...scored.map((row) => row.loadScore));
  const dynamicThreshold = Math.max(10, mean + (stddev * 0.5), maxScore * 0.72);

  return scored
    .filter((row) =>
      row.loadScore >= dynamicThreshold &&
      (row.overdue >= 1 || row.open >= 5 || row.assigned >= 8),
    )
    .sort((a, b) => b.loadScore - a.loadScore)
    .slice(0, 3);
}

// ─── Main Chat Function ─────────────────────────────────────────────────────

export async function* processChat(input: ChatInput): AsyncGenerator<ChatEvent> {
  const { message, userId, workspaceId, userRole } = input;
  const startedAt = Date.now();

  // Sanitize message — strip control chars, HTML tags, limit length
  const sanitized = message
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/<[^>]+>/g, "")
    .slice(0, 5000);

  const access = await assertAiAccess({
    workspaceId,
    userId,
    feature: "chat",
    estimatedTokens: estimateTokens(sanitized) + 3000,
  });

  // Step 1: Get or create conversation (atomic)
  let conversationId = input.conversationId;
  let isNewConversation = false;
  let currentSummary: string | null = null;
  let summaryMessageCount = 0;
  let pendingAction: PendingAiAction | null = null;
  let conversationMemory: ConversationMemory = parseConversationMemory(null);

  if (conversationId) {
    // Verify ownership — user must own the conversation AND it must be in the same workspace
    const existing = await prisma.aiConversation.findFirst({
      where: { id: conversationId, userId, workspaceId },
      select: { id: true, summary: true, summaryMessageCount: true, pendingAction: true, memory: true },
    });
    if (!existing) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND, "Conversation not found");
    }
    currentSummary = existing.summary;
    summaryMessageCount = existing.summaryMessageCount;
    pendingAction = parsePendingAiAction(existing.pendingAction);
    conversationMemory = parseConversationMemory(existing.memory);
  } else {
    isNewConversation = true;
    const conv = await prisma.aiConversation.create({
      data: { userId, workspaceId, title: sanitized.slice(0, 80) || "New conversation" },
      select: { id: true, summary: true, summaryMessageCount: true, pendingAction: true, memory: true },
    });
    conversationId = conv.id;
    currentSummary = conv.summary;
    summaryMessageCount = conv.summaryMessageCount;
    pendingAction = parsePendingAiAction(conv.pendingAction);
    conversationMemory = parseConversationMemory(conv.memory);
  }

  const resolvedConversationId = conversationId;

  // Step 2: Save user message
  await prisma.aiMessage.create({
    data: { conversationId: resolvedConversationId, role: "USER", content: sanitized },
  });

  conversationMemory = updateConversationMemoryFromUserMessage(conversationMemory, sanitized);
  const preflight = await resolveAiPreflight({
    message: sanitized,
    pendingAction,
    conversationMemory,
    workspaceId,
    userId,
    userRole,
  });

  conversationMemory = updateConversationMemoryFromPendingAction(conversationMemory, preflight.pendingAction);
  await updateConversationState(resolvedConversationId, {
    pendingAction: preflight.pendingAction,
    memory: conversationMemory,
  });

  if (preflight.kind === "respond") {
    await persistConversationTurn({
      conversationId: resolvedConversationId,
      finalContent: preflight.content,
      isNewConversation,
      titleSource: sanitized,
      currentModel: "deterministic",
      inputTokens: 0,
      outputTokens: 0,
      workspaceId,
      userId,
    });

    logAiInfo("chat_preflight_responded", {
      workspaceId,
      userId,
      conversationId: resolvedConversationId,
      feature: "chat",
      model: "deterministic",
      latencyMs: Date.now() - startedAt,
      success: true,
      metadata: {
        pendingAction: preflight.pendingAction?.action ?? null,
        pendingStatus: preflight.pendingAction?.status ?? null,
      },
    });

    yield { type: "message", data: { content: preflight.content, model: "deterministic", tokensUsed: 0 } };
    yield { type: "done", data: { conversationId: resolvedConversationId, tokensUsed: 0, model: "deterministic" } };
    return;
  }

  const classifiedIntent = await classifyAiIntentHybrid(sanitized, {
    workspaceId,
    userId,
    conversationId: resolvedConversationId,
    allowModel: true,
  });

  if (preflight.resolvedToolName && preflight.resolvedToolArgsJson) {
    let resolvedToolArgs: Record<string, unknown>;
    try {
      resolvedToolArgs = JSON.parse(preflight.resolvedToolArgsJson) as Record<string, unknown>;
    } catch {
      const finalContent = "That resolved action payload is invalid now. Please send the request again.";
      await persistConversationTurn({
        conversationId: resolvedConversationId,
        finalContent,
        isNewConversation,
        titleSource: sanitized,
        currentModel: "deterministic",
        inputTokens: 0,
        outputTokens: 0,
        workspaceId,
        userId,
      });

      yield { type: "message", data: { content: finalContent, model: "deterministic", tokensUsed: 0 } };
      yield { type: "done", data: { conversationId: resolvedConversationId, tokensUsed: 0, model: "deterministic" } };
      return;
    }

    conversationMemory = updateMemoryFromResolvedTool(conversationMemory, preflight.resolvedToolName, resolvedToolArgs);
    await updateConversationState(resolvedConversationId, {
      pendingAction: null,
      memory: conversationMemory,
    });

    const resolvedPlan = (
      classifiedIntent.intent === "MY_TASKS" ||
      classifiedIntent.intent === "OVERDUE_TASKS" ||
      classifiedIntent.intent === "BLOCKED_TASKS" ||
      classifiedIntent.intent === "COMPARE_PROJECTS"
    )
      ? buildExecutionPlan({
          intent: classifiedIntent.intent,
          slots: resolvedToolArgs,
        })
      : {
          intent: classifiedIntent.intent,
          steps: [{
            id: `step:resolved:${preflight.resolvedToolName}`,
            capability: classifiedIntent.intent,
            executor: preflight.resolvedToolName,
            args: resolvedToolArgs,
            dependsOn: [],
          }],
          requiresUserInput: false,
          requiresConfirmation: false,
        };

    const planned = await executeDeterministicPlanTurn({
      conversationId: resolvedConversationId,
      isNewConversation,
      titleSource: sanitized,
      userPrompt: sanitized,
      workspaceId,
      userId,
      userRole,
      plan: resolvedPlan,
      memory: conversationMemory,
      ...(preflight.resolvedResponseMode ? { responseMode: preflight.resolvedResponseMode } : {}),
    });
    yield { type: "message", data: { content: planned?.finalContent ?? "I couldn't complete that request.", model: "deterministic", tokensUsed: 0 } };
    yield { type: "done", data: { conversationId: resolvedConversationId, tokensUsed: 0, model: "deterministic" } };
    return;
  }

  if (preflight.confirmedHighImpact === true && preflight.confirmedHighImpactToolName && preflight.confirmedHighImpactToolArgsJson) {
    const approvedToolName = preflight.confirmedHighImpactToolName;
    const validTools = new Set(getToolDefinitions().map((tool) => tool.function.name));

    if (!validTools.has(approvedToolName)) {
      const finalContent = "That confirmed action is no longer available. Please send the request again.";
      await persistConversationTurn({
        conversationId: resolvedConversationId,
        finalContent,
        isNewConversation,
        titleSource: sanitized,
        currentModel: "deterministic",
        inputTokens: 0,
        outputTokens: 0,
        workspaceId,
        userId,
      });

      yield { type: "message", data: { content: finalContent, model: "deterministic", tokensUsed: 0 } };
      yield { type: "done", data: { conversationId: resolvedConversationId, tokensUsed: 0, model: "deterministic" } };
      return;
    }

    let approvedToolArgs: Record<string, unknown>;
    try {
      approvedToolArgs = JSON.parse(preflight.confirmedHighImpactToolArgsJson) as Record<string, unknown>;
    } catch {
      const finalContent = "That confirmation payload is invalid now. Please send the request again.";
      await persistConversationTurn({
        conversationId: resolvedConversationId,
        finalContent,
        isNewConversation,
        titleSource: sanitized,
        currentModel: "deterministic",
        inputTokens: 0,
        outputTokens: 0,
        workspaceId,
        userId,
      });

      yield { type: "message", data: { content: finalContent, model: "deterministic", tokensUsed: 0 } };
      yield { type: "done", data: { conversationId: resolvedConversationId, tokensUsed: 0, model: "deterministic" } };
      return;
    }

    conversationMemory = updateMemoryFromResolvedTool(conversationMemory, approvedToolName, approvedToolArgs);
    await updateConversationState(resolvedConversationId, {
      pendingAction: null,
      memory: conversationMemory,
    });

    const approvalHash = buildHighImpactApprovalHash(approvedToolArgs);
    const syntheticToolCallId = `confirmed_${Date.now()}`;

    await prisma.aiMessage.create({
      data: {
        conversationId: resolvedConversationId,
        role: "ASSISTANT",
        content: "",
        toolCalls: JSON.parse(JSON.stringify([
          {
            id: syntheticToolCallId,
            type: "function",
            function: {
              name: approvedToolName,
              arguments: JSON.stringify(approvedToolArgs),
            },
          },
        ])),
        tokenCount: 0,
      },
    });

    yield { type: "tool_call", data: { tool: approvedToolName, args: approvedToolArgs } };

    const toolStartedAt = Date.now();
    let result: Awaited<ReturnType<typeof executeTool>>;
    try {
      result = await executeTool(approvedToolName, approvedToolArgs, {
        workspaceId,
        userId,
        userRole,
        conversationId: resolvedConversationId,
        confirmedHighImpact: true,
        approvedHighImpactToolName: approvedToolName,
        approvedHighImpactArgsHash: approvalHash,
      });
    } catch (error) {
      result = { success: false, payload: null, warnings: [], nextSuggestions: [], error: error instanceof Error ? error.message : "Tool failed" };
    }

    logAiInfo("chat_tool_executed", {
      workspaceId,
      userId,
      conversationId: resolvedConversationId,
      feature: "chat",
      toolName: approvedToolName,
      latencyMs: Date.now() - toolStartedAt,
      success: result.success,
      metadata: {
        args: compactJson(approvedToolArgs),
        replayed: Boolean(result.meta?.replayed),
        deterministicConfirmation: true,
        warningsCount: result.warnings.length,
      },
    });

    yield {
      type: "tool_result",
      data: {
        tool: approvedToolName,
        success: result.success,
        replayed: Boolean(result.meta?.replayed),
        ...(result.meta?.artifact ? { artifact: result.meta.artifact } : {}),
      },
    };

    const resultContent = shapeToolResult(approvedToolName, result);
    await persistToolResultMessage({
      conversationId: resolvedConversationId,
      toolCallId: syntheticToolCallId,
      content: resultContent,
    });

    const finalContent = buildDeterministicToolCompletionResponse({
      toolRuns: [{
        tool: approvedToolName,
        success: result.success,
        ...(result.error ? { error: result.error } : {}),
        result,
      }],
    });

    await persistConversationTurn({
      conversationId: resolvedConversationId,
      finalContent,
      isNewConversation,
      titleSource: sanitized,
      currentModel: "deterministic",
      inputTokens: 0,
      outputTokens: 0,
      workspaceId,
      userId,
    });

    yield { type: "message", data: { content: finalContent, model: "deterministic", tokensUsed: 0 } };
    yield { type: "done", data: { conversationId: resolvedConversationId, tokensUsed: 0, model: "deterministic" } };
    return;
  }

  const shouldUseCompactConfirmationMode = preflight.compactMode === "confirmation";
  const summaryState = shouldUseCompactConfirmationMode
    ? {
        summary: currentSummary,
        summaryMessageCount,
      }
    : await refreshConversationSummary({
        conversationId: resolvedConversationId,
        workspaceId,
        userId,
        currentSummary,
        summaryMessageCount,
      });

  // Step 3: Load conversation history (only messages for this conversation + user)
  const historyDesc = await prisma.aiMessage.findMany({
    where: { conversationId: resolvedConversationId, conversation: { userId } }, // Double-check ownership
    orderBy: { createdAt: "desc" },
    take: preflight.historyLimit ?? MAX_RECENT_HISTORY_MESSAGES,
    select: { role: true, content: true, toolCalls: true, toolResults: true },
  });
  const history = historyDesc.reverse();
  const executionPlan = buildExecutionPlan({
    intent: classifiedIntent.intent,
    ...(preflight.pendingAction ? { slots: preflight.pendingAction.slots } : {}),
    ...(preflight.pendingAction?.riskLevel ? { riskLevel: preflight.pendingAction.riskLevel } : {}),
  });

  logAiInfo("chat_orchestration_plan_built", {
    workspaceId,
    userId,
    conversationId: resolvedConversationId,
    feature: "chat",
    success: true,
    metadata: {
      intent: classifiedIntent.intent,
      confidence: classifiedIntent.confidence,
      source: classifiedIntent.source,
      reason: classifiedIntent.reason,
      expectedEntityTypes: classifiedIntent.expectedEntityTypes,
      plan: executionPlan,
    },
  });
  if (executionPlan.steps.length > 1) {
    void incrementAiMetricCounter({
      workspaceId,
      feature: "chat",
      metric: "multi_step_plan",
      dimensions: {
        intent: classifiedIntent.intent,
        stepCount: executionPlan.steps.length,
      },
    });
  }

  if (shouldUseDeterministicPlanLoop(executionPlan) && executionPlan.steps.length > 1) {
    if (preflight.pendingAction) {
      await updateConversationState(resolvedConversationId, {
        pendingAction: null,
        memory: conversationMemory,
      });
    }
    const planned = await executeDeterministicPlanTurn({
      conversationId: resolvedConversationId,
      isNewConversation,
      titleSource: sanitized,
      userPrompt: sanitized,
      workspaceId,
      userId,
      userRole,
      plan: executionPlan,
      memory: conversationMemory,
    });

    if (planned) {
      yield { type: "message", data: { content: planned.finalContent, model: "deterministic", tokensUsed: 0 } };
      yield { type: "done", data: { conversationId: resolvedConversationId, tokensUsed: 0, model: "deterministic" } };
      return;
    }
  }

  // Step 4: Build messages for AI
  const systemPrompt = shouldUseCompactConfirmationMode
    ? buildCompactConfirmationSystemPrompt(conversationMemory.language)
    : await buildSafeChatSystemPrompt(workspaceId, userId, userRole, conversationMemory.language);

  const aiMessages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }> = [
    { role: "system", content: systemPrompt },
  ];

  if (!shouldUseCompactConfirmationMode && summaryState.summary) {
    aiMessages.push({
      role: "system",
      content: `Conversation memory:\n${summaryState.summary}`,
    });
  }

  if (preflight.systemContext) {
    aiMessages.push({
      role: "system",
      content: preflight.systemContext,
    });
  }

  if (classifiedIntent.intent !== "UNKNOWN") {
    aiMessages.push({
      role: "system",
      content: [
        `Semantic intent: ${classifiedIntent.intent}`,
        `Intent confidence: ${classifiedIntent.confidence.toFixed(3)}`,
        `Intent reason: ${classifiedIntent.reason}`,
        `Execution plan: ${JSON.stringify(executionPlan)}`,
        "Stay within this plan and intent boundary unless the user explicitly changes the request.",
      ].join("\n"),
    });
  }

  for (const msg of history) {
    if (msg.role === "USER") {
      aiMessages.push({ role: "user", content: msg.content });
    } else if (msg.role === "ASSISTANT") {
      const entry: Record<string, unknown> = { role: "assistant", content: msg.content };
      if (msg.toolCalls) entry.tool_calls = msg.toolCalls;
      aiMessages.push(entry as typeof aiMessages[number]);
    } else if (msg.role === "TOOL_RESULT" && msg.toolResults) {
      const results = msg.toolResults as Array<{ tool_call_id: string; content: string }>;
      for (const r of results) {
        aiMessages.push({ role: "tool" as string, content: r.content, tool_call_id: r.tool_call_id });
      }
    }
  }

  // Step 5: Call AI with tool calling loop
  const modelsToTry = fallbackChainForPrimary(CHAT_MODEL_DEFAULT);
  let currentModel = CHAT_MODEL_DEFAULT;
  let totalTokens = 0;
  let turnInputTokens = 0;
  let turnOutputTokens = 0;
  let toolCallCount = 0;
  const toolExecutionAudit: ToolRunAudit[] = [];
  const executedToolRuns: Array<{
    tool: string;
    success: boolean;
    error?: string | undefined;
    result: ExecutorResult;
  }> = [];

  const callChatModel = async (
    messages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }>,
    candidates: string[],
  ) => {
    let lastError: unknown = null;

    for (const candidate of candidates) {
      const attemptStartedAt = Date.now();
      try {
        const result = await callAIWithTools(messages, candidate, getToolDefinitions());
        if (result.content === null && result.toolCalls === null) {
          logAiWarn("chat_model_unavailable", {
            workspaceId,
            userId,
            conversationId: resolvedConversationId,
            feature: "chat",
            model: candidate,
            latencyMs: Date.now() - attemptStartedAt,
            success: false,
            errorCode: ERROR_CODES.AI_RATE_LIMITED,
          });
          continue;
        }

        logAiInfo("chat_model_succeeded", {
          workspaceId,
          userId,
          conversationId: resolvedConversationId,
          feature: "chat",
          model: candidate,
          fallbackUsed: candidate !== CHAT_MODEL_DEFAULT,
          latencyMs: Date.now() - attemptStartedAt,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.inputTokens + result.usage.outputTokens,
          success: true,
          toolCount: result.toolCalls?.length ?? 0,
        });

        return { model: candidate, result };
      } catch (error) {
        lastError = error;
        logAiWarn("chat_model_failed", {
          workspaceId,
          userId,
          conversationId: resolvedConversationId,
          feature: "chat",
          model: candidate,
          fallbackUsed: candidate !== CHAT_MODEL_DEFAULT,
          latencyMs: Date.now() - attemptStartedAt,
          success: false,
          errorCode: error instanceof AppError ? error.code : ERROR_CODES.AI_PROVIDER_ERROR,
          errorMessage: error instanceof Error ? error.message : "Chat model attempt failed",
        });
      }
    }

    throw lastError ?? new AppError(502, ERROR_CODES.AI_PROVIDER_ERROR, "All AI models unavailable");
  };

  let aiResponse;
  try {
    const initial = await callChatModel(aiMessages, modelsToTry);
    currentModel = initial.model;
    aiResponse = initial.result;
    turnInputTokens += aiResponse.usage.inputTokens;
    turnOutputTokens += aiResponse.usage.outputTokens;
    totalTokens += aiResponse.usage.inputTokens + aiResponse.usage.outputTokens;
  } catch (error) {
    const fallbackContent = "Trussen AI is temporarily unavailable right now. Please retry in a moment.";
    await persistConversationTurn({
      conversationId: resolvedConversationId,
      finalContent: fallbackContent,
      isNewConversation,
      titleSource: sanitized,
      currentModel,
      inputTokens: turnInputTokens,
      outputTokens: turnOutputTokens,
      workspaceId,
      userId,
    });
    logAiError("chat_turn_failed", {
      workspaceId,
      userId,
      conversationId: resolvedConversationId,
      feature: "chat",
      model: currentModel,
      latencyMs: Date.now() - startedAt,
      success: false,
      errorCode: error instanceof AppError ? error.code : ERROR_CODES.AI_PROVIDER_ERROR,
      errorMessage: error instanceof Error ? error.message : "Initial chat model resolution failed",
      metadata: {
        accessPlan: access.accessPlan,
        enforcementMode: access.enforcementMode,
      },
    });
    yield { type: "message", data: { content: fallbackContent, model: currentModel, tokensUsed: totalTokens } };
    yield { type: "done", data: { conversationId: resolvedConversationId, tokensUsed: totalTokens } };
    return;
  }

  // Tool calling loop — with budget enforcement
  while (shouldExecuteToolBatch(aiResponse, toolCallCount)) {
    const toolCalls = aiResponse.toolCalls ?? [];

    // Save assistant message with tool calls
    await prisma.aiMessage.create({
      data: {
        conversationId: resolvedConversationId,
        role: "ASSISTANT",
        content: "",
        toolCalls: JSON.parse(JSON.stringify(toolCalls)),
        tokenCount: aiResponse.usage.inputTokens + aiResponse.usage.outputTokens,
      },
    });

    aiMessages.push({
      role: "assistant",
      content: "",
      tool_calls: toolCalls as unknown[],
    });

    const toolResults: Array<{ tool_call_id: string; content: string }> = [];

    for (const tc of toolCalls) {
      if (toolCallCount >= MAX_TOOL_CALLS_PER_TURN) break;
      toolCallCount++;

      const toolName = tc.function.name;

      // Validate tool name against whitelist
      const validTools = getToolDefinitions().map((t) => t.function.name);
      if (!validTools.includes(toolName)) {
        const errorResult = JSON.stringify({ success: false, error: `Unknown tool: ${toolName}` });
        toolResults.push({ tool_call_id: tc.id, content: errorResult });
        continue;
      }

      let toolArgs: Record<string, unknown> = {};
      try {
        toolArgs = JSON.parse(tc.function.arguments);
      } catch {
        toolArgs = {};
      }

      let approvedHighImpactToolName: string | undefined;
      let approvedHighImpactArgsHash: string | undefined;
      if (preflight.confirmedHighImpact === true && preflight.confirmedHighImpactToolName && preflight.confirmedHighImpactToolArgsJson) {
        try {
          const approvedArgs = JSON.parse(preflight.confirmedHighImpactToolArgsJson) as Record<string, unknown>;
          approvedHighImpactToolName = preflight.confirmedHighImpactToolName;
          approvedHighImpactArgsHash = buildHighImpactApprovalHash(approvedArgs);
        } catch {
          approvedHighImpactToolName = undefined;
          approvedHighImpactArgsHash = undefined;
        }
      }

      yield { type: "tool_call", data: { tool: toolName, args: toolArgs } };

      // Execute tool with error handling
      let result;
      const toolStartedAt = Date.now();
      try {
        result = await executeTool(toolName, toolArgs, {
          workspaceId,
          userId,
          userRole,
          conversationId: resolvedConversationId,
          confirmedHighImpact: preflight.confirmedHighImpact === true,
          ...(approvedHighImpactToolName ? { approvedHighImpactToolName } : {}),
          ...(approvedHighImpactArgsHash ? { approvedHighImpactArgsHash } : {}),
        });
      } catch (error) {
        result = { success: false, payload: null, warnings: [], nextSuggestions: [], error: error instanceof Error ? error.message : "Tool failed" };
      }

      logAiInfo("chat_tool_executed", {
        workspaceId,
        userId,
        conversationId: resolvedConversationId,
        feature: "chat",
        toolName,
        latencyMs: Date.now() - toolStartedAt,
        success: result.success,
        metadata: {
          args: compactJson(toolArgs),
          replayed: Boolean(result.meta?.replayed),
        },
      });

      yield {
        type: "tool_result",
        data: {
          tool: toolName,
          success: result.success,
          replayed: Boolean(result.meta?.replayed),
          ...(result.meta?.artifact ? { artifact: result.meta.artifact } : {}),
        },
      };

      toolExecutionAudit.push({
        tool: toolName,
        success: result.success,
        confirmationRequired: Boolean(result.meta?.confirmationRequired),
        replayed: Boolean(result.meta?.replayed),
        ...(result.error ? { error: result.error } : {}),
      });
      executedToolRuns.push({
        tool: toolName,
        success: result.success,
        ...(result.error ? { error: result.error } : {}),
        result,
      });

      const resultContent = shapeToolResult(toolName, result);

      toolResults.push({ tool_call_id: tc.id, content: resultContent });
      aiMessages.push({
        role: "tool" as string,
        content: resultContent,
        tool_call_id: tc.id,
      });

      if (result.meta?.confirmationRequired) {
        const explanation = result.error ?? "This action requires explicit confirmation first.";
        const pendingConfirmation = buildToolConfirmationPendingAction({
          message: sanitized,
          toolName,
          toolArgs,
          explanation,
          completedTools: toolExecutionAudit,
        });

        conversationMemory = updateConversationMemoryFromPendingAction(conversationMemory, pendingConfirmation);
        await updateConversationState(resolvedConversationId, {
          pendingAction: pendingConfirmation,
          memory: conversationMemory,
        });

        await prisma.aiMessage.create({
          data: {
            conversationId: resolvedConversationId,
            role: "TOOL_RESULT",
            content: "",
            toolResults: JSON.parse(JSON.stringify(toolResults)),
          },
        });

        const confirmationContent = buildConfirmationResponse({
          explanation,
          completedTools: toolExecutionAudit,
        });

        await persistConversationTurn({
          conversationId: resolvedConversationId,
          finalContent: confirmationContent,
          isNewConversation,
          titleSource: sanitized,
          currentModel,
          inputTokens: turnInputTokens,
          outputTokens: turnOutputTokens,
          workspaceId,
          userId,
        });

        yield { type: "message", data: { content: confirmationContent, model: "deterministic", tokensUsed: totalTokens } };
        yield { type: "done", data: { conversationId: resolvedConversationId, tokensUsed: totalTokens, model: "deterministic" } };
        return;
      }
    }

    // Save tool results
    await prisma.aiMessage.create({
      data: {
        conversationId: resolvedConversationId,
        role: "TOOL_RESULT",
        content: "",
        toolResults: JSON.parse(JSON.stringify(toolResults)),
      },
    });

    const hadSuccess = toolExecutionAudit.some((entry) => entry.success && !entry.confirmationRequired);
    const hadFailure = toolExecutionAudit.some((entry) => !entry.success && !entry.confirmationRequired);
    if (hadSuccess && hadFailure) {
      aiMessages.push({
        role: "system",
        content: [
          "Partial execution state:",
          `Succeeded tools: ${toolExecutionAudit.filter((entry) => entry.success && !entry.confirmationRequired).map((entry) => entry.tool).join(", ") || "none"}`,
          `Failed tools: ${toolExecutionAudit.filter((entry) => !entry.success && !entry.confirmationRequired).map((entry) => entry.tool).join(", ") || "none"}`,
          "Do not claim full completion.",
          "Do not imply rollback for successful actions.",
          "Explain exactly what succeeded and what still needs user attention.",
        ].join("\n"),
      });
    }

    // If the turn already exhausted the token budget, do not ask the model to format
    // a follow-up reply. Return a deterministic tool summary instead.
    if (totalTokens >= MAX_TOKENS_PER_TURN) {
      aiResponse = {
        content: buildDeterministicToolCompletionResponse({ toolRuns: executedToolRuns }),
        toolCalls: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      break;
    }

    // Call AI again with tool results
    try {
      const followUp = await callChatModel(aiMessages, [
        ...fallbackChainForPrimary(currentModel),
      ]);
      currentModel = followUp.model;
      aiResponse = followUp.result;
      turnInputTokens += aiResponse.usage.inputTokens;
      turnOutputTokens += aiResponse.usage.outputTokens;
      totalTokens += aiResponse.usage.inputTokens + aiResponse.usage.outputTokens;
    } catch (error) {
      // If follow-up AI call fails, return what we have
      const fallbackContent = buildDeterministicToolCompletionResponse({ toolRuns: executedToolRuns });
      await persistConversationTurn({
        conversationId: resolvedConversationId,
        finalContent: fallbackContent,
        isNewConversation,
        titleSource: sanitized,
        currentModel,
        inputTokens: turnInputTokens,
        outputTokens: turnOutputTokens,
        workspaceId,
        userId,
      });
      logAiError("chat_follow_up_failed", {
        workspaceId,
        userId,
        conversationId: resolvedConversationId,
        feature: "chat",
        model: currentModel,
        latencyMs: Date.now() - startedAt,
        inputTokens: turnInputTokens,
        outputTokens: turnOutputTokens,
        totalTokens,
        success: false,
        errorCode: error instanceof AppError ? error.code : ERROR_CODES.AI_PROVIDER_ERROR,
        errorMessage: error instanceof Error ? error.message : "AI follow-up failed",
      });
      yield { type: "message", data: { content: fallbackContent, model: currentModel, tokensUsed: totalTokens } };
      yield { type: "done", data: { conversationId: resolvedConversationId, tokensUsed: totalTokens } };
      return;
    }
  }

  // Budget exceeded warning
  if (totalTokens >= MAX_TOKENS_PER_TURN) {
    logAiWarn("chat_token_budget_exceeded", {
      workspaceId,
      userId,
      conversationId: resolvedConversationId,
      feature: "chat",
      model: currentModel,
      totalTokens,
      success: true,
    });
  }

  // Step 6: Save final assistant response
  const fallbackToolContent = executedToolRuns.length > 0
    ? buildDeterministicToolCompletionResponse({ toolRuns: executedToolRuns })
    : "I couldn't generate a response. Please try again.";
  const finalContent = aiResponse.content?.trim() ? aiResponse.content : fallbackToolContent;
  await persistConversationTurn({
    conversationId: resolvedConversationId,
    finalContent,
    isNewConversation,
    titleSource: sanitized,
    currentModel,
    inputTokens: turnInputTokens,
    outputTokens: turnOutputTokens,
    workspaceId,
    userId,
  });

  logAiInfo("chat_turn_succeeded", {
    workspaceId,
    userId,
    conversationId: resolvedConversationId,
    feature: "chat",
    model: currentModel,
    latencyMs: Date.now() - startedAt,
    inputTokens: turnInputTokens,
    outputTokens: turnOutputTokens,
    totalTokens,
    success: true,
    toolCount: toolCallCount,
    metadata: {
      isNewConversation,
      summaryMessagesFolded: summaryState.summaryMessageCount,
      effectiveAccess: access.effectiveAccess,
      accessPlan: access.accessPlan,
      enforcementMode: access.enforcementMode,
    },
  });

  yield { type: "message", data: { content: finalContent, model: currentModel, tokensUsed: totalTokens } };
  yield { type: "done", data: { conversationId: resolvedConversationId, tokensUsed: totalTokens, model: currentModel } };
}

// ─── Conversation Management ────────────────────────────────────────────────

export async function listConversations(userId: string, workspaceId: string) {
  return prisma.aiConversation.findMany({
    where: { userId, workspaceId },
    select: {
      id: true,
      title: true,
      requestCount: true,
      totalInputTokens: true,
      totalOutputTokens: true,
      totalTokens: true,
      lastModelUsed: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
}

export async function getConversationMessages(conversationId: string, userId: string, workspaceId: string) {
  // Verify ownership — user must own the conversation
  const conv = await prisma.aiConversation.findFirst({
    where: { id: conversationId, userId, workspaceId },
    select: { id: true },
  });
  if (!conv) throw new AppError(404, ERROR_CODES.NOT_FOUND, "Conversation not found");

  return prisma.aiMessage.findMany({
    where: { conversationId },
    select: {
      id: true,
      role: true,
      content: true,
      toolCalls: true,
      toolResults: true,
      tokenCount: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function deleteConversation(conversationId: string, userId: string, workspaceId: string) {
  // Verify ownership
  const conv = await prisma.aiConversation.findFirst({
    where: { id: conversationId, userId, workspaceId },
    select: { id: true },
  });
  if (!conv) throw new AppError(404, ERROR_CODES.NOT_FOUND, "Conversation not found");

  // Cascade delete — messages are deleted automatically via onDelete: Cascade
  await prisma.aiConversation.delete({ where: { id: conversationId } });
}
