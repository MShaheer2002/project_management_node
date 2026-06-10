/**
 * API Key Module — Zod Schemas
 *
 * Validation schemas for API key management endpoints.
 * These are the single source of truth for input validation AND TypeScript types.
 */

import { z } from "zod/v4";

/** POST /api-keys — Create a new API key */
export const createApiKeySchema = {
  body: z.object({
    name: z
      .string()
      .min(1, "API key name is required")
      .max(100, "Name must be at most 100 characters")
      .trim(),
    expiresAt: z
      .string()
      .datetime("Invalid date format — use ISO 8601 (e.g., 2027-01-01T00:00:00Z)")
      .refine(
        (date) => new Date(date) > new Date(),
        "Expiration date must be in the future",
      )
      .optional(),
  }),
};

/** GET /api-keys/:id, DELETE /api-keys/:id — API key ID param */
export const apiKeyIdParamSchema = {
  params: z.object({
    id: z.string().uuid("Invalid API key ID"),
  }),
};

// ─── Inferred Types ──────────────────────────────────────────────────────────

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema.body>;
