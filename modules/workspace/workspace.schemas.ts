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
    uploadPolicy: z.enum(["BOTH", "SYSTEM_ONLY", "DRIVE_ONLY"]).optional(),
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

/** GET /workspaces/resolve/:slug — Public lookup by subdomain slug */
export const resolveBySlugSchema = {
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
    designation: z
      .string()
      .trim()
      .min(1, "Designation is required")
      .max(100, "Designation must be at most 100 characters"),
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

/** GET /workspaces/:workspaceId/statuses/:statusKey/usage — Count issues using a status */
export const getWorkspaceStatusUsageSchema = {
  params: z.object({
    workspaceId: z.string().uuid("Invalid workspace ID"),
    statusKey: z.string().min(1).max(50),
  }),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  }),
};

export const mergeWorkspaceStatusSchema = {
  params: z.object({
    workspaceId: z.string().uuid("Invalid workspace ID"),
    statusKey: z.string().min(1).max(50),
  }),
  body: z.object({
    targetStatusKey: z.string().min(1).max(50),
  }),
};

/** PUT /workspaces/:workspaceId/statuses — Replace workspace statuses */
export const workspaceStatusItemSchema = z.object({
  key: z.string().min(1).max(50),
  label: z.string().min(1).max(50),
  color: z.string().min(4).max(9),
  order: z.number().int().min(0),
  category: z.enum(["backlog", "unstarted", "active", "review", "done", "cancelled"]).default("active"),
  isActive: z.boolean().default(true),
  isFinal: z.boolean(),
  showOnBoard: z.boolean().default(true),
  visibility: z.object({
    board: z.boolean().default(true),
    list: z.boolean().default(true),
    filters: z.boolean().default(true),
    create: z.boolean().default(true),
    cycleBoard: z.boolean().default(true),
    cycleList: z.boolean().default(true),
  }).default({
    board: true,
    list: true,
    filters: true,
    create: true,
    cycleBoard: true,
    cycleList: true,
  }),
  cycle: z.object({
    allowedInCycle: z.boolean().default(true),
    countsAsCompleted: z.boolean().default(false),
    countsAsCarryOver: z.boolean().default(true),
    planIntoThisStatus: z.boolean().default(false),
  }).default({
    allowedInCycle: true,
    countsAsCompleted: false,
    countsAsCarryOver: true,
    planIntoThisStatus: false,
  }),
  transitions: z.object({
    mode: z.enum(["free", "restricted"]).default("free"),
    to: z.array(z.string().min(1).max(50)).max(20).default([]),
    allowRollback: z.boolean().default(false),
    allowedRoles: z.array(z.enum(["OWNER", "ADMIN", "MEMBER", "GUEST"])).min(1).max(4).default(["OWNER", "ADMIN", "MEMBER"]),
    allowedUserIds: z.array(z.string().min(1).max(100)).max(50).default([]),
    assigneeOnly: z.boolean().default(false),
    creatorOnly: z.boolean().default(false),
  }).default({
    mode: "free",
    to: [],
    allowRollback: false,
    allowedRoles: ["OWNER", "ADMIN", "MEMBER"],
    allowedUserIds: [],
    assigneeOnly: false,
    creatorOnly: false,
  }),
  rules: z.object({
    requireAssignee: z.boolean().default(false),
    requireDueDate: z.boolean().default(false),
    requireAllSubtasksComplete: z.boolean().default(false),
    requireAcceptanceCriteria: z.boolean().default(false),
    requireParentIssue: z.boolean().default(false),
    requireIntegrationRef: z.boolean().default(false),
  }).default({
    requireAssignee: false,
    requireDueDate: false,
    requireAllSubtasksComplete: false,
    requireAcceptanceCriteria: false,
    requireParentIssue: false,
    requireIntegrationRef: false,
  }),
  approval: z.object({
    required: z.boolean().default(false),
    requiredCount: z.number().int().min(1).max(10).default(1),
    reviewerSource: z.enum(["project_members", "team_lead", "department_head", "manual"]).default("project_members"),
    reviewerUserIds: z.array(z.string().min(1).max(100)).max(50).default([]),
  }).default({
    required: false,
    requiredCount: 1,
    reviewerSource: "project_members",
    reviewerUserIds: [],
  }),
});

export const workflowAutomationSchema = z.object({
  subtaskCompletion: z.object({
    enabled: z.boolean(),
    mode: z.enum(["suggest", "move"]),
    targetStatusKey: z.string().min(1).max(50).nullable(),
  }),
  cycleStart: z.object({
    enabled: z.boolean(),
    fromStatusKey: z.string().min(1).max(50).nullable(),
    targetStatusKey: z.string().min(1).max(50).nullable(),
  }),
  overdue: z.object({
    enabled: z.boolean(),
    action: z.enum(["notify"]),
  }),
  githubPullRequest: z.object({
    opened: z.object({
      enabled: z.boolean(),
      targetStatusKey: z.string().min(1).max(50).nullable(),
    }),
    merged: z.object({
      enabled: z.boolean(),
      targetStatusKey: z.string().min(1).max(50).nullable(),
    }),
  }),
});

export const statusRemovalResolutionSchema = z.object({
  statusKey: z.string().min(1).max(50),
  action: z.enum(["move", "delete"]),
  targetStatusKey: z.string().min(1).max(50).nullable().optional(),
});

export const updateWorkspaceStatusesSchema = {
  params: z.object({
    workspaceId: z.string().uuid("Invalid workspace ID"),
  }),
  body: z.object({
    statuses: z.array(workspaceStatusItemSchema).min(1).max(20),
    removalResolutions: z.array(statusRemovalResolutionSchema).max(20).default([]),
  }),
};

/** GET /workspaces/:workspaceId/workflow-automation — Get workflow automation config */
export const getWorkflowAutomationSchema = {
  params: z.object({
    workspaceId: z.string().uuid("Invalid workspace ID"),
  }),
};

/** PUT /workspaces/:workspaceId/workflow-automation — Replace workflow automation config */
export const updateWorkflowAutomationSchema = {
  params: z.object({
    workspaceId: z.string().uuid("Invalid workspace ID"),
  }),
  body: workflowAutomationSchema,
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
export type UpdateWorkflowAutomationInput = z.infer<typeof updateWorkflowAutomationSchema.body>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema.body>;
export type ChangeMemberRoleInput = z.infer<typeof changeMemberRoleSchema.body>;
export type ListWorkspaceMembersQuery = z.infer<typeof listWorkspaceMembersSchema.query>;
