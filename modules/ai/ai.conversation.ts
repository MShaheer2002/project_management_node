/**
 * Trussen AI Conversation Service — Phase 20K
 *
 * Replaces the keyword-router chat pipeline with the model-first agent runtime.
 * This module owns everything around a turn — conversation records, prompt
 * assembly, persistence, usage accounting — and delegates the turn itself to
 * `runAgentTurn`.
 *
 * Prompt assembly is ordered most-stable to most-volatile on purpose. Providers
 * cache on an exact prefix and render `tools → system → messages`, so anything
 * that varies per user or per second must come *after* the invariant part or no
 * prefix is ever shared. That is also why the tool list is not filtered by role:
 * a per-user tool list sits at position 0 and would defeat caching entirely.
 * Authorization is enforced per call inside the executor instead.
 */

import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import { prisma } from "../../shared/utils/prisma.js";
import { assertAiAccess } from "./ai.access.js";
import { runAgentTurn, type AgentEvent } from "./ai.agent.js";
import { checkDestructiveIntent, UNTRUSTED_CONTENT_POLICY } from "./ai.boundary.js";
import { attachMutationsToMessage } from "./ai.mutations.js";
import { logAiError, logAiInfo } from "./ai.observability.js";
import { CHAT_MODEL_DEFAULT, fallbackChainForPrimary } from "./ai.provider.js";
import type { AiToolRuntimeMessage } from "./ai.tool-runtime.js";
import { recordAiDailyUsage } from "./ai.usage.js";
import {
  createRegistryExecutor,
  getToolDefinitionsForSurface,
  getToolsForSurface,
  selectToolsForTurn,
  type AgentSurface,
} from "./tools/registry/index.js";

const MAX_HISTORY_MESSAGES = 30;
const MAX_MESSAGE_LENGTH = 5_000;

export interface ConversationTurnInput {
  conversationId?: string | undefined;
  message: string;
  userId: string;
  workspaceId: string;
  userRole: string;
  surface?: AgentSurface | undefined;
  signal?: AbortSignal | undefined;
}

export type ConversationEvent =
  | AgentEvent
  | { type: "conversation"; data: { conversationId: string; isNew: boolean } }
  | { type: "done"; data: { conversationId: string; tokensUsed: number; model: string; stopReason: string } };

/**
 * Runs one conversational turn, yielding SSE-shaped events.
 *
 * Partial work is persisted even when the turn is interrupted, so a stopped
 * request leaves an honest record of what actually ran rather than vanishing.
 */
