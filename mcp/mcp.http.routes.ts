import { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppError } from "../shared/utils/api-error.js";
import { ERROR_CODES } from "../shared/errors/error-codes.js";
import { resolveAiConnectionHttpSession } from "../modules/ai-connection/ai-connection.service.js";
import { createMcpServerForSession } from "./mcp.server-factory.js";
import {
  authenticateMcpBearerToken,
  extractMcpAccessToken,
  extractMcpLogicalSessionHint,
  failMcpSession,
} from "./mcp.auth.js";

const router = Router();

router.all("/", async (req, res, next) => {
  let transport: StreamableHTTPServerTransport | null = null;
  let serverClosed = false;
  let server: McpServer | null = null;
  let session: Awaited<ReturnType<typeof authenticateMcpBearerToken>> | null = null;

  const closeServer = async () => {
    if (serverClosed) return;
    serverClosed = true;
    await Promise.allSettled([transport?.close(), server?.close()]);
  };

  try {
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

    if (!session.connectionId) {
      throw new AppError(
        401,
        ERROR_CODES.AI_CONNECTION_NOT_FOUND,
        "This token is not linked to an active Trussen AI connection.",
      );
    }

    const sessionRecord = await resolveAiConnectionHttpSession({
      connectionId: session.connectionId,
      workspaceId: session.workspaceId,
      userId: session.userId,
      apiKeyId: session.apiKeyId,
      client: session.client,
      scopes: session.scopes,
      hint: extractMcpLogicalSessionHint(req.body),
    });

    session = {
      ...session,
      transport: "http",
      sessionId: sessionRecord.id,
    };

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
    await failMcpSession(session, {
      errorCode: error instanceof AppError ? error.code : ERROR_CODES.INTERNAL_ERROR,
      errorMessage: error instanceof Error ? error.message : "MCP request failed",
    });
    await closeServer();

    if (error instanceof AppError) {
      return next(error);
    }
    return next(error);
  }
});

export default router;
