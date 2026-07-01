import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { env } from "../config/env.js";
import { registerMcpResources } from "./mcp.resources.js";
import { registerMcpTools } from "./mcp.tools.js";
import type { McpSessionContext } from "./mcp.auth.js";

export function createMcpServerForSession(session: McpSessionContext) {
  const server = new McpServer({
    name: env.TRUSSEN_MCP_SERVER_NAME,
    version: env.TRUSSEN_MCP_SERVER_VERSION,
  });

  registerMcpTools(server, session);
  registerMcpResources(server, session);

  return server;
}
