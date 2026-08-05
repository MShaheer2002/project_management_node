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
 *   GET  /conversations/:id/mutations — Reviewable AI changes in a conversation
 *   POST /mutations/:id/accept      — Keep an AI change
 *   POST /mutations/:id/revert      — Undo an AI change
 */

import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import { aiAssistUserRateLimiter, aiAssistWorkspaceRateLimiter, strictRateLimiter } from "../../shared/middleware/rate-limiter.js";
import * as controller from "./ai.controller.js";
import {
  acceptSuggestionSchema,
  aiUsageQuerySchema,
  assistSchema,
  chatSchema,
  conversationParamsSchema,
  dismissSuggestionSchema,
  draftSuggestionsSchema,
  generateIssueSchema,
  listSuggestionsSchema,
  mutationParamsSchema,
  runSuggestionsSchema,
} from "./ai.schemas.js";

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

router.post(
  "/draft-suggestions",
  authenticate,
  requireWorkspace,
  strictRateLimiter,
  validate(draftSuggestionsSchema),
  controller.getDraftSuggestions,
);

router.get(
  "/models",
  authenticate,
  controller.getModels,
);

// ── Phase 20B: Trussen AI Chat ──────────────────────────────────────────────

router.post(
  "/assist",
  authenticate,
  requireWorkspace,
  aiAssistWorkspaceRateLimiter,
  aiAssistUserRateLimiter,
  strictRateLimiter,
  validate(assistSchema),
  controller.assist,
);

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

// ── Reviewable AI changes (accept / undo) ───────────────────────────────────
//
// Authorization for the underlying revert is enforced in the domain services the
// revert routes through, exactly as it would be for a manual edit.

router.get(
  "/conversations/:id/mutations",
  authenticate,
  requireWorkspace,
  validate(conversationParamsSchema),
  controller.listConversationMutations,
);

router.post(
  "/mutations/:id/accept",
  authenticate,
  requireWorkspace,
  validate(mutationParamsSchema),
  controller.acceptMutation,
);

router.post(
  "/mutations/:id/revert",
  authenticate,
  requireWorkspace,
  validate(mutationParamsSchema),
  controller.revertMutation,
);

router.get(
  "/suggestions",
  authenticate,
  requireWorkspace,
  validate(listSuggestionsSchema),
  controller.listSuggestions,
);

router.post(
  "/suggestions/:id/accept",
  authenticate,
  requireWorkspace,
  validate(acceptSuggestionSchema),
  controller.acceptSuggestion,
);

router.post(
  "/suggestions/:id/dismiss",
  authenticate,
  requireWorkspace,
  validate(dismissSuggestionSchema),
  controller.dismissSuggestion,
);

router.post(
  "/suggestions/run",
  authenticate,
  requireWorkspace,
  requireRole("ADMIN", "OWNER"),
  strictRateLimiter,
  validate(runSuggestionsSchema),
  controller.runSuggestions,
);

export default router;
