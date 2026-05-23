/**
 * OpenAPI Paths — Sidebar Module
 *
 * Defines API documentation for the authenticated app shell/sidebar endpoint.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sidebarPaths: Record<string, any> = {
  "/sidebar": {
    get: {
      tags: ["Sidebar"],
      summary: "Get sidebar data",
      description:
        "Returns authenticated app shell data: current user, workspace switcher entries, active workspace, user teams, sidebar badge counts, and permission flags.",
      security: [{ clerkAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/XWorkspaceId" }],
      responses: {
        "200": {
          description: "Sidebar aggregate",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SuccessResponse_Sidebar" },
              example: {
                success: true,
                data: {
                  user: {
                    id: "user_2x...",
                    name: "Shaheer Qureshi",
                    email: "shaheer@example.com",
                    avatar: null,
                    role: "OWNER",
                  },
                  workspaces: [
                    {
                      id: "uuid",
                      name: "abcd",
                      slug: "abcd",
                      logo: null,
                      role: "OWNER",
                      active: true,
                    },
                  ],
                  activeWorkspace: {
                    id: "uuid",
                    name: "abcd",
                    slug: "abcd",
                    logo: null,
                    role: "OWNER",
                  },
                  badges: {
                    inbox: 3,
                    myIssues: 0,
                    pendingInvitations: 0,
                  },
                  teams: [],
                  permissions: {
                    canCreateIssue: true,
                    canInviteMembers: true,
                    canManageSettings: true,
                    canDeleteWorkspace: true,
                  },
                },
              },
            },
          },
        },
        "400": { description: "Missing X-Workspace-Id header" },
        "401": { description: "Authentication required" },
        "403": { description: "User is not a member of the workspace" },
      },
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sidebarSchemas: Record<string, any> = {
  SidebarUser: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      email: { type: "string", format: "email" },
      avatar: { type: "string", nullable: true },
      role: { type: "string", enum: ["OWNER", "ADMIN", "MEMBER", "GUEST"] },
    },
  },
  SidebarTeam: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      departmentId: { type: "string", format: "uuid", nullable: true },
      leadId: { type: "string" },
      department: { type: "object", nullable: true },
      counts: {
        type: "object",
        properties: {
          projects: { type: "integer" },
          issues: { type: "integer" },
          members: { type: "integer" },
        },
      },
    },
  },
  SidebarBadges: {
    type: "object",
    properties: {
      inbox: { type: "integer" },
      myIssues: { type: "integer" },
      pendingInvitations: { type: "integer" },
    },
  },
  SidebarPermissions: {
    type: "object",
    properties: {
      canCreateIssue: { type: "boolean" },
      canCreateProject: { type: "boolean" },
      canCreateTeam: { type: "boolean" },
      canInviteMembers: { type: "boolean" },
      canManageSettings: { type: "boolean" },
      canManageBilling: { type: "boolean" },
      canManageApiKeys: { type: "boolean" },
      canManageTemplates: { type: "boolean" },
      canDeleteWorkspace: { type: "boolean" },
    },
  },
  SuccessResponse_Sidebar: {
    type: "object",
    properties: {
      success: { type: "boolean", const: true },
      data: {
        type: "object",
        properties: {
          user: { $ref: "#/components/schemas/SidebarUser" },
          workspaces: {
            type: "array",
            items: {
              allOf: [
                { $ref: "#/components/schemas/Workspace" },
                {
                  type: "object",
                  properties: {
                    role: { type: "string", enum: ["OWNER", "ADMIN", "MEMBER", "GUEST"] },
                    active: { type: "boolean" },
                    joinedAt: { type: "string", format: "date-time" },
                  },
                },
              ],
            },
          },
          activeWorkspace: {
            allOf: [
              { $ref: "#/components/schemas/Workspace" },
              {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["OWNER", "ADMIN", "MEMBER", "GUEST"] },
                },
              },
            ],
          },
          badges: { $ref: "#/components/schemas/SidebarBadges" },
          teams: {
            type: "array",
            items: { $ref: "#/components/schemas/SidebarTeam" },
          },
          permissions: { $ref: "#/components/schemas/SidebarPermissions" },
        },
      },
    },
  },
};