export async function* processConversationTurn(
  input: ConversationTurnInput,
): AsyncGenerator<ConversationEvent> {
  const surface = input.surface ?? "panel";
  const sanitized = sanitizeUserMessage(input.message);

  if (!sanitized) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "Message cannot be empty");
  }

  const access = await assertAiAccess({
    workspaceId: input.workspaceId,
    userId: input.userId,
    feature: "chat",
    estimatedTokens: estimateTokens(sanitized) + 4_000,
  });

  const { conversationId, isNew } = await resolveConversation(input);
  yield { type: "conversation", data: { conversationId, isNew } };

  await prisma.aiMessage.create({
    data: { conversationId, role: "USER", content: sanitized },
  });

  // Deletion is refused before any model call: it costs nothing, and it stops the
  // model improvising a "close enough" substitute mutation.
  const refusal = checkDestructiveIntent(sanitized);
  if (refusal) {
    await persistAssistantMessage({ conversationId, content: refusal.message, tokenCount: 0 });
    logAiInfo("chat_refused_destructive", {
      workspaceId: input.workspaceId,
      userId: input.userId,
      conversationId,
      feature: "chat",
      success: true,
      metadata: { reason: refusal.reason },
    });

    yield { type: "message", data: { content: refusal.message, model: "deterministic", tokensUsed: 0 } };
    yield { type: "done", data: { conversationId, tokensUsed: 0, model: "deterministic", stopReason: "refused" } };
    return;
  }

  const history = await loadHistory(conversationId, input.userId);
  const messages = await buildMessages({
    workspaceId: input.workspaceId,
    userId: input.userId,
    userRole: input.userRole,
    history,
    currentMessage: sanitized,
  });

  // Scope the toolset to what this conversation is about. Tool schemas are re-sent
  // on every round-trip and dominate token cost, so this is the highest-leverage
  // reduction available. Detection reads recent turns as well as the current
  // message, so a bare follow-up still resolves the established domain.
  const scope = selectToolsForTurn(
    getToolsForSurface(surface),
    [...history.slice(-6).map((message) => message.content), sanitized].join("\n"),
  );
  const offeredToolNames = new Set(scope.tools.map((tool) => tool.name));

  const startedAt = Date.now();
  const turn = runAgentTurn({
    messages,
    tools: scope.definitions,
    models: fallbackChainForPrimary(CHAT_MODEL_DEFAULT),
    ctx: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      userRole: input.userRole,
      conversationId,
    },
    executeTool: createRegistryExecutor(surface, offeredToolNames),
    // Escape hatch: if the model needs something scoping withheld, hand over
    // everything rather than claiming the capability does not exist.
    ...(scope.isFullToolset
      ? {}
      : {
          expandToolset: () => {
            for (const tool of getToolsForSurface(surface)) offeredToolNames.add(tool.name);
            return getToolDefinitionsForSurface(surface);
          },
        }),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  let step = await turn.next();
  while (!step.done) {
    yield step.value;
    step = await turn.next();
  }

  const result = step.value;

  // An interrupted turn still gets a message, so the transcript shows the stop
  // rather than silently ending mid-thought.
  const content = result.interrupted
    ? result.content || "Stopped."
    : result.content || "I wasn't able to produce an answer for that.";

  const assistantMessage = await persistAssistantMessage({
    conversationId,
    content,
    tokenCount: result.inputTokens + result.outputTokens,
    ...(result.toolCalls.length > 0
      ? { toolCalls: result.toolCalls.map((call) => ({ id: call.id, name: call.name, args: call.args })) }
      : {}),
  });

  // Anchor reviewable changes to the message that produced them so the panel can
  // render accept/reject inline rather than in a detached list.
  if (result.mutationIds.length > 0) {
    await attachMutationsToMessage(result.mutationIds, assistantMessage.id);
  }

  await Promise.all([
    updateConversationStats({
      conversationId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model: result.model,
      ...(isNew ? { titleSource: sanitized } : {}),
    }),
    recordAiDailyUsage(prisma, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      feature: "chat",
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    }).catch(() => {
      // Usage accounting must never fail a completed turn.
    }),
  ]);

  logAiInfo("chat_turn_succeeded", {
    workspaceId: input.workspaceId,
    userId: input.userId,
    conversationId,
    feature: "chat",
    model: result.model,
    latencyMs: Date.now() - startedAt,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    totalTokens: result.inputTokens + result.outputTokens,
    success: true,
    toolCount: result.toolCalls.length,
    metadata: {
      surface,
      stopReason: result.stopReason,
      interrupted: result.interrupted,
      mutationCount: result.mutationIds.length,
      accessPlan: access.accessPlan,
      modelCalls: result.modelCalls,
      toolDomains: scope.domains,
      toolsOffered: scope.definitions.length,
      cachedInputTokens: result.cachedInputTokens,
      cacheHitRate:
        result.inputTokens > 0 ? Number((result.cachedInputTokens / result.inputTokens).toFixed(3)) : 0,
      costUsd: result.costUsd,
    },
  });

  yield {
    type: "done",
    data: {
      conversationId,
      tokensUsed: result.inputTokens + result.outputTokens,
      model: result.model,
      stopReason: result.stopReason,
    },
  };
}

// ─── Prompt assembly ────────────────────────────────────────────────────────

/**
 * Invariant across every user and workspace, so it forms a shared cacheable
 * prefix. Nothing dynamic belongs in here — no date, no user, no workspace name.
 */
const STABLE_SYSTEM_PROMPT = [
  "You are Trussen AI, the assistant inside the Trussen project management app.",
  "You work on behalf of the person talking to you, with exactly their permissions — never more.",
  "",
  "HOW TO WORK:",
  "- Use tools to get real data. Never guess at workspace contents, names, or numbers.",
  "- Chain tools when a request needs several steps. Do the work rather than describing what you would do.",
  "- Request every tool you need at once when they do not depend on each other. Each extra round-trip",
  "  re-sends the whole conversation, so batching independent calls is materially cheaper and faster.",
  "- Reuse what is already in this conversation. If an earlier tool result already answered part of the",
  "  request, do not re-fetch it.",
  "- Prefer looking something up over asking. Search first; ask only when a lookup genuinely cannot resolve it.",
  "- When you do need to ask, call ask_user_to_clarify with one specific question and concrete options.",
  "- Answer in the language the user wrote in. Tool arguments always stay in their canonical English form.",
  "- Be concise and direct. No emojis, no filler, no apologies.",
  "",
  "REPORTING RESULTS:",
  "- Name specific items — issue IDs and titles — not just counts. Do not make the user ask twice.",
  "- Refer to things by their human-readable name or ID. Never show raw UUIDs or internal user IDs.",
  "- After changing something, state exactly what changed.",
  "- If a result is empty, say what you checked, and suggest a different angle rather than a flat 'nothing found'.",
  "- If a tool fails, say what went wrong in plain terms and what the user can do instead.",
  "",
  "WHAT YOU CANNOT DO:",
  "- You cannot delete anything, ever. Not issues, projects, comments, members, or documents.",
  "- If asked to delete, say so plainly and offer a non-destructive alternative such as archiving,",
  "  completing, deactivating, unassigning, or removing access. Never quietly substitute one of those.",
  "- If the user lacks permission for something, explain the limit. Do not claim the feature does not exist.",
  "",
  UNTRUSTED_CONTENT_POLICY,
].join("\n");

