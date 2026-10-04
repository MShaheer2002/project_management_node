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
  assistFeedbackSchema,
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

router.get(
  "/availability",
  authenticate,
  requireWorkspace,
  controller.availability,
);

// ── Phase 20B: Trussen AI Chat ──────────────────────────────────────────────

router.post(
  "/assist/answers/:id/feedback",
  authenticate,
  validate(assistFeedbackSchema),
  requireWorkspace,
  controller.assistFeedback,
);

router.get(
  "/assist/history",
  authenticate,
  requireWorkspace,
  controller.assistHistory,
);

router.delete(
  "/assist/history",
  authenticate,
  requireWorkspace,
  controller.clearAssistHistoryHandler,
);

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

// Same as /assist, streamed (Server-Sent Events). Same limits.
router.post(
  "/assist/stream",
  authenticate,
  requireWorkspace,
  aiAssistWorkspaceRateLimiter,
  aiAssistUserRateLimiter,
  strictRateLimiter,
  validate(assistSchema),
  controller.assistStream,
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
// Records are scoped to the actor the AI worked for (admins see all), and the
// revert re-checks lead-or-admin for PROJECT/TEAM targets — `updateProject` and
// `updateTeam` carry no authorization of their own, so the claim that "the domain
// services enforce it" was only true for ISSUE targets (F-08).

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
  // Applying a suggestion writes to issues and cycles, so it is not a
  // read-only action — GUESTs could reassign issues and pull arbitrary
  // issues into a cycle through this route (F-24).
  requireRole("MEMBER", "ADMIN", "OWNER"),
  validate(acceptSuggestionSchema),
  controller.acceptSuggestion,
);

router.post(
  "/suggestions/:id/dismiss",
  authenticate,
  requireWorkspace,
  // Applying a suggestion writes to issues and cycles, so it is not a
  // read-only action — GUESTs could reassign issues and pull arbitrary
  // issues into a cycle through this route (F-24).
  requireRole("MEMBER", "ADMIN", "OWNER"),
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
