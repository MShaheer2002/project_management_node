/**
 * OpenAPI 3.1 Specification for Linearis API
 *
 * This is the MASTER spec file that assembles all route documentation.
 * Only IMPLEMENTED endpoints appear here — as each phase is built,
 * its paths and schemas are imported and merged.
 *
 * Structure:
 *   - Base spec (info, servers, security) lives here
 *   - Each phase exports its own paths + schemas from docs/api/paths/
 *   - This file merges them together
 *
 * Rule: If a route doesn't exist in the codebase, it doesn't exist in Swagger.
 */

// ─── Phase-specific path imports (uncomment as phases are built) ─────────────
// import { authPaths, authSchemas } from "./paths/auth.js";
// import { workspacePaths, workspaceSchemas } from "./paths/workspace.js";
// import { departmentPaths, departmentSchemas } from "./paths/department.js";
// import { teamPaths, teamSchemas } from "./paths/team.js";
// import { projectPaths, projectSchemas } from "./paths/project.js";
// import { issuePaths, issueSchemas } from "./paths/issue.js";
// import { commentPaths, commentSchemas } from "./paths/comment.js";
// import { labelPaths, labelSchemas } from "./paths/label.js";
// import { activityPaths, activitySchemas } from "./paths/activity.js";
// import { notificationPaths, notificationSchemas } from "./paths/notification.js";
// import { cyclePaths, cycleSchemas } from "./paths/cycle.js";
// import { templatePaths, templateSchemas } from "./paths/template.js";
// import { apiKeyPaths, apiKeySchemas } from "./paths/api-key.js";
// import { integrationPaths, integrationSchemas } from "./paths/integration.js";
// import { billingPaths, billingSchemas } from "./paths/billing.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const openApiSpec: Record<string, any> = {
  openapi: "3.1.0",
  info: {
    title: "Linearis API",
    version: "0.1.0",
    description:
      "Backend API for Linearis — a SaaS project management platform. All endpoints (except health and webhooks) require authentication via Clerk session tokens. This spec only shows IMPLEMENTED endpoints.",
    contact: {
      name: "Linearis Team",
    },
  },

  servers: [
    {
      url: "http://localhost:8000",
      description: "Local development",
    },
  ],

  // Only tags for implemented phases appear here
  tags: [
    { name: "Health", description: "Server status and connectivity checks" },
  ],

  // ─── Paths: Only implemented routes ──────────────────────────────────────────
  paths: {
    // ═══════════════════════════════════════════════════════════════════════════
    // HEALTH (Phase 0) — implemented
    // ═══════════════════════════════════════════════════════════════════════════
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Server health check",
        description:
          "Returns server status and database connectivity. Not authenticated — used by load balancers and uptime monitors.",
        responses: {
          "200": {
            description: "Server is healthy",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/HealthResponse",
                },
                example: {
                  success: true,
                  data: {
                    status: "ok",
                    db: "connected",
                    uptime: 120,
                  },
                },
              },
            },
          },
          "500": {
            description: "Server or database is unhealthy",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },

    // As phases are built, spread their paths here:
    // ...authPaths,
    // ...workspacePaths,
    // ...departmentPaths,
    // ...teamPaths,
    // ...projectPaths,
    // ...issuePaths,
    // ...commentPaths,
    // ...labelPaths,
    // ...activityPaths,
    // ...notificationPaths,
    // ...cyclePaths,
    // ...templatePaths,
    // ...apiKeyPaths,
    // ...integrationPaths,
    // ...billingPaths,
  },

  // ─── Components ─────────────────────────────────────────────────────────────
  components: {
    securitySchemes: {
      clerkAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "Clerk session token. Sent as Authorization: Bearer <token> or via __session cookie.",
      },
    },

    // Reusable parameters — added as needed per phase
    parameters: {
      WorkspaceId: {
        name: "workspaceId",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
        description: "Workspace UUID",
      },
      XWorkspaceId: {
        name: "X-Workspace-Id",
        in: "header",
        required: true,
        schema: { type: "string", format: "uuid" },
        description:
          "Active workspace ID (sent as header for non-path routes)",
      },
      Cursor: {
        name: "cursor",
        in: "query",
        schema: { type: "string" },
        description: "Cursor for pagination (ID of last item)",
      },
      Limit: {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        description: "Number of items per page (max 100)",
      },
    },

    // Schemas — base response formats + phase-specific schemas merged in
    schemas: {
      // ── Standard response wrappers (used by every endpoint) ──
      ErrorResponse: {
        type: "object",
        required: ["success", "error"],
        properties: {
          success: { type: "boolean", const: false },
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { type: "string", example: "NOT_FOUND" },
              message: {
                type: "string",
                example: "Resource not found",
              },
            },
          },
        },
      },
      ValidationErrorResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", const: false },
          error: {
            type: "object",
            properties: {
              code: { type: "string", const: "VALIDATION_ERROR" },
              message: { type: "string" },
              details: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    field: { type: "string" },
                    message: { type: "string" },
                    location: {
                      type: "string",
                      enum: ["body", "params", "query"],
                    },
                  },
                },
              },
            },
          },
        },
      },
      PaginationMeta: {
        type: "object",
        required: ["total", "hasMore"],
        properties: {
          total: { type: "integer" },
          cursor: { type: "string" },
          hasMore: { type: "boolean" },
        },
      },

      // ── Phase 0: Health ──
      HealthResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", const: true },
          data: {
            type: "object",
            properties: {
              status: { type: "string", const: "ok" },
              db: { type: "string", const: "connected" },
              uptime: {
                type: "integer",
                description: "Server uptime in seconds",
              },
            },
          },
        },
      },

      // As phases are built, spread their schemas here:
      // ...authSchemas,
      // ...workspaceSchemas,
      // ...departmentSchemas,
      // ...teamSchemas,
      // ...projectSchemas,
      // ...issueSchemas,
      // ...commentSchemas,
      // ...labelSchemas,
      // ...activitySchemas,
      // ...notificationSchemas,
      // ...cycleSchemas,
      // ...templateSchemas,
      // ...apiKeySchemas,
      // ...integrationSchemas,
      // ...billingSchemas,
    },
  },
};