async function buildMessages(input: {
  workspaceId: string;
  userId: string;
  userRole: string;
  history: Array<{ role: string; content: string }>;
  currentMessage: string;
}): Promise<AiToolRuntimeMessage[]> {
  const messages: AiToolRuntimeMessage[] = [{ role: "system", content: STABLE_SYSTEM_PROMPT }];

  // Volatile context goes after the stable prefix so it never invalidates it.
  messages.push({ role: "system", content: await buildSessionContext(input) });

  for (const message of input.history) {
    if (message.role === "USER") {
      messages.push({ role: "user", content: message.content });
    } else if (message.role === "ASSISTANT" && message.content.trim()) {
      messages.push({ role: "assistant", content: message.content });
    }
  }

  messages.push({ role: "user", content: input.currentMessage });
  return messages;
}

async function buildSessionContext(input: {
  workspaceId: string;
  userId: string;
  userRole: string;
}): Promise<string> {
  const [user, labels] = await Promise.all([
    prisma.user.findFirst({ where: { id: input.userId }, select: { name: true } }),
    prisma.label.findMany({
      where: { workspaceId: input.workspaceId },
      select: { name: true },
      orderBy: { name: "asc" },
      take: 50,
    }),
  ]);

  return [
    `Current user: ${user?.name ?? "Unknown"} (id: ${input.userId}, role: ${input.userRole}).`,
    describeRoleCapabilities(input.userRole),
    labels.length > 0 ? `Workspace labels: ${labels.map((label) => label.name).join(", ")}.` : "",
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * States the caller's limits explicitly. Without this the model, unable to see a
 * refused capability, tends to report the feature as missing rather than as
 * restricted — which reads to the user as the product being broken.
 */
function describeRoleCapabilities(userRole: string): string {
  switch (userRole) {
    case "OWNER":
    case "ADMIN":
      return "They can manage the workspace, its members, and see workspace-wide analytics.";
    case "MEMBER":
      return [
        "They can create and update work, but cannot manage workspace settings or members.",
        "They can see analytics only for themselves and for teams or projects they belong to —",
        "workspace-wide figures are restricted to admins and owners. If a tool refuses on those grounds,",
        "explain it is a permission limit, not a missing feature.",
      ].join(" ");
    case "GUEST":
      return "They have read-mostly access and can comment, but cannot create or change most things.";
    default:
      return "";
  }
}

// ─── Persistence ────────────────────────────────────────────────────────────

async function resolveConversation(input: ConversationTurnInput) {
  if (input.conversationId) {
    const existing = await prisma.aiConversation.findFirst({
      where: { id: input.conversationId, userId: input.userId, workspaceId: input.workspaceId },
      select: { id: true },
    });

    if (!existing) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND, "Conversation not found");
    }
    return { conversationId: existing.id, isNew: false };
  }

  const created = await prisma.aiConversation.create({
    data: {
      userId: input.userId,
      workspaceId: input.workspaceId,
      title: input.message.slice(0, 80) || "New conversation",
    },
    select: { id: true },
  });

  return { conversationId: created.id, isNew: true };
}

async function loadHistory(conversationId: string, userId: string) {
  const rows = await prisma.aiMessage.findMany({
    // Ownership re-checked here as well: this reads conversation content, and a
    // stale or forged id must not surface another user's transcript.
    where: { conversationId, conversation: { userId } },
    orderBy: { createdAt: "desc" },
    take: MAX_HISTORY_MESSAGES,
    select: { role: true, content: true },
  });

  // Drop the just-persisted current message; it is appended explicitly.
  return rows.reverse().slice(0, -1);
}

async function persistAssistantMessage(input: {
  conversationId: string;
  content: string;
  tokenCount: number;
  toolCalls?: unknown;
}) {
  return prisma.aiMessage.create({
    data: {
      conversationId: input.conversationId,
      role: "ASSISTANT",
      content: input.content,
      tokenCount: input.tokenCount,
      ...(input.toolCalls ? { toolCalls: JSON.parse(JSON.stringify(input.toolCalls)) } : {}),
    },
    select: { id: true },
  });
}

async function updateConversationStats(input: {
  conversationId: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  titleSource?: string | undefined;
}) {
  await prisma.aiConversation.update({
    where: { id: input.conversationId },
    data: {
      requestCount: { increment: 1 },
      totalInputTokens: { increment: input.inputTokens },
      totalOutputTokens: { increment: input.outputTokens },
      totalTokens: { increment: input.inputTokens + input.outputTokens },
      lastModelUsed: input.model,
      ...(input.titleSource ? { title: buildTitle(input.titleSource) } : {}),
    },
  }).catch((error: unknown) => {
    logAiError("chat_stats_update_failed", {
      conversationId: input.conversationId,
      feature: "chat",
      success: false,
      errorMessage: error instanceof Error ? error.message : "Failed to update conversation stats",
    });
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sanitizeUserMessage(message: string): string {
  return message
    .replace(/[ --]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

function buildTitle(source: string): string {
  const cleaned = source.replace(/\s+/g, " ").trim();
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}…` : cleaned || "New conversation";
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}
