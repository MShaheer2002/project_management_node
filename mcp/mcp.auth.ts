import type { Request } from "express";
import { getAuth } from "@clerk/express";
import { verifyClerkToken } from "@clerk/mcp-tools/server";
import { env } from "../config/env.js";
import { authenticateWithApiKey } from "../modules/api-key/api-key.service.js";
import {
  type AiConnectionLogicalSessionHint,
  completeAiConnectionSession,
  getAiConnectionByApiKeyId,
  resolveOAuthConnection,
  startAiConnectionSession,
} from "../modules/ai-connection/ai-connection.service.js";
import type { AiConnectionClientInput } from "../modules/ai-connection/ai-connection.schemas.js";
import { AiConnectionStatus } from "../app/generated/prisma/client.js";
import { AppError } from "../shared/utils/api-error.js";
import { ERROR_CODES } from "../shared/errors/error-codes.js";

export type McpSessionContext = {
  workspaceId: string;
  userId: string;
  userRole: string;
  apiKeyId: string | null;
  apiKeyName: string;
  actorType: "USER";
  client: AiConnectionClientInput;
  authMethod: "pat" | "oauth";
  scopes: string[];
  connectionId?: string | null;
  connectionLabel?: string | null;
  transport?: "http" | "stdio";
  sessionId?: string | null;
  oauthClientId?: string | null;
  /**
   * Set only for an OAuth-authenticated caller with no linked AiConnection
   * yet. workspaceId/userRole/scopes are placeholders on this session — every
   * tool call must check this field first and elicit setup instead of
   * touching them. See registerMcpTools in mcp.tools.ts.
   */
  pendingSetupUrl?: string | null;
};

export function toClientValue(input?: string | null): AiConnectionClientInput {
  switch (input) {
    case "CODEX":
      return "codex";
    case "CLAUDE_DESKTOP":
      return "claude_desktop";
    case "CLAUDE_CODE":
      return "claude_code";
    case "CHATGPT":
      return "chatgpt";
    case "GEMINI_CLI":
      return "gemini_cli";
    case "WINDSURF":
      return "windsurf";
    case "VSCODE":
      return "vscode";
    case "CURSOR":
      return "cursor";
    case "GENERIC_MCP":
    default:
      return "generic_mcp";
  }
}

async function toSessionContext(auth: Awaited<ReturnType<typeof authenticateWithApiKey>>): Promise<McpSessionContext> {
  const connection = await getAiConnectionByApiKeyId(auth.apiKey.id);
  if (!connection) {
    throw new AppError(
      401,
      ERROR_CODES.AI_CONNECTION_NOT_FOUND,
      "This token is not linked to an active Trussen AI connection.",
    );
  }

  if (connection.status === AiConnectionStatus.REVOKED) {
    throw new AppError(
      401,
      ERROR_CODES.AI_CONNECTION_REVOKED,
      "This Trussen AI connection has been revoked.",
    );
  }

  return {
    workspaceId: auth.workspace.id,
    userId: auth.user.id,
    userRole: auth.workspace.role,
    apiKeyId: auth.apiKey.id,
    apiKeyName: auth.apiKey.name,
    actorType: "USER",
    client: toClientValue(connection.client),
    authMethod: "pat",
    scopes: Array.isArray(connection.scopes) ? connection.scopes.filter((value): value is string => typeof value === "string") : ["mcp:v1"],
    connectionId: connection.id,
    connectionLabel: connection.label,
  };
}

function toLegacySessionContext(auth: Awaited<ReturnType<typeof authenticateWithApiKey>>): McpSessionContext {
  return {
    workspaceId: auth.workspace.id,
    userId: auth.user.id,
    userRole: auth.workspace.role,
    apiKeyId: auth.apiKey.id,
    apiKeyName: auth.apiKey.name,
    actorType: "USER",
    client: "generic_mcp",
    authMethod: "pat",
    scopes: ["mcp:v1"],
    connectionId: null,
    connectionLabel: auth.apiKey.name,
  };
}

function resolveMcpApiKey() {
  const rawKey = env.TRUSSEN_MCP_API_KEY ?? env.MCP_API_KEY;
  if (!rawKey) {
    throw new Error(
      "Missing MCP API key. Set TRUSSEN_MCP_API_KEY (preferred) or MCP_API_KEY before starting the MCP server.",
    );
  }

  return rawKey;
}

export async function authenticateMcpSession(): Promise<McpSessionContext> {
  const auth = await authenticateWithApiKey(resolveMcpApiKey());
  const connection = await getAiConnectionByApiKeyId(auth.apiKey.id);
  if (!connection) {
    // Keep local stdio and legacy dev workflows usable while remote HTTP MCP
    // requires explicit AI connection tokens.
    return toLegacySessionContext(auth);
  }

  const session = await toSessionContext(auth);
  if (!session.connectionId) {
    return session;
  }

  const started = await startAiConnectionSession({
    connectionId: session.connectionId,
    workspaceId: session.workspaceId,
    userId: session.userId,
    // This stdio path only ever runs off authenticateWithApiKey — always PAT.
    identity: { type: "pat", apiKeyId: session.apiKeyId! },
    client: session.client,
    transport: "stdio",
    scopes: session.scopes,
  });

  return {
    ...session,
    transport: "stdio",
    sessionId: started.id,
  };
}

