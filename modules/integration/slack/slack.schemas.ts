/**
 * Slack Integration — Zod Schemas
 *
 * Validation schemas for Slack-specific endpoints.
 */

import { z } from "zod/v4";

/** PATCH /integrations/slack/settings — Update Slack notification settings */
export const updateSlackSettingsSchema = {
  body: z.object({
    notifyOnIssueCreatedUrgent: z.boolean().optional(),
    notifyOnIssueCompleted: z.boolean().optional(),
    notifyOnIssueAssigned: z.boolean().optional(),
    notifyOnCycleStarted: z.boolean().optional(),
    notifyOnCycleCompleted: z.boolean().optional(),
    dmOnAssignment: z.boolean().optional(),
    dmOnMention: z.boolean().optional(),
    dmOnDueDateApproaching: z.boolean().optional(),
    slashCommandsEnabled: z.boolean().optional(),
  }),
};

/** POST /integrations/slack/channels — Add a channel mapping */
export const setSlackChannelSchema = {
  body: z.object({
    channelId: z.string().min(1),
    channelName: z.string().min(1),
    scope: z.enum(["default", "project", "team", "urgent"]),
    scopeId: z.string().uuid().optional(),
  }),
};

/** DELETE /integrations/slack/channels/:channelDbId — Remove a channel mapping */
export const removeSlackChannelSchema = {
  params: z.object({
    channelDbId: z.string().uuid(),
  }),
};
