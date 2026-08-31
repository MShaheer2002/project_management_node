import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";
import { getToolDefinitions } from "../modules/ai/tools/tool-definitions.js";
import { executeTool, type ToolExecutorResult as ExecutorResult } from "../modules/ai/tools/tool-executor.js";
import { logAiError, logAiInfo } from "../modules/ai/ai.observability.js";
import { recordAiConnectionSessionStep } from "../modules/ai-connection/ai-connection.service.js";
import type { Scope } from "../modules/ai-connection/ai-connection.scopes.js";
import { hasScope } from "../shared/utils/scopes.js";
import type { McpSessionContext } from "./mcp.auth.js";

const issueStatusSchema = z.enum(["backlog", "todo", "in-progress", "review", "done"]);
const issuePrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
const issueTypeSchema = z.enum(["task", "bug", "issue"]);
const projectStatusSchema = z.enum(["ACTIVE", "ARCHIVED", "COMPLETED"]);
const visibilitySchema = z.enum(["PUBLIC", "PRIVATE"]);
const cycleStatusSchema = z.enum(["UPCOMING", "CURRENT", "COMPLETED"]);
const analyticsPeriodSchema = z.enum(["7d", "30d", "90d", "custom"]);

const toolDescriptions = new Map(
  getToolDefinitions().map((tool) => [tool.function.name, tool.function.description] as const),
);

const optionalString = () => z.string().trim().min(1).optional();
const limitSchema = z.number().int().min(1).max(100).optional();

type ToolInputShape = z.ZodRawShape;

type McpToolSpec = {
  name: string;
  inputSchema: ToolInputShape;
  readOnly?: boolean | undefined;
  scope: Scope;
};

