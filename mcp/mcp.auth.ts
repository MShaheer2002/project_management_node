import { env } from "../config/env.js";
import { authenticateWithApiKey } from "../modules/api-key/api-key.service.js";

export type McpSessionContext = {
  workspaceId: string;
  userId: string;
  userRole: string;
  apiKeyId: string;
  apiKeyName: string;
};

function toSessionContext(auth: Awaited<ReturnType<typeof authenticateWithApiKey>>): McpSessionContext {
  return {
    workspaceId: auth.workspace.id,
    userId: auth.user.id,
    userRole: auth.workspace.role,
    apiKeyId: auth.apiKey.id,
    apiKeyName: auth.apiKey.name,
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
  return toSessionContext(auth);
}

export async function authenticateMcpBearerToken(rawKey: string): Promise<McpSessionContext> {
  const auth = await authenticateWithApiKey(rawKey);
  return toSessionContext(auth);
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
