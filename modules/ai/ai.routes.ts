/**
 * AI Module — Route Definitions
 *
 * All routes are mounted under /ai by app.ts.
 * All routes require authentication + workspace context.
 *
 * Routes:
 *   POST /generate-issue           — Generate a structured issue from natural language (20A)
 *   GET  /models                    — List available AI models
 *   POST /chat                      — Send a message to Trussen AI (20B, SSE streaming)
 *   GET  /conversations             — List user's conversations
 *   GET  /conversations/:id/messages — Get conversation messages
 *   DELETE /conversations/:id       — Delete a conversation
 */

import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import { strictRateLimiter } from "../../shared/middleware/rate-limiter.js";
import * as controller from "./ai.controller.js";
import { aiUsageQuerySchema, chatSchema, conversationParamsSchema, generateIssueSchema } from "./ai.schemas.js";

const router = Router();

// ── Phase 20A: Issue Creator ────────────────────────────────────────────────

router.post(
  "/generate-issue",
  authenticate,
  requireWorkspace,
  strictRateLimiter,
  validate(generateIssueSchema),
  controller.generateIssue,
);

router.get(
  "/models",
  authenticate,
  controller.getModels,
);

// ── Phase 20B: Trussen AI Chat ──────────────────────────────────────────────

router.post(
  "/chat",
  authenticate,
  requireWorkspace,
  strictRateLimiter,
  validate(chatSchema),
  controller.chat,
);

router.get(
  "/conversations",
  authenticate,
  requireWorkspace,
  controller.listConversations,
);

router.get(
  "/usage/workspace",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  validate(aiUsageQuerySchema),
  controller.getWorkspaceUsage,
);

router.get(
  "/usage/users",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  validate(aiUsageQuerySchema),
  controller.getUserUsage,
);

router.get(
  "/conversations/:id/messages",
  authenticate,
  requireWorkspace,
  validate(conversationParamsSchema),
  controller.getConversationMessages,
);

router.delete(
  "/conversations/:id",
  authenticate,
  requireWorkspace,
  validate(conversationParamsSchema),
  controller.deleteConversation,
);

export default router;
