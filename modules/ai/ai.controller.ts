/**
 * AI Module — Controller
 *
 * HTTP handlers for AI endpoints.
 * Controllers are DUMB — parse request, call service, send response.
 */

import type { RequestHandler } from "express";
import * as aiService from "./ai.service.js";
import * as aiAssist from "./ai.assist.js";
import * as aiConversation from "./ai.conversation.js";
import * as aiMutations from "./ai.mutations.js";
import * as aiUsage from "./ai.usage.js";
import * as aiSuggestions from "./ai.suggestions.js";
import { sendSuccess } from "../../shared/utils/api-response.js";
import { listAvailableModels } from "./ai.provider.js";
import type {
  AcceptSuggestionInput,
  AiUsageQuery,
  AssistInput,
  ChatInput,
  ConversationParamsInput,
  DismissSuggestionInput,
  DraftSuggestionsInput,
  GenerateIssueInput,
  ListSuggestionsInput,
  RunSuggestionsInput,
  SuggestionParamsInput,
} from "./ai.schemas.js";

/**
 * POST /ai/generate-issue — Generate a structured issue from natural language
 *
 * Accepts a prompt, runs rule-based detection + AI generation,
 * returns pre-filled issue data for the frontend form.
 *
 * AI never writes to DB. The user reviews and submits via the normal issue creation flow.
 */
