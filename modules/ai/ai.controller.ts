/**
 * AI Module — Controller
 *
 * HTTP handlers for AI endpoints.
 * Controllers are DUMB — parse request, call service, send response.
 */

import type { RequestHandler } from "express";
import * as aiService from "./ai.service.js";
import * as aiChat from "./ai.chat.js";
import { sendSuccess } from "../../shared/utils/api-response.js";
import { listAvailableModels } from "./ai.provider.js";
import type { GenerateIssueInput } from "./ai.schemas.js";

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

// ─── 20B: Trussen AI Chat ─────────────────────────────────────────────────

/**
 * POST /ai/chat — Send a message to Trussen AI
 *
 * Streams the response via Server-Sent Events (SSE).
 * The AI can call tools (create issues, query data, etc.) during the conversation.
 */
export const chat: RequestHandler = async (req, res, next) => {
  try {
    const { conversationId, message } = req.body as { conversationId?: string; message: string };
    const userId = req.user!.id;
    const workspaceId = req.workspace!.id;
    const userRole = req.workspace!.role;

    if (!message?.trim()) {
      res.status(422).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Message is required" } });
      return;
    }

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
    res.flushHeaders();

    // Stream events from the chat processor
    for await (const event of aiChat.processChat({
      conversationId,
      message: message.trim(),
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
 * GET /ai/conversations/:id/messages — Get conversation messages
 */
export const getConversationMessages: RequestHandler = async (req, res, next) => {
  try {
    const messages = await aiChat.getConversationMessages(req.params.id as string, req.user!.id);
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
    await aiChat.deleteConversation(req.params.id as string, req.user!.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
