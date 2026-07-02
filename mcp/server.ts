import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { authenticateMcpSession, completeMcpSession, failMcpSession } from "./mcp.auth.js";
import { createMcpServerForSession } from "./mcp.server-factory.js";

async function main() {
  const session = await authenticateMcpSession();
  const server: McpServer = createMcpServerForSession(session);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[Trussen MCP] Connected on stdio for workspace ${session.workspaceId} as user ${session.userId}.`,
  );

  const shutdown = async () => {
    await completeMcpSession(session);
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error) => {
  void failMcpSession(null, {
    errorMessage: error instanceof Error ? error.message : "MCP server startup failed",
  });
  console.error("[Trussen MCP] Failed to start:", error);
  process.exit(1);
});
