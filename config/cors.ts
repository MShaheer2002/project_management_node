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
  // In development: allow localhost, local IP, and ngrok origins
  // In production: only the configured FRONTEND_URL
  origin:
    env.NODE_ENV === "development"
      ? (origin, callback) => {
          // Allow requests with no origin (curl, Postman, server-to-server)
          if (!origin) return callback(null, true);

          const allowed =
            origin.startsWith("http://localhost:") ||
            origin.startsWith("http://127.0.0.1:") ||
            origin.match(/^http:\/\/192\.168\.\d+\.\d+:\d+$/) || // Local network IPs
            origin.endsWith(".ngrok-free.dev") || // ngrok tunnels
            origin === env.FRONTEND_URL;

          callback(null, !!allowed);
        }
      : env.FRONTEND_URL,

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
