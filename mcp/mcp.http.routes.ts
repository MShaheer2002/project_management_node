import { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppError } from "../shared/utils/api-error.js";
import { ERROR_CODES } from "../shared/errors/error-codes.js";
import { createMcpServerForSession } from "./mcp.server-factory.js";
import { authenticateMcpBearerToken, extractMcpAccessToken } from "./mcp.auth.js";

const router = Router();

router.all("/", async (req, res, next) => {
  let transport: StreamableHTTPServerTransport | null = null;
  let serverClosed = false;
  let server: McpServer | null = null;

  const closeServer = async () => {
    if (serverClosed) return;
    serverClosed = true;
    await Promise.allSettled([transport?.close(), server?.close()]);
  };

  try {
    let session: Awaited<ReturnType<typeof authenticateMcpBearerToken>>;
    try {
      const token = extractMcpAccessToken({
        authorizationHeader: req.headers.authorization ?? null,
        query: req.query as Record<string, unknown>,
      });
      session = await authenticateMcpBearerToken(token);
    } catch (error) {
      throw error instanceof AppError
        ? error
        : new AppError(
            401,
            ERROR_CODES.UNAUTHORIZED,
            error instanceof Error ? error.message : "MCP authentication failed",
          );
    }

    server = createMcpServerForSession(session);
    // The SDK supports stateless Streamable HTTP by omitting session generation,
    // but its exact TS types are narrower than the documented runtime behavior.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    } as any);

    await server.connect(transport as any);
    await transport.handleRequest(req, res, req.body);
    await closeServer();
  } catch (error) {
    await closeServer();

    if (error instanceof AppError) {
      return next(error);
    }
    return next(error);
  }
});

export default router;
