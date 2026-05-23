/**
 * Express Request Type Extensions
 *
 * Augments the Express Request object with custom properties that our
 * middlewares attach during the request lifecycle:
 *
 * 1. `req.user` — set by `authenticate` middleware (Phase 1)
 *    Contains the verified Clerk user ID and basic profile info.
 *
 * 2. `req.workspace` — set by `requireWorkspace` middleware (Phase 2)
 *    Contains the active workspace ID and the user's role in that workspace.
 *
 * These are optional (?) because not all routes go through all middlewares.
 * For example, GET /health has neither. But once a middleware sets them,
 * downstream controllers can safely access them.
 */

import type { WorkspaceRole } from "../../app/generated/prisma/client.js";

declare global {
  namespace Express {
    interface Request {
      /** Authenticated user info — set by `authenticate` middleware */
      user?: {
        id: string; // Clerk user_id (primary key in our User table)
        email: string;
        name: string;
      };

      /** Validated request data produced by `validate` middleware */
      validated?: {
        body?: unknown;
        params?: unknown;
        query?: unknown;
      };

      /** Active workspace context — set by `requireWorkspace` middleware */
      workspace?: {
        id: string; // Workspace UUID
        role: WorkspaceRole; // User's role in this workspace (OWNER, ADMIN, MEMBER, GUEST)
      };
    }
  }
}
