/**
 * AI Module — Zod Schemas
 *
 * Validation for AI endpoints AND for AI response parsing.
 * The response schema is critical — it prevents hallucinated output from reaching the DB.
 */

import { z } from "zod/v4";

const aiUsagePeriodSchema = z.enum(["7d", "30d", "90d", "custom"]);
const aiSuggestionTypeSchema = z.enum([
  "ASSIGNEE",
  "DUPLICATE",
  "LABEL",
  "PRIORITY",
  "STALE_ISSUE",
  "WEEKLY_DIGEST",
  "SPRINT_PLANNING",
]);
const aiSuggestionStatusSchema = z.enum(["OPEN", "ACCEPTED", "DISMISSED", "EXPIRED", "SUPERSEDED"]);

// ─── Request Schemas ────────────────────────────────────────────────────────

/** POST /ai/generate-issue — Generate a structured issue from natural language */
export const generateIssueSchema = {
  body: z.object({
    prompt: z.string().trim().min(5, "Prompt must be at least 5 characters").max(5000, "Prompt too long"),
    // Pre-resolved mentions from the frontend dropdown (user already picked these)
    resolvedAssigneeId: z.string().min(1).optional(),
    resolvedProjectId: z.string().min(1).optional(),
  }),
};

/** POST /ai/chat — Stream a Trussen AI response for a conversation */
export const chatSchema = {
  body: z.object({
    conversationId: z.string().uuid().optional(),
    message: z.string().trim().min(1, "Message is required").max(5000, "Message too long"),
  }),
};

/** POST /ai/assist — Ephemeral lightweight assistant */
export const assistSchema = {
  body: z.object({
    message: z.string().trim().min(1, "Message is required").max(5000, "Message too long"),
    route: z.string().trim().max(200).optional(),
    pageTitle: z.string().trim().max(120).optional(),
  }),
};

/** GET/DELETE /ai/conversations/:id — Conversation-scoped operations */
export const conversationParamsSchema = {
  params: z.object({
    id: z.string().uuid("Conversation ID must be a valid UUID"),
  }),
};

/** /ai/suggestions/:id scoped operations */
export const suggestionParamsSchema = {
  params: z.object({
    id: z.string().uuid("Suggestion ID must be a valid UUID"),
  }),
};

/** GET /ai/suggestions */
export const listSuggestionsSchema = {
  query: z.object({
    status: aiSuggestionStatusSchema.optional(),
    type: aiSuggestionTypeSchema.optional(),
    targetType: z.string().trim().min(1).max(50).optional(),
    targetId: z.string().trim().min(1).max(255).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().uuid().optional(),
  }),
};

/** POST /ai/suggestions/:id/accept */
export const acceptSuggestionSchema = {
  params: suggestionParamsSchema.params,
  body: z.object({
    selectedIds: z.array(z.string().min(1).max(255)).max(50).optional(),
  }),
};

/** POST /ai/suggestions/:id/dismiss */
export const dismissSuggestionSchema = {
  params: suggestionParamsSchema.params,
  body: z.object({
    reason: z.string().trim().max(200).optional(),
  }),
};

/** POST /ai/suggestions/run */
export const runSuggestionsSchema = {
  body: z.object({
    targetType: z.enum(["issue", "cycle", "workspace"]),
    targetId: z.string().trim().min(1).max(255),
    jobs: z.array(z.enum(["labels", "priority", "duplicate", "assignee", "stale-scan", "weekly-digest", "sprint-planning", "embedding"])).min(1).max(8),
  }),
};

/** GET /ai/usage/* — Usage analytics for admins and owners */
export const aiUsageQuerySchema = {
  query: z.object({
    period: aiUsagePeriodSchema.default("30d"),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }).superRefine((value, ctx) => {
    if (value.period === "custom") {
      if (!value.from) {
        ctx.addIssue({ code: "custom", path: ["from"], message: "from is required when period=custom" });
      }
      if (!value.to) {
        ctx.addIssue({ code: "custom", path: ["to"], message: "to is required when period=custom" });
      }
      if (value.from && value.to && value.from > value.to) {
        ctx.addIssue({ code: "custom", path: ["to"], message: "to must be greater than or equal to from" });
      }
    }
  }),
};

// ─── AI Response Validation Schema ──────────────────────────────────────────

/**
 * Validates the JSON output from the AI model.
 * Every field is optional with safe defaults — if AI omits something, we handle it gracefully.
 * If AI hallucinates invalid values, Zod strips them.
 */
export const aiIssueResponseSchema = z.object({
  title: z.string().min(1).max(500).default("Untitled Issue"),
  type: z.enum(["task", "bug", "issue"]).default("task"),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  description: z.string().max(50000).default(""),
  suggestedLabels: z.array(z.string().max(80)).max(10).default([]),
  suggestedAssigneeName: z.string().max(100).optional(),
  suggestedProjectName: z.string().max(200).optional(),
  subtasks: z.array(z.object({ title: z.string().min(1).max(500) })).max(20).default([]),
  // Due date — AI returns relative ("2 days", "next friday") or absolute ("2026-06-25")
  dueDateOffset: z.number().int().min(0).max(365).optional(), // Days from today
  dueDate: z.string().optional(), // ISO date string (YYYY-MM-DD)
  // Estimate — story points 1-5
  estimate: z.number().int().min(1).max(5).optional(),
  // Bug-specific fields
  stepsToReproduce: z.string().max(50000).optional(),
  expectedBehavior: z.string().max(50000).optional(),
  actualBehavior: z.string().max(50000).optional(),
  severity: z.enum(["low", "medium", "high"]).optional(),
  // Feature/issue-specific
  acceptanceCriteria: z.string().max(50000).optional(),
  notes: z.string().max(50000).optional(),
});

const aiAssistFactSchema = z.object({
  label: z.string().min(1).max(80),
  value: z.string().min(1).max(200),
});

export const aiAssistResponseSchema = z.object({
  intent: z.enum(["guidance", "navigation", "permission", "feature", "status"]).default("guidance"),
  title: z.string().max(120).optional(),
  answer: z.string().min(1).max(8000),
  followUps: z.array(z.string().min(1).max(120)).max(4).default([]),
  navigation: z.object({
    route: z.string().min(1).max(240),
    label: z.string().min(1).max(80),
  }).optional(),
  facts: z.array(aiAssistFactSchema).max(6).default([]),
});

// ─── Inferred Types ─────────────────────────────────────────────────────────

export type GenerateIssueInput = z.infer<typeof generateIssueSchema.body>;
export type ChatInput = z.infer<typeof chatSchema.body>;
export type AssistInput = z.infer<typeof assistSchema.body>;
export type ConversationParamsInput = z.infer<typeof conversationParamsSchema.params>;
export type SuggestionParamsInput = z.infer<typeof suggestionParamsSchema.params>;
export type ListSuggestionsInput = z.infer<typeof listSuggestionsSchema.query>;
export type AcceptSuggestionInput = z.infer<typeof acceptSuggestionSchema.body>;
export type DismissSuggestionInput = z.infer<typeof dismissSuggestionSchema.body>;
export type RunSuggestionsInput = z.infer<typeof runSuggestionsSchema.body>;
export type AiUsageQuery = z.infer<typeof aiUsageQuerySchema.query>;
export type AiIssueResponse = z.infer<typeof aiIssueResponseSchema>;
export type AiAssistResponse = z.infer<typeof aiAssistResponseSchema>;
