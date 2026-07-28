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

const stringBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return value;
}, z.boolean());

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
  RESEND_FROM_ADDRESS: z.string().default("Trussen <hello@trussen.app>"),

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

  // Google Drive — per-user storage integration (Phase 19e)
  GOOGLE_CLIENT_ID: z.preprocess(emptyStringToUndefined, z.string().optional()),
  GOOGLE_CLIENT_SECRET: z.preprocess(emptyStringToUndefined, z.string().optional()),
  GOOGLE_REDIRECT_URI: z.preprocess(emptyStringToUndefined, z.string().url().optional()),
  ENCRYPTION_KEY: z.preprocess(emptyStringToUndefined, z.string().min(32).optional()),

  // OpenRouter — AI gateway (Phase 20)
  OPENROUTER_API_KEY: z.preprocess(emptyStringToUndefined, z.string().optional()),

  // AI Models — Issue Creator (Phase 20A)
  AI_ISSUE_MODEL_DEFAULT: z.preprocess(emptyStringToUndefined, z.string().optional()),
  AI_ISSUE_MODEL_FALLBACK_1: z.preprocess(emptyStringToUndefined, z.string().optional()),
  AI_ISSUE_MODEL_FALLBACK_2: z.preprocess(emptyStringToUndefined, z.string().optional()),
  AI_ISSUE_MODEL_FALLBACK_3: z.preprocess(emptyStringToUndefined, z.string().optional()),

  // AI Models — Trussen AI Chat/Panel (Phase 20B)
  AI_CHAT_MODEL_DEFAULT: z.preprocess(emptyStringToUndefined, z.string().optional()),
  AI_CHAT_MODEL_FALLBACK_1: z.preprocess(emptyStringToUndefined, z.string().optional()),
  AI_CHAT_MODEL_FALLBACK_2: z.preprocess(emptyStringToUndefined, z.string().optional()),
  AI_CHAT_MODEL_FALLBACK_3: z.preprocess(emptyStringToUndefined, z.string().optional()),

  // AI Billing & safety controls — monitor mode by default until plan limits are finalized
  AI_ENFORCE_BILLING: stringBoolean.default(false),
  AI_FREE_DAILY_REQUEST_LIMIT: z.preprocess(emptyStringToUndefined, z.coerce.number().int().positive().optional()),
  AI_STANDARD_DAILY_REQUEST_LIMIT: z.preprocess(emptyStringToUndefined, z.coerce.number().int().positive().optional()),
  AI_PREMIUM_DAILY_REQUEST_LIMIT: z.preprocess(emptyStringToUndefined, z.coerce.number().int().positive().optional()),
  AI_FREE_DAILY_TOKEN_LIMIT: z.preprocess(emptyStringToUndefined, z.coerce.number().int().positive().optional()),
  AI_STANDARD_DAILY_TOKEN_LIMIT: z.preprocess(emptyStringToUndefined, z.coerce.number().int().positive().optional()),
  AI_PREMIUM_DAILY_TOKEN_LIMIT: z.preprocess(emptyStringToUndefined, z.coerce.number().int().positive().optional()),

  // Background AI infrastructure (Phase 20D)
  REDIS_URL: z.preprocess(emptyStringToUndefined, z.string().url().optional()),
  REDIS_QUEUE_PREFIX: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).optional()),
  AI_BACKGROUND_WORKERS_ENABLED: stringBoolean.default(true),
  AI_BACKGROUND_SCHEDULER_ENABLED: stringBoolean.default(false),
  AI_EMBEDDING_MODEL: z.preprocess(emptyStringToUndefined, z.string().optional()),
  AI_STALE_ISSUE_DAYS: z.coerce.number().int().min(1).max(180).default(7),
  AI_BACKGROUND_ASSIGNEE_CANDIDATE_LIMIT: z.coerce.number().int().min(1).max(10).default(3),

  // MCP Server — external AI transport (Phase 20E)
  TRUSSEN_MCP_API_KEY: z.preprocess(emptyStringToUndefined, z.string().optional()),
  MCP_API_KEY: z.preprocess(emptyStringToUndefined, z.string().optional()),
  TRUSSEN_MCP_SERVER_NAME: z.preprocess(
    emptyStringToUndefined,
    z.string().trim().min(1).default("Trussen MCP"),
  ),
  TRUSSEN_MCP_SERVER_VERSION: z.preprocess(
    emptyStringToUndefined,
    z.string().trim().min(1).default("1.0.0"),
  ),
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
