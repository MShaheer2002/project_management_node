/**
 * OpenAPI Paths — Dashboard Module
 *
 * Defines API documentation for the dashboard aggregate endpoint.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const dashboardPaths: Record<string, any> = {
  "/dashboard": {
    get: {
      tags: ["Dashboard"],
      summary: "Get dashboard data",
      description:
        "Returns the aggregate data needed to render the dashboard after signup/login. Requires an active workspace via X-Workspace-Id.",
      security: [{ clerkAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/XWorkspaceId" }],
      responses: {
        "200": {
          description: "Dashboard aggregate",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SuccessResponse_Dashboard" },
              example: {
                success: true,
                data: {
                  workspace: {
                    id: "uuid",
                    name: "Acme Corp",
                    slug: "acme",
                    logo: null,
                    teamSize: "SMALL",
                  },
                  stats: {
                    issuesCompleted: 0,
                    activeProjects: 0,
                    teamMembers: 1,
                    openIssues: 0,
                    unreadNotifications: 0,
                  },
                  charts: {
                    velocity: [
                      { date: "2026-05-19T00:00:00.000Z", label: "Tue", completed: 0, opened: 0 },
                    ],
                    sprintProgress: [
                      { date: "2026-05-19T00:00:00.000Z", label: "Tue", open: 0 },
                    ],
                  },
                  assignedToMe: [],
                  activeProjects: [],
                  upcomingDeadlines: [],
                  teamActivity: [],
                },
              },
            },
          },
        },
        "401": { description: "Authentication required" },
        "403": { description: "User is not a member of the workspace" },
      },
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const dashboardSchemas: Record<string, any> = {
  DashboardStats: {
    type: "object",
    properties: {
      issuesCompleted: { type: "integer" },
      activeProjects: { type: "integer" },
      teamMembers: { type: "integer" },
      openIssues: { type: "integer" },
      unreadNotifications: { type: "integer" },
    },
  },
  DashboardChartPoint: {
    type: "object",
    properties: {
      date: { type: "string", format: "date-time" },
      label: { type: "string" },
      completed: { type: "integer" },
      opened: { type: "integer" },
      open: { type: "integer" },
    },
  },
  DashboardIssueSummary: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      type: { type: "string", enum: ["TASK", "BUG", "ISSUE"] },
      status: { type: "string", enum: ["BACKLOG", "TODO", "IN_PROGRESS", "REVIEW", "DONE"] },
      priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "URGENT"] },
      dueDate: { type: "string", format: "date", nullable: true },
      dueTime: { type: "string", nullable: true },
      project: { type: "object" },
      assignee: { type: "object", nullable: true },
    },
  },
  DashboardProjectSummary: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      description: { type: "string", nullable: true },
      status: { type: "string", enum: ["ACTIVE", "ARCHIVED", "COMPLETED"] },
      issueCount: { type: "integer" },
      completedIssueCount: { type: "integer" },
      progress: { type: "integer", minimum: 0, maximum: 100 },
    },
  },
  SuccessResponse_Dashboard: {
    type: "object",
    properties: {
      success: { type: "boolean", const: true },
      data: {
        type: "object",
        properties: {
          workspace: { $ref: "#/components/schemas/Workspace" },
          stats: { $ref: "#/components/schemas/DashboardStats" },
          charts: {
            type: "object",
            properties: {
              velocity: {
                type: "array",
                items: { $ref: "#/components/schemas/DashboardChartPoint" },
              },
              sprintProgress: {
                type: "array",
                items: { $ref: "#/components/schemas/DashboardChartPoint" },
              },
            },
          },
          assignedToMe: {
            type: "array",
            items: { $ref: "#/components/schemas/DashboardIssueSummary" },
          },
          activeProjects: {
            type: "array",
            items: { $ref: "#/components/schemas/DashboardProjectSummary" },
          },
          upcomingDeadlines: {
            type: "array",
            items: { $ref: "#/components/schemas/DashboardIssueSummary" },
          },
          teamActivity: { type: "array", items: { type: "object" } },
        },
      },
    },
  },
};
