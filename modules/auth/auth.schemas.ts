/**
 * Auth Module — Zod Schemas
 *
 * Defines validation schemas for the auth module.
 * Since Clerk sends us webhook payloads, we validate the extracted user data
 * before persisting to our database.
 */

import { z } from "zod/v4";

/**
 * Schema for the user data we extract from Clerk webhook payloads.
 * Used to validate before inserting/updating our User table.
 */
export const clerkUserSchema = z.object({
  id: z.string().min(1), // Clerk user_id (e.g., "user_2x...")
  email_addresses: z
    .array(
      z.object({
        email_address: z.string().email(),
        id: z.string(),
      }),
    )
    .min(1),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  image_url: z.string().nullable(),
});

/** Type inferred from Clerk user payload */
export type ClerkUserPayload = z.infer<typeof clerkUserSchema>;
