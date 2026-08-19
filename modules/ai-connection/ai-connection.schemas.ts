import { z } from "zod/v4";
import { ALL_SCOPES } from "./ai-connection.scopes.js";

export const aiConnectionClientSchema = z.enum([
  "codex",
  "claude_desktop",
  "claude_code",
  "chatgpt",
  "gemini_cli",
  "windsurf",
  "vscode",
  "cursor",
  "generic_mcp",
]);
export const aiConnectionAuthTypeSchema = z.enum(["pat", "oauth"]);
export const aiConnectionScopeSchema = z.enum(ALL_SCOPES);

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
    scopes: aiConnectionScopeSchema.array().min(1, "Select at least one scope").optional(),
  }),
};

export const aiConnectionIdParamSchema = {
  params: z.object({
    id: z.string().uuid("Invalid AI connection ID"),
  }),
};

export const updateAiConnectionScopesSchema = {
  params: z.object({
    id: z.string().uuid("Invalid AI connection ID"),
  }),
  body: z.object({
    scopes: aiConnectionScopeSchema.array().min(1, "Select at least one scope"),
  }),
};

export const aiConnectionSessionListQuerySchema = {
  query: z.object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
  }),
};

export type CreateAiConnectionInput = z.infer<typeof createAiConnectionSchema.body>;
export type AiConnectionClientInput = z.infer<typeof aiConnectionClientSchema>;
export type AiConnectionAuthTypeInput = z.infer<typeof aiConnectionAuthTypeSchema>;
