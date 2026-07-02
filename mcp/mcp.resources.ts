import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executeTool } from "../modules/ai/tools/tool-executor.js";
import { logAiError, logAiInfo } from "../modules/ai/ai.observability.js";
import { recordAiConnectionSessionStep } from "../modules/ai-connection/ai-connection.service.js";
import type { McpSessionContext } from "./mcp.auth.js";

function stringifyResource(payload: unknown) {
  return JSON.stringify(payload, null, 2);
}

function getVariable(variables: Record<string, string | string[]>, key: string) {
  const value = variables[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? "";
  return "";
}

async function readResourceThroughTool(input: {
  session: McpSessionContext;
  toolName: string;
  args: Record<string, unknown>;
  resourceUri: string;
}) {
  const result = await executeTool(input.toolName, input.args, {
    workspaceId: input.session.workspaceId,
    userId: input.session.userId,
    userRole: input.session.userRole,
  });

  if (!result.success) {
    if (input.session.sessionId) {
      await recordAiConnectionSessionStep({
        sessionId: input.session.sessionId,
        toolName: input.toolName,
        success: false,
        errorMessage: result.error ?? "Resource resolution failed",
      });
    }

    logAiError("mcp_resource_failed", {
      workspaceId: input.session.workspaceId,
      userId: input.session.userId,
      feature: "mcp",
      toolName: input.toolName,
      success: false,
      errorMessage: result.error ?? "Resource resolution failed",
      metadata: { resourceUri: input.resourceUri },
    });

    return {
      contents: [
        {
          uri: input.resourceUri,
          mimeType: "application/json",
          text: stringifyResource({
            success: false,
            error: result.error ?? "Resource resolution failed",
            warnings: result.warnings,
          }),
        },
      ],
    };
  }

  if (input.session.sessionId) {
    await recordAiConnectionSessionStep({
      sessionId: input.session.sessionId,
      toolName: input.toolName,
      success: true,
    });
  }

  logAiInfo("mcp_resource_read", {
    workspaceId: input.session.workspaceId,
    userId: input.session.userId,
    feature: "mcp",
    toolName: input.toolName,
    success: true,
    metadata: { resourceUri: input.resourceUri },
  });

  return {
    contents: [
      {
        uri: input.resourceUri,
        mimeType: "application/json",
        text: stringifyResource({
          success: true,
          payload: result.payload,
          warnings: result.warnings,
          nextSuggestions: result.nextSuggestions,
          ...(result.meta ? { meta: result.meta } : {}),
        }),
      },
    ],
  };
}

export function registerMcpResources(server: McpServer, session: McpSessionContext) {
  server.registerResource(
    "workspace-summary",
    "trussen://workspace",
    {
      title: "Workspace Summary",
      description: "Workspace-wide analytics and health summary for the authenticated Trussen workspace.",
      mimeType: "application/json",
    },
    async (uri) =>
      readResourceThroughTool({
        session,
        toolName: "get_workspace_analytics",
        args: { period: "30d" },
        resourceUri: uri.toString(),
      }),
  );

  server.registerResource(
    "current-cycle",
    "trussen://cycles/current",
    {
      title: "Current Cycles",
      description: "Current cycle list for the authenticated workspace.",
      mimeType: "application/json",
    },
    async (uri) =>
      readResourceThroughTool({
        session,
        toolName: "list_cycles",
        args: { status: "CURRENT" },
        resourceUri: uri.toString(),
      }),
  );

  server.registerResource(
    "issue-detail",
    new ResourceTemplate("trussen://issues/{issueId}", { list: undefined }),
    {
      title: "Issue Detail",
      description: "Full issue detail for a Trussen issue key or ID.",
      mimeType: "application/json",
    },
    async (uri, variables) =>
      readResourceThroughTool({
        session,
        toolName: "get_issue",
        args: { issueId: getVariable(variables, "issueId") },
        resourceUri: uri.toString(),
      }),
  );

  server.registerResource(
    "project-summary",
    new ResourceTemplate("trussen://projects/{projectId}", { list: undefined }),
    {
      title: "Project Summary",
      description: "Project summary with issue counts and status breakdown.",
      mimeType: "application/json",
    },
    async (uri, variables) =>
      readResourceThroughTool({
        session,
        toolName: "get_project_summary",
        args: { projectId: getVariable(variables, "projectId") },
        resourceUri: uri.toString(),
      }),
  );

  server.registerResource(
    "project-analytics",
    new ResourceTemplate("trussen://projects/{projectId}/analytics", { list: undefined }),
    {
      title: "Project Analytics",
      description: "Project analytics for delivery, timeline health, workload, and status trends.",
      mimeType: "application/json",
    },
    async (uri, variables) =>
      readResourceThroughTool({
        session,
        toolName: "get_project_analytics",
        args: { projectId: getVariable(variables, "projectId"), period: "30d" },
        resourceUri: uri.toString(),
      }),
  );
}
