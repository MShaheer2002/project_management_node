/**
 * Environment Configuration
 *
 * This file validates ALL required environment variables at startup using Zod.
 * If any variable is missing or invalid, the server crashes immediately with
 * a clear error message — no silent failures in production.
 *
 * Usage: import { env } from "../config/env.js" anywhere in the app.
 * Never access process.env directly — always use this typed `env` object.
 */

import "dotenv/config";
import { z } from "zod/v4";

// Schema defines every env var the app needs, with types and defaults
const envSchema = z.object({
  // Database — Prisma connection string
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Clerk — authentication provider
  CLERK_PUBLISHABLE_KEY: z.string().min(1, "CLERK_PUBLISHABLE_KEY is required"),
  CLERK_SECRET_KEY: z.string().min(1, "CLERK_SECRET_KEY is required"),
  CLERK_WEBHOOK_SECRET: z.string().min(1, "CLERK_WEBHOOK_SECRET is required"),

  // App settings
  PORT: z.coerce.number().default(8000),
  NODE_ENV: z
    .enum(["development", "staging", "production"])
    .default("development"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
});

// Validate environment variables — crashes if invalid
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.format());
  process.exit(1);
}

// Export the validated, typed env object
export const env = parsed.data;

// Type helper for use elsewhere
export type Env = z.infer<typeof envSchema>;
