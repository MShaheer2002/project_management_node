import { z } from "zod/v4";

export const aiConnectionClientSchema = z.enum(["codex", "claude_desktop", "cursor", "generic_mcp"]);
export const aiConnectionAuthTypeSchema = z.enum(["pat", "oauth"]);

export const createAiConnectionSchema = {
  body: z.object({
    name: z
      .string()
      .trim()
      .min(1, "Connection name is required")
      .max(100, "Connection name must be at most 100 characters"),
    expiresAt: z
      .string()
      .datetime("Invalid date format — use ISO 8601")
      .refine((date) => new Date(date) > new Date(), "Expiration date must be in the future")
      .optional(),
    primaryClient: aiConnectionClientSchema.optional(),
    authType: aiConnectionAuthTypeSchema.optional(),
  }),
};

export const aiConnectionIdParamSchema = {
  params: z.object({
    id: z.string().uuid("Invalid AI connection ID"),
  }),
};

export type CreateAiConnectionInput = z.infer<typeof createAiConnectionSchema.body>;
export type AiConnectionClientInput = z.infer<typeof aiConnectionClientSchema>;
export type AiConnectionAuthTypeInput = z.infer<typeof aiConnectionAuthTypeSchema>;