export const generateIssue: RequestHandler = async (req, res, next) => {
  try {
    const { prompt, resolvedAssigneeId, resolvedProjectId } = req.body as GenerateIssueInput;
    const workspaceId = req.workspace!.id;

    const result = await aiService.generateIssue(prompt, workspaceId, {
      userId: req.user!.id,
      resolvedAssigneeId,
      resolvedProjectId,
    });

    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const getDraftSuggestions: RequestHandler = async (req, res, next) => {
  try {
    const body = req.body as DraftSuggestionsInput;
    const workspaceId = req.workspace!.id;

    const result = await aiService.getDraftSuggestions(workspaceId, body, {
      userId: req.user!.id,
    });

    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /ai/models — List available AI models
 *
 * Returns the list of models admins can choose from in workspace settings.
 */
export const getModels: RequestHandler = async (_req, res, next) => {
  try {
    const models = listAvailableModels();
    sendSuccess(res, 200, models);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /ai/assist — Lightweight ephemeral assistant (20C)
 */
export const assist: RequestHandler = async (req, res, next) => {
  try {
    const body = req.body as AssistInput;
    const result = await aiAssist.assist({
      ...body,
      userId: req.user!.id,
      workspaceId: req.workspace!.id,
      userRole: req.workspace!.role,
    });

    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

// ─── 20B: Trussen AI Chat ─────────────────────────────────────────────────

/**
 * POST /ai/chat — Send a message to Trussen AI
 *
 * Streams the response via Server-Sent Events (SSE).
 * The AI can call tools (create issues, query data, etc.) during the conversation.
 */
export const chat: RequestHandler = async (req, res, next) => {
  // Aborting the client request is how "stop" works: pressing Escape in the
  // panel closes the EventSource, Express emits "close", and this signal
  // propagates into the agent loop and the in-flight provider call. Without it
  // the turn would keep running (and keep costing money) after the user left.
  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  try {
    const { conversationId, message } = req.body as ChatInput;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
    res.flushHeaders();

    for await (const event of aiConversation.processConversationTurn({
      conversationId,
      message,
      userId: req.user!.id,
      workspaceId: req.workspace!.id,
      userRole: req.workspace!.role,
      signal: abortController.signal,
    })) {
      // Once the client is gone, keep consuming so the generator can finish its
      // persistence work, but stop writing to a dead socket.
      if (res.writableEnded) continue;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    }

    if (!res.writableEnded) {
      res.write("event: close\ndata: {}\n\n");
      res.end();
    }
  } catch (error) {
    if (res.headersSent) {
      if (!res.writableEnded) {
        const msg = error instanceof Error ? error.message : "Chat failed";
        res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
        res.end();
      }
    } else {
      next(error);
    }
  }
};

// ─── Reviewable AI changes ──────────────────────────────────────────────────

/** GET /ai/conversations/:id/mutations — changes the AI made in this conversation */
export const listConversationMutations: RequestHandler = async (req, res, next) => {
  try {
    const mutations = await aiMutations.listMutationsForConversation(
      req.params.id as string,
      req.workspace!.id,
    );
    sendSuccess(res, 200, mutations);
  } catch (error) {
    next(error);
  }
};

/** POST /ai/mutations/:id/accept — keep a change */
export const acceptMutation: RequestHandler = async (req, res, next) => {
  try {
    const result = await aiMutations.acceptMutation({
      mutationId: req.params.id as string,
      workspaceId: req.workspace!.id,
      userId: req.user!.id,
    });
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

/** POST /ai/mutations/:id/revert — undo a change, restoring its previous values */
export const revertMutation: RequestHandler = async (req, res, next) => {
  try {
    const result = await aiMutations.revertMutation({
      mutationId: req.params.id as string,
      workspaceId: req.workspace!.id,
      userId: req.user!.id,
      userRole: req.workspace!.role,
    });
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /ai/conversations — List user's conversations
 */
export const listConversations: RequestHandler = async (req, res, next) => {
  try {
    const conversations = await aiConversation.listConversations(req.user!.id, req.workspace!.id);
    sendSuccess(res, 200, conversations);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /ai/usage/workspace — Admin/owner workspace AI usage overview
 */
export const getWorkspaceUsage: RequestHandler = async (req, res, next) => {
  try {
    const query = req.validated!.query as AiUsageQuery;
    const usage = await aiUsage.getWorkspaceUsage(req.workspace!.id, query);
    sendSuccess(res, 200, usage);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /ai/usage/users — Admin/owner per-user AI usage breakdown
 */
export const getUserUsage: RequestHandler = async (req, res, next) => {
  try {
    const query = req.validated!.query as AiUsageQuery;
    const usage = await aiUsage.getUserUsage(req.workspace!.id, query);
    sendSuccess(res, 200, usage);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /ai/conversations/:id/messages — Get conversation messages
 */
export const getConversationMessages: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as ConversationParamsInput;
    const messages = await aiConversation.getConversationMessages(id, req.user!.id, req.workspace!.id);
    sendSuccess(res, 200, messages);
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /ai/conversations/:id — Delete a conversation
 */
export const deleteConversation: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as ConversationParamsInput;
    await aiConversation.deleteConversation(id, req.user!.id, req.workspace!.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

/**
 * GET /ai/suggestions — list background AI suggestions
 */
export const listSuggestions: RequestHandler = async (req, res, next) => {
  try {
    const query = req.validated!.query as ListSuggestionsInput;
    const result = await aiSuggestions.listSuggestions(
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
      query,
    );
    res.status(200).json({
      success: true,
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /ai/suggestions/:id/accept
 */
export const acceptSuggestion: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as SuggestionParamsInput;
    const body = req.body as AcceptSuggestionInput;
    const result = await aiSuggestions.acceptSuggestion(
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
      id,
      body,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /ai/suggestions/:id/dismiss
 */
export const dismissSuggestion: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.params as SuggestionParamsInput;
    const body = req.body as DismissSuggestionInput;
    const result = await aiSuggestions.dismissSuggestion(
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
      id,
      body,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /ai/suggestions/run
 */
export const runSuggestions: RequestHandler = async (req, res, next) => {
  try {
    const body = req.body as RunSuggestionsInput;
    const result = await aiSuggestions.runSuggestionJobs(
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
      body,
    );
    sendSuccess(res, 202, result);
  } catch (error) {
    next(error);
  }
};
