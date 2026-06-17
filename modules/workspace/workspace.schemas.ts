/**
 * Workspace Module — Zod Schemas
 *
 * Validation schemas for all workspace-related requests.
 * These are the single source of truth for input validation AND TypeScript types.
 *
 * Slug rules:
 *   - Lowercase letters, numbers, hyphens only
 *   - Cannot start or end with a hyphen
 *   - 3-50 characters
 *   - Must not be a reserved word (api, admin, www, etc.)
 */

import { z } from "zod/v4";

// ─── Reserved Slugs ──────────────────────────────────────────────────────────
// These cannot be used as workspace URLs to avoid conflicts with system routes

const RESERVED_SLUGS = [
  "api",
  "app",
  "admin",
  "www",
  "mail",
  "help",
  "support",
  "billing",
  "status",
  "docs",
  "blog",
  "login",
  "signup",
  "auth",
  "oauth",
  "sso",
  "webhook",
  "webhooks",
  "settings",
  "dashboard",
  "onboarding",
] as const;

// ─── Shared Validators ──────────────────────────────────────────────────────

const slugSchema = z
  .string()
  .min(3, "Slug must be at least 3 characters")
  .max(50, "Slug must be at most 50 characters")
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
    "Slug must be lowercase letters, numbers, and hyphens. Cannot start or end with a hyphen.",
  )
  .refine((slug) => !RESERVED_SLUGS.includes(slug as any), {
    message: "This URL is reserved. Please choose a different one.",
  });

const teamSizeSchema = z.enum(["SMALL", "MEDIUM", "LARGE", "ENTERPRISE"]);
const memberListSortSchema = z.enum(["name:asc", "name:desc", "joinedAt:asc", "joinedAt:desc"]);
const memberListViewSchema = z.enum(["compact", "full"]);

// ─── Request Schemas ─────────────────────────────────────────────────────────

/** POST /workspaces — Create a new workspace */
export const createWorkspaceSchema = {
  body: z.object({
    name: z
      .string()
      .min(1, "Organization name is required")
      .max(100, "Organization name must be at most 100 characters")
      .trim(),
    slug: slugSchema,
    teamSize: teamSizeSchema.optional(),
    issuePrefix: z
      .string()
      .min(2, "Issue prefix must be at least 2 characters")
      .max(5, "Issue prefix must be at most 5 characters")
      .regex(/^[A-Z]+$/, "Issue prefix must be uppercase letters only")
      .optional(),
  }),
};

/** PATCH /workspaces/:workspaceId — Update workspace settings */
export const updateWorkspaceSchema = {
  body: z.object({
    name: z
      .string()
      .min(1, "Organization name is required")
      .max(100, "Organization name must be at most 100 characters")
      .trim()
      .optional(),
    logo: z.string().url("Logo must be a valid URL").nullable().optional(),
  }),
  params: z.object({
    workspaceId: z.string().uuid("Invalid workspace ID"),
  }),
};

/** GET/DELETE /workspaces/:workspaceId — Workspace ID param validation */
export const workspaceIdParamSchema = {
  params: z.object({
    workspaceId: z.string().uuid("Invalid workspace ID"),
  }),
};

/** GET /workspaces/check-slug/:slug — Slug availability check */
export const checkSlugSchema = {
  params: z.object({
    slug: slugSchema,
  }),
};

/** POST /workspaces/:workspaceId/invitations — Send invitation */
export const inviteMemberSchema = {
  params: z.object({
    workspaceId: z.string().uuid("Invalid workspace ID"),
  }),
  body: z.object({
    email: z.string().email("Invalid email address"),
    role: z.enum(["ADMIN", "MEMBER", "GUEST"], {
      message: "Role must be ADMIN, MEMBER, or GUEST. Cannot invite as OWNER.",
    }),
    teamId: z.string().uuid("Invalid team ID"),
    departmentId: z.string().uuid("Invalid department ID").optional(),
  }),
};

/** PATCH /workspaces/:workspaceId/members/:userId — Change member role */
export const changeMemberRoleSchema = {
  params: z.object({
    workspaceId: z.string().uuid("Invalid workspace ID"),
    userId: z.string().min(1, "User ID is required"),
  }),
  body: z.object({
    role: z.enum(["ADMIN", "MEMBER", "GUEST"], {
      message: "Role must be ADMIN, MEMBER, or GUEST. Cannot assign OWNER.",
    }),
  }),
};

/** DELETE /workspaces/:workspaceId/members/:userId — Remove member */
export const removeMemberSchema = {
  params: z.object({
    workspaceId: z.string().uuid("Invalid workspace ID"),
    userId: z.string().min(1, "User ID is required"),
  }),
};

/** GET /workspaces/:workspaceId/members — List/search workspace members */
export const listWorkspaceMembersSchema = {
  params: z.object({
    workspaceId: z.string().uuid("Invalid workspace ID"),
  }),
  query: z.object({
    q: z.string().trim().max(100).optional(),
    cursor: z.string().min(1, "Invalid cursor").optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sort: memberListSortSchema.optional(),
    role: z.enum(["OWNER", "ADMIN", "MEMBER", "GUEST"]).optional(),
    view: memberListViewSchema.optional(),
  }),
};

/** GET /invitations/resolve?t=<token> — Resolve an invite token (public) */
export const resolveInvitationSchema = {
  query: z.object({
    t: z.string().min(1, "Token is required"),
  }),
};

/** POST /invitations/accept — Accept an invitation (authenticated) */
export const acceptInvitationSchema = {
  body: z.object({
    token: z.string().min(1, "Token is required"),
  }),
};

/** GET /workspaces/:workspaceId/statuses — Get workspace statuses */
export const getWorkspaceStatusesSchema = {
  params: z.object({
    workspaceId: z.string().uuid("Invalid workspace ID"),
  }),
};

/** PUT /workspaces/:workspaceId/statuses — Replace workspace statuses */
const workspaceStatusItemSchema = z.object({
  key: z.string().min(1).max(50),
  label: z.string().min(1).max(50),
  color: z.string().min(4).max(9),
  order: z.number().int().min(0),
  isFinal: z.boolean(),
});

export const updateWorkspaceStatusesSchema = {
  params: z.object({
    workspaceId: z.string().uuid("Invalid workspace ID"),
  }),
  body: z.array(workspaceStatusItemSchema).min(1).max(20),
};

/** DELETE /workspaces/:workspaceId/invitations/:invitationId — Revoke invite */
export const revokeInvitationSchema = {
  params: z.object({
    workspaceId: z.string().uuid("Invalid workspace ID"),
    invitationId: z.string().uuid("Invalid invitation ID"),
  }),
};

// ─── Inferred Types ──────────────────────────────────────────────────────────

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema.body>;
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema.body>;
export type UpdateWorkspaceStatusesInput = z.infer<typeof updateWorkspaceStatusesSchema.body>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema.body>;
export type ChangeMemberRoleInput = z.infer<typeof changeMemberRoleSchema.body>;
export type ListWorkspaceMembersQuery = z.infer<typeof listWorkspaceMembersSchema.query>;
