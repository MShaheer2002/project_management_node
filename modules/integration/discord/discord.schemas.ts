/**
 * Discord Integration -- Zod Schemas
 *
 * Validation schemas for Discord webhook management and settings.
 */

import { z } from "zod/v4";

const DISCORD_WEBHOOK_URL_REGEX =
  /^https:\/\/(?:discord\.com|discordapp\.com|discordptb\.com)\/api\/webhooks\/\d+\/.+$/;

function validateScopedWebhookInput(
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

/** POST /integrations/discord/connect */
export const connectDiscordSchema = {
  body: z.object({
    webhookUrl: z
      .string()
      .url("Must be a valid URL")
      .regex(DISCORD_WEBHOOK_URL_REGEX, "Must be a valid Discord webhook URL (https://discord.com/api/webhooks/...)"),
    label: z.string().max(100).optional(),
  }),
};

/** PATCH /integrations/discord/settings */
export const updateDiscordSettingsSchema = {
  body: z.object({
    notifyOnIssueCreatedUrgent: z.boolean().optional(),
    notifyOnIssueCompleted: z.boolean().optional(),
    notifyOnIssueAssigned: z.boolean().optional(),
    notifyOnStatusChange: z.boolean().optional(),
    notifyOnCycleStarted: z.boolean().optional(),
    notifyOnCycleCompleted: z.boolean().optional(),
    notifyOnProjectCompleted: z.boolean().optional(),
  }),
};

/** POST /integrations/discord/webhooks */
export const addDiscordWebhookSchema = {
  body: z.object({
    url: z
      .string()
      .url("Must be a valid URL")
      .regex(DISCORD_WEBHOOK_URL_REGEX, "Must be a valid Discord webhook URL"),
    label: z.string().min(1).max(100),
    scope: z.enum(["default", "project", "team", "urgent"]),
    scopeId: z.string().uuid().optional(),
  }).superRefine(validateScopedWebhookInput),
};

/** DELETE /integrations/discord/webhooks/:webhookDbId */
export const removeDiscordWebhookSchema = {
  params: z.object({
    webhookDbId: z.string().uuid(),
  }),
};
