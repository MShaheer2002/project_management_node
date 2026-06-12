/**
 * GitHub Integration — Zod Schemas
 *
 * Validation schemas for GitHub-specific settings endpoints.
 */

import { z } from "zod/v4";

/** PATCH /integrations/github/settings — Update GitHub settings */
export const updateGithubSettingsSchema = {
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

export type UpdateGithubSettingsBody = z.infer<typeof updateGithubSettingsSchema.body>;
