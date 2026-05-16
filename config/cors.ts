/**
 * CORS Configuration
 *
 * Controls which origins can call our API.
 * In development: allows the local frontend (http://localhost:3000).
 * In production: only the configured FRONTEND_URL is allowed.
 *
 * Credentials are enabled so the browser sends cookies (Clerk session tokens).
 */

import type { CorsOptions } from "cors";
import { env } from "./env.js";

export const corsConfig: CorsOptions = {
  // Only allow requests from our frontend
  origin: env.FRONTEND_URL,

  // Allow cookies/auth headers to be sent cross-origin (required for Clerk sessions)
  credentials: true,

  // HTTP methods our API supports
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],

  // Headers the client is allowed to send
  allowedHeaders: ["Content-Type", "Authorization", "X-Workspace-Id"],
};
