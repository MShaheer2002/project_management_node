/**
 * OpenAPI Paths — Auth Module (Phase 1)
 *
 * Defines the API documentation for auth-related endpoints:
 *   - POST /webhooks/clerk (webhook receiver)
 *   - GET /me (authenticated user profile)
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const authPaths: Record<string, any> = {
  "/webhooks/clerk": {
    post: {
      tags: ["Auth"],
      summary: "Clerk webhook receiver",
      description:
        "Receives user.created, user.updated, and user.deleted events from Clerk. Verifies webhook signature using CLERK_WEBHOOK_SECRET via svix. NOT behind auth middleware — Clerk calls this directly.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["user.created", "user.updated", "user.deleted"],
                  description: "Clerk event type",
                },
                data: {
                  type: "object",
                  description: "Event payload (user data)",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Webhook processed successfully",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true },
                  data: {
                    type: "object",
                    properties: {
                      received: { type: "boolean", const: true },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "Invalid webhook signature or missing svix headers",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
              example: {
                success: false,
                error: {
                  code: "INVALID_WEBHOOK_SIGNATURE",
                  message: "Invalid webhook signature",
                },
              },
            },
          },
        },
      },
    },
  },

  "/me": {
    get: {
      tags: ["Auth"],
      summary: "Get authenticated user profile",
      description:
        "Returns the current user's profile from our database. Requires a valid Clerk session token in the Authorization header.",
      security: [{ clerkAuth: [] }],
      responses: {
        "200": {
          description: "User profile",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SuccessResponse_User" },
              example: {
                success: true,
                data: {
                  id: "user_2x1abc123",
                  email: "john@example.com",
                  name: "John Doe",
                  avatar: "https://img.clerk.com/abc123",
                  lastActiveAt: "2026-05-16T08:30:00.000Z",
                  createdAt: "2026-05-10T12:00:00.000Z",
                },
              },
            },
          },
        },
        "401": {
          description: "No token or invalid/expired token",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
              example: {
                success: false,
                error: {
                  code: "UNAUTHORIZED",
                  message: "Authentication required",
                },
              },
            },
          },
        },
        "403": {
          description: "Valid token but user not synced to DB yet (webhook race condition)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
              example: {
                success: false,
                error: {
                  code: "USER_NOT_SYNCED",
                  message: "User not synced yet. Please try again in a moment.",
                },
              },
            },
          },
        },
      },
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const authSchemas: Record<string, any> = {
  User: {
    type: "object",
    properties: {
      id: { type: "string", description: "Clerk user_id (e.g., user_2x...)" },
      email: { type: "string", format: "email" },
      name: { type: "string" },
      avatar: { type: "string", nullable: true, description: "URL to profile picture" },
      lastActiveAt: { type: "string", format: "date-time", nullable: true },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "email", "name", "createdAt"],
  },
  SuccessResponse_User: {
    type: "object",
    properties: {
      success: { type: "boolean", const: true },
      data: { $ref: "#/components/schemas/User" },
    },
  },
};