export const MCP_TOOL_SPECS: McpToolSpec[] = [
  {
    name: "list_issues",
    scope: "issues:read",
    inputSchema: {
      status: issueStatusSchema.optional(),
      priority: issuePrioritySchema.optional(),
      type: issueTypeSchema.optional(),
      assigneeId: optionalString(),
      projectId: optionalString(),
      teamId: optionalString(),
      q: optionalString(),
      limit: limitSchema,
      sort: z.enum(["createdAt:desc", "updatedAt:desc", "priority:desc"]).optional(),
    },
    readOnly: true,
  },
  { name: "get_issue", scope: "issues:read", inputSchema: { issueId: z.string().trim().min(1) }, readOnly: true },
  {
    name: "create_issue",
    scope: "issues:write",
    inputSchema: {
      title: z.string().trim().min(1).max(500),
      type: issueTypeSchema,
      priority: issuePrioritySchema.optional(),
      description: optionalString(),
      projectId: z.string().trim().min(1),
      assigneeId: optionalString(),
      status: issueStatusSchema.optional(),
      dueDate: optionalString(),
    },
  },
  {
    name: "update_issue",
    scope: "issues:write",
    inputSchema: {
      issueId: z.string().trim().min(1),
      title: optionalString(),
      description: optionalString(),
      priority: issuePrioritySchema.optional(),
      status: issueStatusSchema.optional(),
      type: issueTypeSchema.optional(),
      dueDate: optionalString(),
    },
  },
  {
    name: "update_issue_status",
    scope: "issues:write",
    inputSchema: {
      issueId: z.string().trim().min(1),
      status: issueStatusSchema,
    },
  },
  {
    name: "assign_issue",
    scope: "issues:write",
    inputSchema: {
      issueId: z.string().trim().min(1),
      assigneeId: z.string().trim(),
    },
  },
  {
    name: "add_comment",
    scope: "issues:write",
    inputSchema: {
      issueId: z.string().trim().min(1),
      body: z.string().trim().min(1).max(50000),
    },
  },
  {
    name: "list_projects",
    scope: "projects:read",
    inputSchema: {
      status: projectStatusSchema.optional(),
      teamId: optionalString(),
      q: optionalString(),
      limit: limitSchema,
    },
    readOnly: true,
  },
  {
    name: "get_project_summary",
    scope: "projects:read",
    inputSchema: {
      projectId: z.string().trim().min(1),
    },
    readOnly: true,
  },
  {
    name: "create_project",
    scope: "projects:write",
    inputSchema: {
      name: z.string().trim().min(1).max(255),
      teamId: z.string().trim().min(1),
      description: optionalString(),
    },
  },
  {
    name: "update_project",
    scope: "projects:write",
    inputSchema: {
      projectId: z.string().trim().min(1),
      name: optionalString(),
      description: optionalString(),
      status: projectStatusSchema.optional(),
    },
  },
  { name: "list_teams", scope: "teams:read", inputSchema: { q: optionalString() }, readOnly: true },
  {
    name: "create_team",
    scope: "teams:write",
    inputSchema: {
      name: z.string().trim().min(1).max(255),
      leadId: z.string().trim().min(1),
      departmentId: optionalString(),
      description: optionalString(),
      visibility: visibilitySchema.optional(),
      memberIdsJson: optionalString(),
    },
  },
  {
    name: "update_team",
    scope: "teams:write",
    inputSchema: {
      teamId: z.string().trim().min(1),
      name: optionalString(),
      leadId: optionalString(),
      departmentId: z.string().trim().optional(),
      description: z.string().trim().optional(),
      visibility: visibilitySchema.optional(),
    },
  },
  {
    name: "get_team_workload",
    scope: "teams:read",
    inputSchema: { teamId: optionalString() },
    readOnly: true,
  },
  { name: "list_departments", scope: "departments:read", inputSchema: { q: optionalString() }, readOnly: true },
  {
    name: "create_department",
    scope: "departments:write",
    inputSchema: {
      name: z.string().trim().min(1).max(255),
      headId: optionalString(),
      description: optionalString(),
      color: optionalString(),
      visibility: visibilitySchema.optional(),
      isDefault: z.boolean().optional(),
      memberIdsJson: optionalString(),
    },
  },
  {
    name: "update_department",
    scope: "departments:write",
    inputSchema: {
      departmentId: z.string().trim().min(1),
      name: optionalString(),
      headId: z.string().trim().optional(),
      description: z.string().trim().optional(),
      color: z.string().trim().optional(),
      visibility: visibilitySchema.optional(),
      isDefault: z.boolean().optional(),
    },
  },
  {
    name: "list_cycles",
    scope: "cycles:read",
    inputSchema: {
      teamId: optionalString(),
      status: cycleStatusSchema.optional(),
    },
    readOnly: true,
  },
  { name: "list_members", scope: "members:read", inputSchema: { q: optionalString() }, readOnly: true },
  {
    name: "search_issues",
    scope: "issues:read",
    inputSchema: {
      query: z.string().trim().min(1),
      limit: limitSchema,
    },
    readOnly: true,
  },
  {
    name: "create_cycle",
    scope: "cycles:write",
    inputSchema: {
      teamId: z.string().trim().min(1),
      name: z.string().trim().min(1).max(255),
      description: optionalString(),
      goal: optionalString(),
      startsAt: z.string().trim().min(1),
      endsAt: z.string().trim().min(1),
      status: cycleStatusSchema.optional(),
    },
  },
  {
    name: "update_cycle",
    scope: "cycles:write",
    inputSchema: {
      cycleId: z.string().trim().min(1),
      name: optionalString(),
      description: z.string().trim().optional(),
      goal: z.string().trim().optional(),
      startsAt: optionalString(),
      endsAt: optionalString(),
      status: cycleStatusSchema.optional(),
    },
  },
  {
    name: "get_workspace_analytics",
    scope: "analytics:read",
    inputSchema: {
      period: analyticsPeriodSchema.optional(),
      from: optionalString(),
      to: optionalString(),
    },
    readOnly: true,
  },
  {
    name: "get_project_analytics",
    scope: "analytics:read",
    inputSchema: {
      projectId: z.string().trim().min(1),
      period: analyticsPeriodSchema.optional(),
      from: optionalString(),
      to: optionalString(),
    },
    readOnly: true,
  },
  {
    name: "get_team_analytics",
    scope: "analytics:read",
    inputSchema: {
      teamId: z.string().trim().min(1),
      period: analyticsPeriodSchema.optional(),
      from: optionalString(),
      to: optionalString(),
    },
    readOnly: true,
  },
  {
    name: "get_member_analytics",
    scope: "analytics:read",
    inputSchema: {
      memberId: z.string().trim().min(1),
      period: analyticsPeriodSchema.optional(),
      from: optionalString(),
      to: optionalString(),
    },
    readOnly: true,
  },
  {
    name: "get_cycle_analytics",
    scope: "analytics:read",
    inputSchema: {
      cycleId: z.string().trim().min(1),
      period: analyticsPeriodSchema.optional(),
      from: optionalString(),
      to: optionalString(),
    },
    readOnly: true,
  },
];

