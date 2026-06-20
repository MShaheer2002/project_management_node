/**
 * AI Module — Zod Schemas
 *
 * Validation for AI endpoints AND for AI response parsing.
 * The response schema is critical — it prevents hallucinated output from reaching the DB.
 */

import { z } from "zod/v4";

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

// ─── Inferred Types ─────────────────────────────────────────────────────────

export type GenerateIssueInput = z.infer<typeof generateIssueSchema.body>;
export type AiIssueResponse = z.infer<typeof aiIssueResponseSchema>;
