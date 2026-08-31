import { Router, type Request } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppError } from "../shared/utils/api-error.js";
import { ERROR_CODES } from "../shared/errors/error-codes.js";
import { isApiKeyToken } from "../shared/middleware/authenticate-api-key.js";
import { resolveAiConnectionHttpSession } from "../modules/ai-connection/ai-connection.service.js";
import { createMcpServerForSession } from "./mcp.server-factory.js";
import {
  authenticateMcpBearerToken,
  authenticateMcpOAuthToken,
  extractMcpAccessToken,
  extractMcpLogicalSessionHint,
  failMcpSession,
} from "./mcp.auth.js";

const router = Router();

// Matches @clerk/mcp-tools' own (unexported) getPRMUrl exactly, so discovery
// lands on the same /.well-known/oauth-protected-resource/mcp route already
// mounted in app.ts.
function getProtectedResourceMetadataUrl(req: Request) {
  return `${req.protocol}://${req.get("host")}/.well-known/oauth-protected-resource${req.originalUrl}`;
}

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
      session = isApiKeyToken(token)
        ? await authenticateMcpBearerToken(token)
        : await authenticateMcpOAuthToken(req, token);
    } catch (error) {
      throw error instanceof AppError
        ? error
        : new AppError(
            401,
            ERROR_CODES.UNAUTHORIZED,
            error instanceof Error ? error.message : "MCP authentication failed",
        );
    }

    if (!session.connectionId && !session.pendingSetupUrl) {
      throw new AppError(
        401,
        ERROR_CODES.AI_CONNECTION_NOT_FOUND,
        "This token is not linked to an active Trussen AI connection.",
      );
    }

    // Pending OAuth sessions (setup not completed yet) have no real
    // AiConnection to track — let the MCP handshake through as-is and let
    // registerMcpTools elicit setup on the first actual tool call.
    if (session.connectionId) {
      const sessionRecord = await resolveAiConnectionHttpSession({
        connectionId: session.connectionId,
        workspaceId: session.workspaceId,
        userId: session.userId,
        identity:
          session.authMethod === "oauth"
            ? { type: "oauth", oauthClientId: session.oauthClientId! }
            : { type: "pat", apiKeyId: session.apiKeyId! },
        client: session.client,
        scopes: session.scopes,
        hint: extractMcpLogicalSessionHint(req.body),
      });

      session = {
        ...session,
        transport: "http",
        sessionId: sessionRecord.id,
      };
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
    await failMcpSession(session, {
      errorCode: error instanceof AppError ? error.code : ERROR_CODES.INTERNAL_ERROR,
      errorMessage: error instanceof Error ? error.message : "MCP request failed",
    });
    await closeServer();

    // MCP clients discover OAuth by seeing this header on a 401 and fetching
    // the URL it names — mirrors what @clerk/mcp-tools' own auth middleware
    // does, which our custom dual PAT/OAuth dispatch above bypasses.
    if (error instanceof AppError && error.statusCode === 401) {
      res.set("WWW-Authenticate", `Bearer resource_metadata=${getProtectedResourceMetadataUrl(req)}`);
    }

    if (error instanceof AppError) {
      return next(error);
    }
    return next(error);
  }
});

export default router;
