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

// Slack channel mapping schema (reusable)
const channelMappingSchema = z.object({
  channelId: z.string().min(1),
  channelName: z.string().min(1),
});

const channelRoutingSchema = z.object({
  projects: z.record(z.string(), z.array(channelMappingSchema)).optional(),
  teams: z.record(z.string(), z.array(channelMappingSchema)).optional(),
  urgent: channelMappingSchema.nullable().optional(),
}).optional();

/** PATCH /integrations/:provider/settings — Update settings (GitHub + Slack) */
export const updateSettingsSchema = {
  params: z.object({
    provider: providerSchema,
  }),
  body: z.object({
    // GitHub settings
    autoCompleteOnMerge: z.boolean().optional(),
    autoMoveToReviewOnPr: z.boolean().optional(),
    notifyOnPrOpen: z.boolean().optional(),
    notifyOnPrReview: z.boolean().optional(),
    notifyOnPrMerge: z.boolean().optional(),
    showCommits: z.boolean().optional(),
    showBranches: z.boolean().optional(),
    // Slack notification toggles
    notifyOnIssueCreatedUrgent: z.boolean().optional(),
    notifyOnIssueCompleted: z.boolean().optional(),
    notifyOnIssueAssigned: z.boolean().optional(),
    notifyOnStatusChange: z.boolean().optional(),
    notifyOnCycleStarted: z.boolean().optional(),
    notifyOnCycleCompleted: z.boolean().optional(),
    notifyOnProjectCompleted: z.boolean().optional(),
    // Slack DM toggles
    dmOnAssigned: z.boolean().optional(),
    dmOnMentioned: z.boolean().optional(),
    dmOnPrActivity: z.boolean().optional(),
    dmOnDueDateReminder: z.boolean().optional(),
    dmOnAllStatusChanges: z.boolean().optional(),
    // Slack slash command toggles
    slashCreate: z.boolean().optional(),
    slashStatus: z.boolean().optional(),
    slashMyIssues: z.boolean().optional(),
    slashCycle: z.boolean().optional(),
    // Legacy setting names (backwards compat)
    dmOnAssignment: z.boolean().optional(),
    dmOnMention: z.boolean().optional(),
    dmOnDueDateApproaching: z.boolean().optional(),
    slashCommandsEnabled: z.boolean().optional(),
    // Slack channel config
    defaultChannelId: z.string().min(1).optional(),
    defaultChannelName: z.string().min(1).optional(),
    defaultChannel: z.string().min(1).optional(),
    // Slack channel routing (project/team → channels)
    channelRouting: channelRoutingSchema,
  }),
};

// ─── Inferred Types ──────────────────────────────────────────────────────────

export type Provider = z.infer<typeof providerSchema>;
