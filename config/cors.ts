/**
 * CORS Configuration
 *
 * Controls which origins can call our API.
 * Every company workspace is its own subdomain (<slug>.trussen.app), so in
 * production this allows the bare root domain AND any subdomain of it over
 * HTTPS — not just one fixed FRONTEND_URL string. In development it also
 * allows localhost/127.0.0.1 (and *.localhost, for testing subdomains
 * locally), local network IPs, and ngrok tunnels.
 *
 * Credentials are enabled so the browser sends cookies (Clerk session tokens).
 */

import type { CorsOptions } from "cors";
import { env } from "./env.js";
import { isAllowedFrontendOrigin } from "../shared/utils/allowed-origin.js";

export const corsConfig: CorsOptions = {
  origin: (origin, callback) => {
    callback(null, isAllowedFrontendOrigin(origin, env.NODE_ENV));
  },

  // Allow cookies/auth headers to be sent cross-origin (required for Clerk sessions)
  credentials: true,

  // HTTP methods our API supports
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

  // Headers the client is allowed to send
  allowedHeaders: ["Content-Type", "Authorization", "X-Workspace-Id","ngrok-skip-browser-warning"],

  // Headers the browser is allowed to let JS read from the response.
  // WWW-Authenticate carries the OAuth discovery URL on a 401 — without this,
  // browser-based MCP clients (Claude.ai web, etc.) can't see it and can't
  // discover OAuth at all, even though the header is sent correctly. CLI
  // clients (curl, Claude Code) aren't affected — CORS is a browser-only
  // restriction — which is why this didn't show up in local testing.
  exposedHeaders: ["WWW-Authenticate"],
};
