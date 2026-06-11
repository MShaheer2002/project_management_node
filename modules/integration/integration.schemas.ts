/**
 * Integration Module — Zod Schemas
 *
 * Validation schemas for integration management and GitHub webhook payloads.
 */

import { z } from "zod/v4";

const providerSchema = z.enum(["github", "slack", "discord", "figma"]);

/** POST /integrations/:provider/connect — Start OAuth */
export const connectProviderSchema = {
  params: z.object({
    provider: providerSchema,
  }),
};

/** DELETE /integrations/:provider/disconnect — Disconnect */
export const disconnectProviderSchema = {
  params: z.object({
    provider: providerSchema,
  }),
};

/** GET /integrations/:provider/callback — OAuth callback */
export const oauthCallbackSchema = {
  params: z.object({
    provider: providerSchema,
  }),
  query: z.object({
    code: z.string().min(1, "Authorization code is required"),
    state: z.string().min(1, "State parameter is required"),
  }),
};

/** PATCH /integrations/:provider/settings — Update settings */
export const updateSettingsSchema = {
  params: z.object({
    provider: providerSchema,
  }),
  body: z.object({
    autoCompleteOnMerge: z.boolean().optional(),
    autoMoveToReviewOnPr: z.boolean().optional(),
    notifyOnPrOpen: z.boolean().optional(),
    notifyOnPrReview: z.boolean().optional(),
    notifyOnPrMerge: z.boolean().optional(),
    showCommits: z.boolean().optional(),
    showBranches: z.boolean().optional(),
  }),
};

// ─── Inferred Types ──────────────────────────────────────────────────────────

export type Provider = z.infer<typeof providerSchema>;
