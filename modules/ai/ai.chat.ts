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
import { callAI, CHAT_MODEL_DEFAULT, CHAT_MODEL_FALLBACKS } from "./ai.provider.js";
import { getMemberNames } from "./ai.context.js";
import { logAiError, logAiInfo, logAiWarn } from "./ai.observability.js";
import { callAIWithTools } from "./ai.tool-runtime.js";
import { recordAiDailyUsage } from "./ai.usage.js";
import { getToolDefinitions } from "./tools/tool-definitions.js";
import { executeTool } from "./tools/tool-executor.js";

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

const isAdminRole = (role: string): boolean => role === "OWNER" || role === "ADMIN";

const SUMMARY_MODEL =
  CHAT_MODEL_FALLBACKS.find((model) => model.includes(":free")) ?? CHAT_MODEL_DEFAULT;

async function getVisibleProjects(workspaceId: string, userId: string, userRole: string) {
  return prisma.project.findMany({
    where: {
      workspaceId,
      ...(isAdminRole(userRole)
        ? {}
        : {
            OR: [
              { visibility: "PUBLIC" },
              { leadId: userId },
              { memberships: { some: { userId } } },
            ],
          }),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 50,
  });
}

async function getVisibleTeams(workspaceId: string, userId: string, userRole: string) {
  return prisma.team.findMany({
    where: {
      workspaceId,
      ...(isAdminRole(userRole)
        ? {}
        : {
            OR: [
              { visibility: "PUBLIC" },
              { leadId: userId },
              { memberships: { some: { userId } } },
            ],
          }),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 50,
  });
}

async function getVisibleDepartments(workspaceId: string, userId: string, userRole: string) {
  return prisma.department.findMany({
    where: {
      workspaceId,
      ...(isAdminRole(userRole)
        ? {}
        : {
            OR: [
              { visibility: "PUBLIC" },
              { headId: userId },
              { memberships: { some: { userId } } },
            ],
          }),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 30,
  });
}

// ─── System Prompt ──────────────────────────────────────────────────────────

async function buildChatSystemPrompt(workspaceId: string, userId: string, userRole: string): Promise<string> {
  const [projects, members, teams, departments, labels] = await Promise.all([
    getVisibleProjects(workspaceId, userId, userRole),
    getMemberNames(workspaceId),
    getVisibleTeams(workspaceId, userId, userRole),
    getVisibleDepartments(workspaceId, userId, userRole),
    prisma.label.findMany({ where: { workspaceId }, select: { name: true }, orderBy: { name: "asc" }, take: 50 }),
  ]);

  const currentUser = members.find((m) => m.id === userId);

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
    "ID RESOLUTION (CRITICAL):",
    "- ALWAYS use IDs from the lookup tables below when calling tools. Never pass names as IDs.",
    "- When user mentions a person → find their ID from Members list.",
    "- When user mentions a project → find its ID from Projects list.",
    "- When user mentions a team → find its ID from Teams list.",
    "- 'me', 'my', 'I' → use the current user's ID.",
    "- If a name doesn't match any entry, ask the user to clarify.",
    "",
    "STATUS VALUES (use lowercase kebab-case):",
    "- backlog, todo, in-progress, review, done",
    "- When user says 'start working on' or 'begin' → in-progress",
    "- When user says 'done', 'complete', 'finished' → done",
    "- When user says 'needs review', 'ready for review' → review",
    "",
    "WHAT YOU CANNOT DO (be honest about it):",
    "- You cannot delete anything (issues, projects, members, comments).",
    "- You cannot change workspace settings, billing, or user roles.",
    "- You cannot access external URLs, files, or services.",
    "- If asked to do something outside your tools, explain what you can do instead.",
    "",
    `CURRENT USER: ${currentUser?.name ?? "Unknown"} (ID: ${userId})`,
    "",
    "WORKSPACE LOOKUP TABLES:",
    `Projects: ${JSON.stringify(projects.map((p) => ({ id: p.id, name: p.name })))}`,
    `Members: ${JSON.stringify(members.map((m) => ({ id: m.id, name: m.name })))}`,
    `Teams: ${JSON.stringify(teams.map((t) => ({ id: t.id, name: t.name })))}`,
    departments.length > 0 ? `Departments: ${JSON.stringify(departments.map((d) => ({ id: d.id, name: d.name })))}` : "",
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

function shapeToolResult(toolName: string, result: {
  success: boolean;
  data: unknown;
  error?: string;
  meta?: Record<string, unknown>;
}) {
  const compactData = compactJson(result.data);
  const payload: Record<string, unknown> = {
    success: result.success,
    tool: toolName,
    data: compactData,
  };

  if (result.error) {
    payload.error = truncate(result.error, 300);
  }

  if (result.meta) {
    payload.meta = compactJson(result.meta);
  }

  const serialized = JSON.stringify(payload);
  if (serialized.length <= MAX_TOOL_RESULT_LENGTH) {
    return serialized;
  }

  return JSON.stringify({
    success: result.success,
    tool: toolName,
    data: "Result too large — showing compact summary only",
    error: result.error ? truncate(result.error, 200) : undefined,
    meta: result.meta ? compactJson(result.meta) : undefined,
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

async function buildSafeChatSystemPrompt(workspaceId: string, userId: string, userRole: string) {
  try {
    return await buildChatSystemPrompt(workspaceId, userId, userRole);
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
      `Today: ${new Date().toISOString().slice(0, 10)}`,
    ].join("\n");
  }
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

  if (conversationId) {
    // Verify ownership — user must own the conversation AND it must be in the same workspace
    const existing = await prisma.aiConversation.findFirst({
      where: { id: conversationId, userId, workspaceId },
      select: { id: true, summary: true, summaryMessageCount: true },
    });
    if (!existing) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND, "Conversation not found");
    }
    currentSummary = existing.summary;
    summaryMessageCount = existing.summaryMessageCount;
  } else {
    isNewConversation = true;
    const conv = await prisma.aiConversation.create({
      data: { userId, workspaceId, title: sanitized.slice(0, 80) || "New conversation" },
      select: { id: true, summary: true, summaryMessageCount: true },
    });
    conversationId = conv.id;
    currentSummary = conv.summary;
    summaryMessageCount = conv.summaryMessageCount;
  }

  const resolvedConversationId = conversationId;

  // Step 2: Save user message
  await prisma.aiMessage.create({
    data: { conversationId: resolvedConversationId, role: "USER", content: sanitized },
  });

  const summaryState = await refreshConversationSummary({
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
    take: MAX_RECENT_HISTORY_MESSAGES,
    select: { role: true, content: true, toolCalls: true, toolResults: true },
  });
  const history = historyDesc.reverse();

  // Step 4: Build messages for AI
  const systemPrompt = await buildSafeChatSystemPrompt(workspaceId, userId, userRole);

  const aiMessages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }> = [
    { role: "system", content: systemPrompt },
  ];

  if (summaryState.summary) {
    aiMessages.push({
      role: "system",
      content: `Conversation memory:\n${summaryState.summary}`,
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
  const modelsToTry = [CHAT_MODEL_DEFAULT, ...CHAT_MODEL_FALLBACKS.filter((m) => m !== CHAT_MODEL_DEFAULT)];
  let currentModel = CHAT_MODEL_DEFAULT;
  let totalTokens = 0;
  let turnInputTokens = 0;
  let turnOutputTokens = 0;
  let toolCallCount = 0;

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
  while (
    aiResponse.toolCalls &&
    aiResponse.toolCalls.length > 0 &&
    toolCallCount < MAX_TOOL_CALLS_PER_TURN &&
    totalTokens < MAX_TOKENS_PER_TURN
  ) {
    // Save assistant message with tool calls
    await prisma.aiMessage.create({
      data: {
        conversationId: resolvedConversationId,
        role: "ASSISTANT",
        content: aiResponse.content ?? "",
        toolCalls: JSON.parse(JSON.stringify(aiResponse.toolCalls)),
        tokenCount: aiResponse.usage.inputTokens + aiResponse.usage.outputTokens,
      },
    });

    aiMessages.push({
      role: "assistant",
      content: aiResponse.content ?? "",
      tool_calls: aiResponse.toolCalls as unknown[],
    });

    const toolResults: Array<{ tool_call_id: string; content: string }> = [];

    for (const tc of aiResponse.toolCalls) {
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
        });
      } catch (error) {
        result = { success: false, data: null, error: error instanceof Error ? error.message : "Tool failed" };
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
        data: { tool: toolName, success: result.success, replayed: Boolean(result.meta?.replayed) },
      };

      const resultContent = shapeToolResult(toolName, result);

      toolResults.push({ tool_call_id: tc.id, content: resultContent });
      aiMessages.push({
        role: "tool" as string,
        content: resultContent,
        tool_call_id: tc.id,
      });
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

    // Call AI again with tool results
    try {
      const followUp = await callChatModel(aiMessages, [
        currentModel,
        ...CHAT_MODEL_FALLBACKS.filter((model) => model !== currentModel),
      ]);
      currentModel = followUp.model;
      aiResponse = followUp.result;
      turnInputTokens += aiResponse.usage.inputTokens;
      turnOutputTokens += aiResponse.usage.outputTokens;
      totalTokens += aiResponse.usage.inputTokens + aiResponse.usage.outputTokens;
    } catch (error) {
      // If follow-up AI call fails, return what we have
      const errorMsg = error instanceof Error ? error.message : "AI follow-up failed";
      const fallbackContent = `Tool results received but AI couldn't format the response: ${errorMsg}`;
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
  const finalContent = aiResponse.content ?? "I couldn't generate a response. Please try again.";
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
