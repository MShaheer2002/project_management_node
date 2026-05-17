/**
 * OpenAPI Paths — Workspace Module (Phase 2)
 *
 * Defines API documentation for workspace CRUD and membership management.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const workspacePaths: Record<string, any> = {
  "/workspaces": {
    post: {
      tags: ["Workspaces"],
      summary: "Create workspace",
      description: "Creates a new workspace. The authenticated user becomes the OWNER automatically. A WorkspaceMembership is created in the same transaction.",
      security: [{ clerkAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateWorkspaceInput" },
            example: { name: "Acme Corp", slug: "acme", teamSize: "SMALL" },
          },
        },
      },
      responses: {
        "201": {
          description: "Workspace created",
          content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessResponse_Workspace" } } },
        },
        "409": {
          description: "Slug already taken",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" }, example: { success: false, error: { code: "WORKSPACE_SLUG_TAKEN", message: "This workspace URL is already taken" } } } },
        },
        "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/ValidationErrorResponse" } } } },
      },
    },
    get: {
      tags: ["Workspaces"],
      summary: "List user's workspaces",
      description: "Returns all workspaces the authenticated user is a member of. Used by frontend to determine if onboarding is needed (empty = new user).",
      security: [{ clerkAuth: [] }],
      responses: {
        "200": {
          description: "List of workspaces with user's role in each",
          content: {
            "application/json": {
              example: { success: true, data: [{ id: "uuid", name: "Acme Corp", slug: "acme", logo: null, teamSize: "SMALL", role: "OWNER", joinedAt: "2026-05-17T00:00:00Z", createdAt: "2026-05-17T00:00:00Z" }] },
            },
          },
        },
      },
    },
  },

  "/workspaces/check-slug/{slug}": {
    get: {
      tags: ["Workspaces"],
      summary: "Check slug availability",
      description: "Returns whether a workspace URL slug is available. Use for real-time validation as user types (debounce 300ms).",
      security: [{ clerkAuth: [] }],
      parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" }, description: "Slug to check (lowercase, letters/numbers/hyphens, 3-50 chars)" }],
      responses: {
        "200": {
          description: "Availability result",
          content: { "application/json": { example: { success: true, data: { available: true } } } },
        },
        "422": { description: "Invalid slug format" },
      },
    },
  },

  "/workspaces/{workspaceId}": {
    get: {
      tags: ["Workspaces"],
      summary: "Get workspace details",
      description: "Returns workspace details with entity counts. User must be a member.",
      security: [{ clerkAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/WorkspaceId" }],
      responses: {
        "200": { description: "Workspace details with counts (members, projects, issues, teams, departments)" },
        "403": { description: "Not a member of this workspace" },
        "404": { description: "Workspace not found" },
      },
    },
    patch: {
      tags: ["Workspaces"],
      summary: "Update workspace",
      description: "Update workspace name or logo. Requires ADMIN or OWNER role. Slug cannot be changed after creation.",
      security: [{ clerkAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/WorkspaceId" }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateWorkspaceInput" } } },
      },
      responses: {
        "200": { description: "Workspace updated" },
        "403": { description: "Insufficient role (need ADMIN or OWNER)" },
      },
    },
    delete: {
      tags: ["Workspaces"],
      summary: "Delete workspace",
      description: "Permanently deletes a workspace and ALL its data. OWNER only. This cascades: departments, teams, projects, issues, comments, labels, everything.",
      security: [{ clerkAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/WorkspaceId" }],
      responses: {
        "204": { description: "Workspace deleted" },
        "403": { description: "Only OWNER can delete" },
      },
    },
  },

  "/workspaces/{workspaceId}/members": {
    get: {
      tags: ["Workspaces"],
      summary: "List workspace members",
      description: "Returns all members with their roles. Any workspace member can view.",
      security: [{ clerkAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/WorkspaceId" }],
      responses: {
        "200": {
          description: "List of members",
          content: {
            "application/json": {
              example: { success: true, data: [{ id: "user_2x...", email: "john@example.com", name: "John Doe", avatar: null, role: "OWNER", joinedAt: "2026-05-17T00:00:00Z" }] },
            },
          },
        },
      },
    },
  },

  "/workspaces/{workspaceId}/invitations": {
    post: {
      tags: ["Invitations"],
      summary: "Send invitation",
      description: "Send a workspace invitation email. If a pending invite exists for this email, it's revoked and a new one is created (clean audit trail). Requires ADMIN or OWNER.",
      security: [{ clerkAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/WorkspaceId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/InviteMemberInput" },
            example: { email: "jane@example.com", role: "MEMBER" },
          },
        },
      },
      responses: {
        "201": { description: "Invitation sent" },
        "403": { description: "Insufficient role" },
        "409": { description: "User is already a workspace member" },
      },
    },
    get: {
      tags: ["Invitations"],
      summary: "List invitations",
      description: "List all invitations (pending, accepted, expired, revoked) for a workspace. Requires ADMIN or OWNER.",
      security: [{ clerkAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/WorkspaceId" }],
      responses: {
        "200": { description: "List of invitations with status" },
      },
    },
  },

  "/workspaces/{workspaceId}/invitations/{invitationId}": {
    delete: {
      tags: ["Invitations"],
      summary: "Revoke invitation",
      description: "Cancel a pending invitation. Requires ADMIN or OWNER.",
      security: [{ clerkAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/WorkspaceId" },
        { name: "invitationId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ],
      responses: {
        "204": { description: "Invitation revoked" },
        "404": { description: "Pending invitation not found" },
      },
    },
  },

  "/invitations/resolve": {
    get: {
      tags: ["Invitations"],
      summary: "Resolve invitation token",
      description: "PUBLIC — no auth required. Validates the invite token and returns workspace name, role, and invited email. Used by the frontend to show 'You have been invited to Acme Corp' before sign-in. Rate limited.",
      parameters: [
        { name: "t", in: "query", required: true, schema: { type: "string" }, description: "Raw invitation token from the email link" },
      ],
      responses: {
        "200": {
          description: "Invitation metadata",
          content: {
            "application/json": {
              example: {
                success: true,
                data: {
                  workspaceId: "uuid",
                  workspaceName: "Acme Corp",
                  workspaceSlug: "acme",
                  workspaceLogo: null,
                  role: "MEMBER",
                  invitedEmail: "jane@example.com",
                },
              },
            },
          },
        },
        "400": { description: "Invitation expired or already accepted/revoked" },
        "404": { description: "Invalid token" },
      },
    },
  },

  "/invitations/accept": {
    post: {
      tags: ["Invitations"],
      summary: "Accept invitation",
      description: "AUTHENTICATED. Accepts a workspace invitation. The authenticated user's email MUST match the invitation email (prevents forwarded-invite abuse). Token sent in body, not URL, to avoid leaking into logs. Idempotent — double-click safe.",
      security: [{ clerkAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { type: "object", required: ["token"], properties: { token: { type: "string", description: "Raw token from the email link" } } },
          },
        },
      },
      responses: {
        "200": {
          description: "Invitation accepted, membership created",
          content: {
            "application/json": {
              example: {
                success: true,
                data: { workspaceId: "uuid", workspaceName: "Acme Corp", workspaceSlug: "acme", role: "MEMBER", alreadyAccepted: false },
              },
            },
          },
        },
        "400": { description: "Invitation expired or revoked" },
        "403": { description: "Email mismatch — invitation was sent to a different email" },
        "404": { description: "Invalid token" },
      },
    },
  },

  "/workspaces/{workspaceId}/members/{userId}": {
    patch: {
      tags: ["Workspaces"],
      summary: "Change member role",
      description: "Change a member's role. Cannot demote the OWNER. Requires ADMIN or OWNER.",
      security: [{ clerkAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/WorkspaceId" },
        { name: "userId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { example: { role: "ADMIN" } } },
      },
      responses: {
        "200": { description: "Role updated" },
        "403": { description: "Cannot demote owner / insufficient role" },
        "404": { description: "Member not found" },
      },
    },
    delete: {
      tags: ["Workspaces"],
      summary: "Remove member",
      description: "Remove a member from the workspace. Cannot remove the OWNER. Requires ADMIN or OWNER.",
      security: [{ clerkAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/WorkspaceId" },
        { name: "userId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Member removed" },
        "403": { description: "Cannot remove owner / insufficient role" },
        "404": { description: "Member not found" },
      },
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const workspaceSchemas: Record<string, any> = {
  Workspace: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      slug: { type: "string" },
      logo: { type: "string", nullable: true },
      teamSize: { type: "string", enum: ["SMALL", "MEDIUM", "LARGE", "ENTERPRISE"], nullable: true },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  SuccessResponse_Workspace: {
    type: "object",
    properties: {
      success: { type: "boolean", const: true },
      data: {
        allOf: [
          { $ref: "#/components/schemas/Workspace" },
          { type: "object", properties: { role: { type: "string", enum: ["OWNER", "ADMIN", "MEMBER", "GUEST"] } } },
        ],
      },
    },
  },
  CreateWorkspaceInput: {
    type: "object",
    required: ["name", "slug"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*[a-z0-9]$", minLength: 3, maxLength: 50, description: "URL slug — lowercase, numbers, hyphens. Cannot start/end with hyphen." },
      teamSize: { type: "string", enum: ["SMALL", "MEDIUM", "LARGE", "ENTERPRISE"] },
    },
  },
  UpdateWorkspaceInput: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      logo: { type: "string", format: "uri", nullable: true },
    },
  },
  InviteMemberInput: {
    type: "object",
    required: ["email", "role"],
    properties: {
      email: { type: "string", format: "email" },
      role: { type: "string", enum: ["ADMIN", "MEMBER", "GUEST"], description: "Cannot invite as OWNER" },
    },
  },
};
