/**
 * Slack Integration — Zod Schemas
 *
 * Validation schemas for Slack-specific endpoints.
 */

import { z } from "zod/v4";

function validateScopedChannelInput(
  input: { scope: "default" | "project" | "team" | "urgent"; scopeId?: string | undefined },
  ctx: z.RefinementCtx,
) {
  if ((input.scope === "project" || input.scope === "team") && !input.scopeId) {
    ctx.addIssue({
      code: "custom",
      path: ["scopeId"],
      message: `scopeId is required when scope is ${input.scope}`,
    });
  }

  if ((input.scope === "default" || input.scope === "urgent") && input.scopeId !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["scopeId"],
      message: `scopeId must be omitted when scope is ${input.scope}`,
    });
  }
}

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
  }).superRefine(validateScopedChannelInput),
};

/** DELETE /integrations/slack/channels/:channelDbId — Remove a channel mapping */
export const removeSlackChannelSchema = {
  params: z.object({
    channelDbId: z.string().uuid(),
  }),
};