function summarizeResult(toolName: string, result: ExecutorResult) {
  return JSON.stringify(
    {
      tool: toolName,
      success: result.success,
      payload: result.payload,
      warnings: result.warnings,
      nextSuggestions: result.nextSuggestions,
      ...(result.error ? { error: result.error } : {}),
    },
    null,
    2,
  );
}

function toStructuredContent(result: ExecutorResult) {
  if (result.payload && typeof result.payload === "object") {
    return {
      payload: result.payload,
      warnings: result.warnings,
      nextSuggestions: result.nextSuggestions,
      ...(result.meta ? { meta: result.meta } : {}),
    };
  }

  return {
    payload: result.payload,
    warnings: result.warnings,
    nextSuggestions: result.nextSuggestions,
    ...(result.meta ? { meta: result.meta } : {}),
  };
}

export function registerMcpTools(server: McpServer, session: McpSessionContext) {
  for (const spec of MCP_TOOL_SPECS) {
    const config = {
      description: toolDescriptions.get(spec.name) ?? `${spec.name} via Trussen`,
      inputSchema: spec.inputSchema,
      ...(spec.readOnly ? { annotations: { readOnlyHint: true } } : {}),
    };

    server.registerTool(
      spec.name,
      config,
      async (args) => {
        if (session.pendingSetupUrl) {
          throw new UrlElicitationRequiredError([
            {
              mode: "url",
              message: "Finish connecting this AI client to a Trussen workspace to use its tools.",
              url: session.pendingSetupUrl,
              elicitationId: randomUUID(),
            },
          ]);
        }

        if (!hasScope(session.scopes, spec.scope)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Permission denied: this connection does not have the "${spec.scope}" scope required for ${spec.name}.`,
              },
            ],
            isError: true,
          };
        }

        const result = await executeTool(
          spec.name,
          args,
          {
            workspaceId: session.workspaceId,
            userId: session.userId,
            userRole: session.userRole,
          },
        );

        if (!result.success) {
          if (session.sessionId) {
            await recordAiConnectionSessionStep({
              sessionId: session.sessionId,
              toolName: spec.name,
              success: false,
              errorMessage: result.error ?? "Tool execution failed",
            });
          }

          logAiError("mcp_tool_failed", {
            workspaceId: session.workspaceId,
            userId: session.userId,
            feature: "mcp",
            toolName: spec.name,
            success: false,
            errorMessage: result.error ?? "Tool execution failed",
            metadata: {
              apiKeyId: session.apiKeyId,
              apiKeyName: session.apiKeyName,
              actorType: session.actorType,
              client: session.client,
              authMethod: session.authMethod,
              scopes: session.scopes,
              connectionId: session.connectionId,
              connectionLabel: session.connectionLabel,
            },
          });

          return {
            content: [{ type: "text", text: summarizeResult(spec.name, result) }],
            isError: true,
            structuredContent: toStructuredContent(result),
          };
        }

        if (session.sessionId) {
          await recordAiConnectionSessionStep({
            sessionId: session.sessionId,
            toolName: spec.name,
            success: true,
          });
        }

        logAiInfo("mcp_tool_executed", {
          workspaceId: session.workspaceId,
          userId: session.userId,
          feature: "mcp",
          toolName: spec.name,
          success: true,
          metadata: {
            apiKeyId: session.apiKeyId,
            apiKeyName: session.apiKeyName,
            actorType: session.actorType,
            client: session.client,
            authMethod: session.authMethod,
            scopes: session.scopes,
            connectionId: session.connectionId,
            connectionLabel: session.connectionLabel,
          },
        });

        return {
          content: [{ type: "text", text: summarizeResult(spec.name, result) }],
          structuredContent: toStructuredContent(result),
        };
      },
    );
  }
}
