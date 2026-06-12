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

const emptyStringToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

// Schema defines every env var the app needs, with types and defaults
const envSchema = z.object({
  // Database — Prisma connection string
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Clerk — authentication provider
  CLERK_PUBLISHABLE_KEY: z.string().min(1, "CLERK_PUBLISHABLE_KEY is required"),
  CLERK_SECRET_KEY: z.string().min(1, "CLERK_SECRET_KEY is required"),
  CLERK_WEBHOOK_SECRET: z.string().min(1, "CLERK_WEBHOOK_SECRET is required"),

  // Resend — email service (for workspace invitations, notifications)
  RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is required"),
  RESEND_FROM_ADDRESS: z.string().default("Linearis <onboarding@resend.dev>"),

  // App settings
  PORT: z.coerce.number().default(8000),
  NODE_ENV: z
    .enum(["development", "staging", "production"])
    .default("development"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  BACKEND_URL: z.preprocess(emptyStringToUndefined, z.string().url().optional()),

  // Stripe — workspace billing
  STRIPE_SECRET_KEY: z.string().min(1, "STRIPE_SECRET_KEY is required"),
  STRIPE_WEBHOOK_SECRET: z.string().min(1, "STRIPE_WEBHOOK_SECRET is required"),
  STRIPE_STANDARD_MONTHLY_PRICE_ID: z.string().min(1, "STRIPE_STANDARD_MONTHLY_PRICE_ID is required"),
  STRIPE_PREMIUM_MONTHLY_PRICE_ID: z.string().min(1, "STRIPE_PREMIUM_MONTHLY_PRICE_ID is required"),

  // AWS S3 — direct browser uploads via presigned PUT URLs
  AWS_ACCESS_KEY_ID: z.string().min(1, "AWS_ACCESS_KEY_ID is required"),
  AWS_SECRET_ACCESS_KEY: z.string().min(1, "AWS_SECRET_ACCESS_KEY is required"),
  AWS_SESSION_TOKEN: z.preprocess(emptyStringToUndefined, z.string().optional()),
  AWS_REGION: z.string().min(1, "AWS_REGION is required"),
  AWS_S3_BUCKET: z.string().min(1, "AWS_S3_BUCKET is required"),
  AWS_S3_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  AWS_S3_UPLOAD_PREFIX: z.preprocess(
    emptyStringToUndefined,
    z.string().trim().min(1).default("uploads"),
  ),
  AWS_S3_PUBLIC_BASE_URL: z.preprocess(
    emptyStringToUndefined,
    z.string().url().optional(),
  ),
  UPLOAD_IMAGE_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  UPLOAD_VIDEO_MAX_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),

  // GitHub — OAuth App for workspace integration (Phase 19a)
  GITHUB_CLIENT_ID: z.preprocess(emptyStringToUndefined, z.string().optional()),
  GITHUB_CLIENT_SECRET: z.preprocess(emptyStringToUndefined, z.string().optional()),
  GITHUB_WEBHOOK_SECRET: z.preprocess(emptyStringToUndefined, z.string().optional()),

  // Slack — OAuth App for workspace integration (Phase 19b)
  SLACK_CLIENT_ID: z.preprocess(emptyStringToUndefined, z.string().optional()),
  SLACK_CLIENT_SECRET: z.preprocess(emptyStringToUndefined, z.string().optional()),
  SLACK_SIGNING_SECRET: z.preprocess(emptyStringToUndefined, z.string().optional()),
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