export async function authenticateMcpBearerToken(rawKey: string): Promise<McpSessionContext> {
  const auth = await authenticateWithApiKey(rawKey);
  return await toSessionContext(auth);
}

/**
 * Verifies a Clerk-issued OAuth access token and resolves it to the
 * AiConnection it was linked to during the one-time setup step.
 *
 * When this (user, OAuth client) pair hasn't completed setup yet, this does
 * NOT throw — it returns a pending session with `pendingSetupUrl` set, so
 * the connection can still complete the MCP handshake (initialize/tools/list)
 * and elicit setup per-tool-call via UrlElicitationRequiredError, which
 * clients can surface directly instead of a bare transport-level failure.
 */
export async function authenticateMcpOAuthToken(req: Request, token: string): Promise<McpSessionContext> {
  const authData = getAuth(req, { acceptsToken: "oauth_token" });
  const authInfo = verifyClerkToken(authData, token);

  if (!authInfo) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "Invalid or expired OAuth token.");
  }

  const clerkUserId = authInfo.extra?.userId as string | undefined;
  const clientId = authInfo.clientId;
  if (!clerkUserId || !clientId) {
    throw new AppError(401, ERROR_CODES.UNAUTHORIZED, "OAuth token is missing required claims.");
  }

  const connection = await resolveOAuthConnection(clerkUserId, clientId);
  if (!connection) {
    const setupUrl = new URL("/connect-ai", env.FRONTEND_URL);
    setupUrl.searchParams.set("clientId", clientId);

    return {
      workspaceId: "",
      userId: clerkUserId,
      userRole: "",
      apiKeyId: null,
      apiKeyName: "",
      actorType: "USER",
      client: "generic_mcp",
      authMethod: "oauth",
      scopes: [],
      connectionId: null,
      oauthClientId: clientId,
      pendingSetupUrl: setupUrl.toString(),
    };
  }

  return {
    workspaceId: connection.workspaceId,
    userId: connection.userId,
    userRole: connection.userRole,
    apiKeyId: null,
    apiKeyName: connection.label,
    actorType: "USER",
    client: toClientValue(connection.client),
    authMethod: "oauth",
    scopes: Array.isArray(connection.scopes)
      ? connection.scopes.filter((value): value is string => typeof value === "string")
      : [],
    connectionId: connection.id,
    connectionLabel: connection.label,
    oauthClientId: clientId,
  };
}

export async function failMcpSession(context: McpSessionContext | null | undefined, input?: {
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  if (!context?.sessionId) return;
  await completeAiConnectionSession({
    sessionId: context.sessionId,
    status: "failed",
    ...(input?.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input?.errorMessage ? { errorMessage: input.errorMessage } : {}),
  });
}

export async function completeMcpSession(context: McpSessionContext | null | undefined) {
  if (!context?.sessionId) return;
  await completeAiConnectionSession({
    sessionId: context.sessionId,
    status: "succeeded",
  });
}

export function extractBearerToken(authorizationHeader?: string | null) {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new Error("Missing bearer token. Send Authorization: Bearer <Trussen AI connection token>.");
  }

  const token = authorizationHeader.slice(7).trim();
  if (!token) {
    throw new Error("Missing bearer token. Send Authorization: Bearer <Trussen AI connection token>.");
  }

  return token;
}

export function extractMcpAccessToken(input: {
  authorizationHeader?: string | null;
  query?: Record<string, unknown> | undefined;
}) {
  if (input.authorizationHeader?.startsWith("Bearer ")) {
    return extractBearerToken(input.authorizationHeader);
  }

  const queryToken =
    typeof input.query?.api_key === "string"
      ? input.query.api_key
      : typeof input.query?.token === "string"
        ? input.query.token
        : null;

  if (queryToken && queryToken.trim()) {
    return queryToken.trim();
  }

  throw new Error(
    "Missing MCP token. Send Authorization: Bearer <Trussen AI connection token> or use ?api_key=<token>.",
  );
}

export function extractMcpLogicalSessionHint(body: unknown): AiConnectionLogicalSessionHint {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  const payload = body as Record<string, unknown>;
  const params =
    payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
      ? payload.params as Record<string, unknown>
      : null;
  const clientInfo =
    params?.clientInfo && typeof params.clientInfo === "object" && !Array.isArray(params.clientInfo)
      ? params.clientInfo as Record<string, unknown>
      : null;
  const meta =
    params?._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
      ? params._meta as Record<string, unknown>
      : null;

  const providerSessionId =
    typeof meta?.["openai/session"] === "string" && meta["openai/session"].trim()
      ? meta["openai/session"].trim()
      : null;
  const providerSubject =
    typeof meta?.["openai/subject"] === "string" && meta["openai/subject"].trim()
      ? meta["openai/subject"].trim()
      : null;
  const clientName =
    typeof clientInfo?.name === "string" && clientInfo.name.trim()
      ? clientInfo.name.trim()
      : null;
  const clientVersion =
    typeof clientInfo?.version === "string" && clientInfo.version.trim()
      ? clientInfo.version.trim()
      : null;

  return {
    ...(providerSessionId ? { providerSessionId, sessionKey: `openai:${providerSessionId}` } : {}),
    ...(!providerSessionId && providerSubject ? { sessionKey: `openai-subject:${providerSubject}` } : {}),
    ...(clientName ? { clientName } : {}),
    ...(clientVersion ? { clientVersion } : {}),
  };
}
