import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getToolDefinitions } from "../modules/ai/tools/tool-definitions.js";
import { executeTool } from "../modules/ai/tools/tool-executor.js";
import type { ExecutorResult } from "../modules/ai/ai.planner.js";
import { logAiError, logAiInfo } from "../modules/ai/ai.observability.js";
import { recordAiConnectionSessionStep } from "../modules/ai-connection/ai-connection.service.js";
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
};

export const V1_MCP_TOOL_NAMES = [
  "list_issues",
  "get_issue",
  "create_issue",
  "update_issue_status",
  "assign_issue",
  "add_comment",
  "list_projects",
  "list_cycles",
  "list_members",
  "search_issues",
] as const;

const MCP_TOOL_SPECS: McpToolSpec[] = [
  {
    name: "list_issues",
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
  { name: "get_issue", inputSchema: { issueId: z.string().trim().min(1) }, readOnly: true },
  {
    name: "create_issue",
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
    inputSchema: {
      issueId: z.string().trim().min(1),
      status: issueStatusSchema,
    },
  },
  {
    name: "assign_issue",
    inputSchema: {
      issueId: z.string().trim().min(1),
      assigneeId: z.string().trim(),
    },
  },
  {
    name: "add_comment",
    inputSchema: {
      issueId: z.string().trim().min(1),
      body: z.string().trim().min(1).max(50000),
    },
  },
  {
    name: "list_projects",
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
    inputSchema: {
      projectId: z.string().trim().min(1),
    },
    readOnly: true,
  },
  {
    name: "create_project",
    inputSchema: {
      name: z.string().trim().min(1).max(255),
      teamId: z.string().trim().min(1),
      description: optionalString(),
    },
  },
  {
    name: "update_project",
    inputSchema: {
      projectId: z.string().trim().min(1),
      name: optionalString(),
      description: optionalString(),
      status: projectStatusSchema.optional(),
    },
  },
  { name: "list_teams", inputSchema: { q: optionalString() }, readOnly: true },
  {
    name: "create_team",
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
    inputSchema: { teamId: optionalString() },
    readOnly: true,
  },
  { name: "list_departments", inputSchema: { q: optionalString() }, readOnly: true },
  {
    name: "create_department",
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
    inputSchema: {
      teamId: optionalString(),
      status: cycleStatusSchema.optional(),
    },
    readOnly: true,
  },
  { name: "list_members", inputSchema: { q: optionalString() }, readOnly: true },
  {
    name: "search_issues",
    inputSchema: {
      query: z.string().trim().min(1),
      limit: limitSchema,
    },
    readOnly: true,
  },
  {
    name: "create_cycle",
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
    inputSchema: {
      period: analyticsPeriodSchema.optional(),
      from: optionalString(),
      to: optionalString(),
    },
    readOnly: true,
  },
  {
    name: "get_project_analytics",
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
    inputSchema: {
      cycleId: z.string().trim().min(1),
      period: analyticsPeriodSchema.optional(),
      from: optionalString(),
      to: optionalString(),
    },
    readOnly: true,
  },
];

const ALLOWED_MCP_TOOL_NAME_SET = new Set<string>(V1_MCP_TOOL_NAMES);

export const V1_MCP_TOOL_SPECS = MCP_TOOL_SPECS.filter((spec) => ALLOWED_MCP_TOOL_NAME_SET.has(spec.name));

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
  for (const spec of V1_MCP_TOOL_SPECS) {
    const config = {
      description: toolDescriptions.get(spec.name) ?? `${spec.name} via Trussen`,
      inputSchema: spec.inputSchema,
      ...(spec.readOnly ? { annotations: { readOnlyHint: true } } : {}),
    };

    server.registerTool(
      spec.name,
      config,
      async (args) => {
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
