/**
 * OpenAPI Paths — Upload Module
 *
 * Defines API documentation for S3 presigned upload URL generation.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const uploadPaths: Record<string, any> = {
  "/uploads/presigned-url": {
    post: {
      tags: ["Uploads"],
      summary: "Create one presigned upload URL",
      description:
        "Returns a presigned S3 PUT URL for a single image or video upload. Requires authentication and an active workspace via X-Workspace-Id.",
      security: [{ clerkAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/XWorkspaceId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/PresignedUploadInput" },
            example: {
              fileName: "logo.png",
              contentType: "image/png",
              size: 245678,
              kind: "workspace-logo",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Presigned upload URL created",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SuccessResponse_PresignedUpload" },
              example: {
                success: true,
                data: {
                  uploadUrl: "https://bucket.s3.amazonaws.com/...",
                  method: "PUT",
                  headers: {
                    "Content-Type": "image/png",
                  },
                  key: "uploads/workspaces/uuid/workspace-logo/2026/05/file.png",
                  expiresIn: 900,
                  assetUrl: null,
                },
              },
            },
          },
        },
        "401": { description: "Authentication required" },
        "403": { description: "User is not allowed to upload in this workspace" },
        "422": {
          description: "Validation error or upload policy error",
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  { $ref: "#/components/schemas/ValidationErrorResponse" },
                  { $ref: "#/components/schemas/ErrorResponse" },
                ],
              },
            },
          },
        },
        "429": { description: "Too many requests" },
      },
    },
  },

  "/uploads/presigned-urls": {
    post: {
      tags: ["Uploads"],
      summary: "Create multiple presigned upload URLs",
      description:
        "Returns one presigned S3 PUT URL per requested file. This is for multiple separate files, not multipart upload for one large file.",
      security: [{ clerkAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/XWorkspaceId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/PresignedUploadBatchInput" },
            example: {
              files: [
                {
                  clientId: "image-1",
                  fileName: "attachment.png",
                  contentType: "image/png",
                  size: 245678,
                  kind: "attachment",
                },
                {
                  clientId: "video-1",
                  fileName: "demo.mp4",
                  contentType: "video/mp4",
                  size: 1024000,
                  kind: "video",
                },
              ],
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Presigned upload URLs created",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SuccessResponse_PresignedUploadBatch" },
            },
          },
        },
        "401": { description: "Authentication required" },
        "403": { description: "User is not allowed to upload in this workspace" },
        "422": {
          description: "Validation error or upload policy error",
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  { $ref: "#/components/schemas/ValidationErrorResponse" },
                  { $ref: "#/components/schemas/ErrorResponse" },
                ],
              },
            },
          },
        },
        "429": { description: "Too many requests" },
      },
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const uploadSchemas: Record<string, any> = {
  UploadKind: {
    type: "string",
    enum: ["workspace-logo", "avatar", "attachment", "video"],
  },
  PresignedUploadInput: {
    type: "object",
    required: ["fileName", "contentType", "size", "kind"],
    properties: {
      fileName: { type: "string", maxLength: 255 },
      contentType: { type: "string", maxLength: 100 },
      size: { type: "integer", minimum: 1 },
      kind: { $ref: "#/components/schemas/UploadKind" },
    },
  },
  PresignedUploadBatchFile: {
    allOf: [
      { $ref: "#/components/schemas/PresignedUploadInput" },
      {
        type: "object",
        properties: {
          clientId: { type: "string", nullable: true, maxLength: 100 },
        },
      },
    ],
  },
  PresignedUploadBatchInput: {
    type: "object",
    required: ["files"],
    properties: {
      files: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: { $ref: "#/components/schemas/PresignedUploadBatchFile" },
      },
    },
  },
  PresignedUploadResponseItem: {
    type: "object",
    properties: {
      uploadUrl: { type: "string", format: "uri" },
      method: { type: "string", enum: ["PUT"] },
      headers: {
        type: "object",
        properties: {
          "Content-Type": { type: "string" },
        },
      },
      key: { type: "string" },
      expiresIn: { type: "integer" },
      assetUrl: { type: "string", format: "uri", nullable: true },
    },
  },
  SuccessResponse_PresignedUpload: {
    type: "object",
    properties: {
      success: { type: "boolean", const: true },
      data: { $ref: "#/components/schemas/PresignedUploadResponseItem" },
    },
  },
  SuccessResponse_PresignedUploadBatch: {
    type: "object",
    properties: {
      success: { type: "boolean", const: true },
      data: {
        type: "object",
        properties: {
          uploads: {
            type: "array",
            items: {
              allOf: [
                { $ref: "#/components/schemas/PresignedUploadResponseItem" },
                {
                  type: "object",
                  properties: {
                    clientId: { type: "string", nullable: true },
                  },
                },
              ],
            },
          },
        },
      },
    },
  },
};
