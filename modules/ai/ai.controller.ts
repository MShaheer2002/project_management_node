/**
 * AI Module — Controller
 *
 * HTTP handlers for AI endpoints.
 * Controllers are DUMB — parse request, call service, send response.
 */

import type { RequestHandler } from "express";
import * as aiService from "./ai.service.js";
import * as aiAssist from "./ai.assist.js";
import * as aiChat from "./ai.chat.js";
import * as aiUsage from "./ai.usage.js";
import { sendSuccess } from "../../shared/utils/api-response.js";
import { listAvailableModels } from "./ai.provider.js";
import type { AiUsageQuery, AssistInput, ChatInput, ConversationParamsInput, GenerateIssueInput } from "./ai.schemas.js";

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
  try {
    const { conversationId, message } = req.body as ChatInput;
    const userId = req.user!.id;
    const workspaceId = req.workspace!.id;
    const userRole = req.workspace!.role;

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
    res.flushHeaders();

    // Stream events from the chat processor
    for await (const event of aiChat.processChat({
      conversationId,
      message,
      userId,
      workspaceId,
      userRole,
    })) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    }

    res.write("event: close\ndata: {}\n\n");
    res.end();
  } catch (error) {
    // If headers already sent (SSE started), send error event
    if (res.headersSent) {
      const msg = error instanceof Error ? error.message : "Chat failed";
      res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
      res.end();
    } else {
      next(error);
    }
  }
};

/**
 * GET /ai/conversations — List user's conversations
 */
export const listConversations: RequestHandler = async (req, res, next) => {
  try {
    const conversations = await aiChat.listConversations(req.user!.id, req.workspace!.id);
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
    const messages = await aiChat.getConversationMessages(id, req.user!.id, req.workspace!.id);
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
    await aiChat.deleteConversation(id, req.user!.id, req.workspace!.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
