/**
 * Figma Integration — Zod Schemas
 */

import { z } from "zod/v4";

/** POST /integrations/figma/connect — Connect with personal access token */
export const connectFigmaSchema = {
  body: z.object({
    accessToken: z.string().min(1, "Figma access token is required").max(500, "Token too long"),
  }),
};

/** GET /integrations/figma/preview — Fetch file metadata from URL */
export const previewFigmaSchema = {
  query: z.object({
    url: z.string().url("Must be a valid Figma URL"),
  }),
};

/** PATCH /integrations/figma/settings */
export const updateFigmaSettingsSchema = {
  body: z.object({
    showThumbnails: z.boolean().optional(),
    showLastModified: z.boolean().optional(),
  }),
};
